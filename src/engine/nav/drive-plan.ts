import { Vector3 } from 'three';

import { wrapAngle } from '@/engine/core/math';
import {
  bodyOffsets,
  type VehicleParams,
} from '@/engine/physics/vehicle-params';

import {
  type DriveGoal,
  type DriveGoals,
  type DriveGround,
  type DrivePose,
  DriveSearch,
} from './drive-search';
import { Polyline } from './polyline';
import { ROUTE_EPS, type RoutePoint, type RouteShaper } from './route-shaper';

/** Guide bounds in world coordinates: x0, z0, x1, z1. */
export type DriveBounds = readonly [number, number, number, number];

export interface DriveTerrain {
  readonly ground: DriveGround;
  /**
   * Follow a surface near the previous height, without requiring vehicle
   * clearance.
   */
  heightAt(x: number, y: number, z: number): number | null;
  /** Build a remaining-cost estimate for these bounds and destination poses. */
  guide(bounds: DriveBounds, goals: DriveGoals): DriveGround['toGo'];
}

export interface DriveRequest {
  readonly vehicle: VehicleParams;
  readonly from: DrivePose;
  readonly goals: DriveGoals;
}

/**
 * Search window distances before and after an invalid route section, in
 * turning radii.
 */
const WINDOW_BACK = 2;
const WINDOW_AHEAD = 0.8;
/** Merge search windows separated by at most this many turning radii. */
const WINDOW_GAP = 1;
/** Margin around sampled route sections for the drive-search guide, in meters. */
const WINDOW_MARGIN = 12;
const BOX_STEP = 1;
/**
 * Window endpoint adjustment step and minimum entry distance from corners, in
 * meters.
 */
const WINDOW_NUDGE = 0.5;
const CORNER_CLEAR = 0.3;
/**
 * Heading difference in radians that requires a drive-search window at the
 * start.
 */
const START_SLACK = 0.35;
/**
 * Try rejoining the following straight at REJOIN_STEP turning-radius
 * intervals, up to REJOIN_REACH radii ahead. Leave REJOIN_SPARE meters before
 * the next turn.
 */
const REJOIN_REACH = 3;
const REJOIN_STEP = 0.5;
const REJOIN_SPARE = 0.5;
/**
 * Maximum passes that validate ordinary route sections and add drive-search
 * windows.
 */
const LAYOUT_PASSES = 6;
/**
 * Distance between vehicle fit checks along ordinary route sections, in
 * meters.
 */
const CHECK_STEP = 0.5;

/** A route section whose vehicle poses must be found by DriveSearch. */
interface DriveWindow {
  from: DrivePose;
  goals: DriveGoals;
  /** Guide bounds in world coordinates: x0, z0, x1, z1. */
  box: [number, number, number, number];
  /** Route arc length at the first goal, in meters. */
  until: number;
  /**
   * Whether either boundary lies inside the route rather than at a requested
   * endpoint.
   */
  midway: { start: boolean; end: boolean };
  search: DriveSearch | null;
  poses: DrivePose[] | null;
}

/** An ordinary route section or a window requiring vehicle pose search. */
type DrivePiece = { pts: RoutePoint[] } | { window: DriveWindow };

const _f = new Vector3();
const _g = new Vector3();

/**
 * Plan vehicle maneuvers between valid route sections, then join their forward
 * and reverse travel.
 */
export class DrivePlan {
  private readonly pieces: DrivePiece[];
  private route: RoutePoint[] | null = null;
  expanded = 0;
  drivable = true;
  layout: string[] = [];

  constructor(
    line: readonly Vector3[],
    private readonly shape: RouteShaper,
    private readonly terrain: DriveTerrain,
    private readonly request: DriveRequest,
  ) {
    this.pieces = this.partition(line);
  }

  /**
   * Search each drive window within the deadline, then assemble the route.
   * Replace failed windows with straight fallback segments and mark the plan
   * as not drivable. Return null while a search is still running.
   */
  advance(deadline: number): RoutePoint[] | null {
    if (this.route) {
      return this.route;
    }

    for (const piece of this.pieces) {
      if (!('window' in piece)) {
        continue;
      }

      const w = piece.window;
      if (w.poses || w.search?.status === 'failed') {
        continue;
      }

      w.search ??= this.search(w);
      const before = w.search.expanded;
      const status = w.search.run(deadline);
      this.expanded += w.search.expanded - before;

      if (status === 'running') {
        return null;
      }

      if (status === 'done') {
        w.poses = w.search.poses;
      }
    }

    const at = (q: { x: number; y: number; z: number }): string =>
      `(${q.x.toFixed(1)},${q.y.toFixed(1)},${q.z.toFixed(1)})`;
    this.layout = this.pieces.map((piece) => {
      if ('pts' in piece) {
        return `plain ${at((piece.pts[0] as RoutePoint).p)}..${at((piece.pts[piece.pts.length - 1] as RoutePoint).p)}`;
      }

      const w = piece.window;
      const r = w.goals[w.search?.reached ?? -1];
      return `window ${at(w.from)}->${r ? at(r) : 'none'} ${w.search?.status} after ${w.search?.expanded} expansions`;
    });
    const route: RoutePoint[] = [];
    let ended: DriveGoal | null = null;
    for (const piece of this.pieces) {
      if ('pts' in piece) {
        // Resume from the rejoin goal selected by the preceding window.
        route.push(
          ...(ended
            ? [
                { p: new Vector3(ended.x, ended.y, ended.z), reverse: false },
                ...piece.pts.slice(1),
              ]
            : piece.pts),
        );
        ended = null;
        continue;
      }

      const w = piece.window;
      ended = w.poses && w.search ? (w.goals[w.search.reached] ?? null) : null;

      if (w.poses) {
        route.push(
          ...w.poses.map((q) => ({
            p: new Vector3(q.x, q.y, q.z),
            reverse: q.reverse,
          })),
        );
      } else {
        // Preserve guidance through failed windows, but report that the route is not drivable.
        this.drivable = false;
        const g = w.goals[0];
        route.push(
          { p: new Vector3(w.from.x, w.from.y, w.from.z), reverse: false },
          { p: new Vector3(g.x, g.y, g.z), reverse: false },
        );
      }
    }

    this.route = route;
    return route;
  }

  /**
   * Partition the route into validated lines and arcs plus windows requiring
   * vehicle pose searches, following Pinter, "Toward More Realistic
   * Pathfinding". Always search the destination approach and search the
   * departure when its heading differs. Expand and merge windows to find
   * usable boundary poses, up to LAYOUT_PASSES passes.
   */
  private partition(line: readonly Vector3[]): DrivePiece[] {
    const { vehicle, from, goals: destinations } = this.request;
    const R = this.shape.radius;
    const route = new Polyline(line);
    const L = route.total;
    const at = route.distances;

    const ground = this.terrain.ground;
    const body = bodyOffsets(vehicle);
    // Follow surface heights incrementally so interpolation across ramps cannot select the wrong floor.
    const floor: number[] = [];
    for (let s = 0, y = from.y; s <= L + CHECK_STEP; s += CHECK_STEP) {
      route.sample(Math.min(s, L), _f);
      y = this.terrain.heightAt(_f.x, y, _f.z) ?? _f.y;
      floor.push(y);
    }

    const floorAt = (s: number): number =>
      floor[
        Math.min(floor.length - 1, Math.round(Math.max(0, s) / CHECK_STEP))
      ] as number;
    const fitsAt = (x: number, y: number, z: number, yaw: number): boolean =>
      body.every(
        (o) =>
          ground.fits(x + Math.sin(yaw) * o, y, z + Math.cos(yaw) * o, yaw) !==
          null,
      );
    const poseAt = (s: number): DrivePose => {
      route.sample(s, _f, _g);
      return {
        x: _f.x,
        y: floorAt(s),
        z: _f.z,
        yaw: Math.atan2(_g.x, _g.z),
        reverse: false,
      };
    };

    const fitsAtS = (s: number): boolean => {
      const q = poseAt(s);
      return fitsAt(q.x, q.y, q.z, q.yaw);
    };

    const trouble = (s: number): [number, number] => [
      s - R * WINDOW_BACK,
      s + R * WINDOW_AHEAD,
    ];

    let spans: [number, number][] = [[L - R * WINDOW_BACK, L]];
    route.sample(0, _f, _g);

    if (Math.abs(wrapAngle(from.yaw - Math.atan2(_g.x, _g.z))) > START_SLACK) {
      spans.push([0, R * WINDOW_AHEAD]);
    }

    let pieces: DrivePiece[] = [];
    for (let pass = 0; pass < LAYOUT_PASSES; pass++) {
      // Expand boundaries until the vehicle fits; keep entries away from corners and merge nearby windows.
      for (const sp of spans) {
        sp[0] = Math.max(0, sp[0]);
        sp[1] = Math.min(L, sp[1]);

        while (
          sp[0] > 0 &&
          (at.some((a) => Math.abs(a - sp[0]) < CORNER_CLEAR) ||
            !fitsAtS(sp[0]))
        ) {
          sp[0] = Math.max(0, sp[0] - WINDOW_NUDGE);
        }

        while (sp[1] < L && !fitsAtS(sp[1])) {
          sp[1] = Math.min(L, sp[1] + WINDOW_NUDGE);
        }
      }

      spans.sort((a, b) => a[0] - b[0]);
      const merged: [number, number][] = [];
      for (const sp of spans) {
        const last = merged[merged.length - 1];
        if (last && sp[0] <= last[1] + R * WINDOW_GAP) {
          last[1] = Math.max(last[1], sp[1]);
        } else {
          merged.push([sp[0], sp[1]]);
        }
      }

      spans = merged;
      // Validate the ordinary route sections between windows.
      pieces = [];
      const found: number[] = [];
      let s = 0;
      for (const [s0, s1] of [...spans, [L, L] as [number, number]]) {
        if (s0 > s + ROUTE_EPS) {
          const pts = [
            poseAt(s),
            ...line.filter(
              (_, k) =>
                (at[k] ?? 0) > s + ROUTE_EPS && (at[k] ?? 0) < s0 - ROUTE_EPS,
            ),
            poseAt(s0),
          ].map((q) => new Vector3(q.x, q.y, q.z));
          if (s === 0) {
            pts[0] = new Vector3(from.x, from.y, from.z);
          }

          const failed: number[] = [];
          const plain = this.shape.corners(pts, failed);
          for (const k of failed) {
            found.push(route.project(pts[k] as Vector3, s, s0 - s));
          }

          const check = new Polyline(plain.map((r) => r.p));
          for (
            let c = CHECK_STEP, y = floorAt(s);
            c < check.total;
            c += CHECK_STEP
          ) {
            check.sample(c, _f, _g);
            const h = this.terrain.heightAt(_f.x, y, _f.z);
            y = h ?? y;

            if (h === null || !fitsAt(_f.x, y, _f.z, Math.atan2(_g.x, _g.z))) {
              found.push(route.project(_f.setY(y), s, s0 - s));
              c += R; // Space failure reports by one turning radius.
            }
          }

          pieces.push({ pts: plain });
        }

        if (s1 > s0) {
          const entry = s0 <= 0 ? { ...from, reverse: false } : poseAt(s0);
          const goals: DriveGoals =
            s1 >= L ? destinations : [{ ...poseAt(s1), rest: 0 }];
          // Include maneuvering space around the route in the guide bounds.
          const box: [number, number, number, number] = [
            Infinity,
            Infinity,
            -Infinity,
            -Infinity,
          ];
          for (let c = s0; c <= s1 + BOX_STEP; c += BOX_STEP) {
            route.sample(Math.min(c, s1), _f);
            box[0] = Math.min(box[0], _f.x - WINDOW_MARGIN);
            box[1] = Math.min(box[1], _f.z - WINDOW_MARGIN);
            box[2] = Math.max(box[2], _f.x + WINDOW_MARGIN);
            box[3] = Math.max(box[3], _f.z + WINDOW_MARGIN);
          }

          pieces.push({
            window: {
              from: entry,
              goals,
              box,
              until: s1,
              midway: { start: s0 > 0, end: s1 < L },
              search: null,
              poses: null,
            },
          });
        }

        s = s1;
      }

      if (!found.length) {
        break;
      }

      for (const f of found) {
        spans.push(trouble(f));
      }
    }

    // Offer later rejoin points on the next straight section to allow a wider maneuver.
    for (let k = 0; k + 1 < pieces.length; k++) {
      const a = pieces[k] as DrivePiece;
      const b = pieces[k + 1] as DrivePiece;
      if (!('window' in a) || !('pts' in b) || b.pts.length < 2) {
        continue;
      }

      const g0 = a.window.goals[0];
      const p0 = (b.pts[0] as RoutePoint).p;
      const p1 = (b.pts[1] as RoutePoint).p;
      const straight = Math.hypot(p1.x - p0.x, p1.z - p0.z) - REJOIN_SPARE;
      const ux = (p1.x - p0.x) / (straight + REJOIN_SPARE);
      const uz = (p1.z - p0.z) / (straight + REJOIN_SPARE);
      const reach = Math.min(straight, R * REJOIN_REACH);
      // Stop adding rejoin goals at the first pose that cannot fit.
      const goals: [DriveGoal, ...DriveGoal[]] = [
        {
          x: g0.x,
          y: floorAt(a.window.until),
          z: g0.z,
          yaw: g0.yaw,
          reverse: false,
          rest: 0,
        },
      ];
      let last = goals[0];
      for (let t = R * REJOIN_STEP; t <= reach; t += R * REJOIN_STEP) {
        const x = g0.x + ux * t;
        const z = g0.z + uz * t;
        const y = floorAt(a.window.until + t);
        if (!fitsAt(x, y, z, g0.yaw)) {
          break;
        }

        last = { x, y, z, yaw: g0.yaw, reverse: false, rest: 0 };
        goals.push(last);
      }

      // Include the remaining straight-line cost when comparing rejoin goals.
      for (const q of goals) {
        q.rest =
          Math.hypot(last.x - q.x, last.z - q.z) *
          ground.cost(q.x, q.y, q.z, q.yaw);
      }

      a.window.goals = goals;
    }

    return pieces;
  }

  private search(w: DriveWindow): DriveSearch {
    const box: [number, number, number, number] = [...w.box];
    for (const q of w.goals) {
      box[0] = Math.min(box[0], q.x - WINDOW_MARGIN);
      box[1] = Math.min(box[1], q.z - WINDOW_MARGIN);
      box[2] = Math.max(box[2], q.x + WINDOW_MARGIN);
      box[3] = Math.max(box[3], q.z + WINDOW_MARGIN);
    }

    return new DriveSearch(
      { ...this.terrain.ground, toGo: this.terrain.guide(box, w.goals) },
      this.request.vehicle,
      w.from,
      w.goals,
      w.midway,
    );
  }
}
