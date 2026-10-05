import { Vector3 } from 'three';

import { TUNING } from '@/config';
import { clamp, TAU, wrapAngle } from '@/engine/core/math';
import { MinHeap } from '@/engine/core/min-heap';
import type { Rng } from '@/engine/core/rng';
import {
  type DriveGoal,
  type DriveGoals,
  type DriveGround,
  type DrivePose,
  DriveSearch,
} from '@/engine/nav/drive-search';
import { Polyline } from '@/engine/nav/polyline';
import type { CollisionWorld, Solid } from '@/engine/physics/collision';
import { bodyOffsets, type VehicleParams } from '@/engine/physics/vehicle-params';

import { landingPoint } from './elevator-shaft';
import type { Elevators } from './elevators';
import type { ElevatorDef, LevelData, V3, ZoneDef } from './level-data';

/** Clearance requirements and movement costs used to plan routes for an actor. */
export interface NavProfile {
  readonly name: string;
  /** Minimum horizontal clearance from walls and drop-offs, in meters. */
  readonly radius: number;
  /** Required headroom above a surface, in meters. */
  readonly height: number;
  /** Maximum height change between neighboring cells, in meters. */
  readonly stepUp: number;
  /** Movement cost multiplier outside roads, asphalt overlays, decks and ramps. */
  readonly offRoad: number;
  /** Street-level movement cost multiplier, used when offRoad is 1. */
  readonly onStreet: number;
  /** Apply directional cost multipliers from the traffic lane field. */
  readonly lanes: boolean;
  /** Preferred clearance in meters. Walls and drops closer than this increase movement cost. */
  readonly roomy: number;
  /** Maximum wall cost multiplier added at minimum clearance; it falls to zero at roomy. */
  readonly wallCost: number;
  /** Vehicle dimensions and steering limits used to shape the route. */
  readonly vehicle?: VehicleParams;
}

/** Additional clearance beyond the collision radius and height, in meters. */
const MARGIN = 0.1;
/** Additional turning radius in meters, leaving steering range for route corrections. */
const TURN_SLACK = 1.2;

const bodies = new Map<string, NavProfile>();

/**
 * Return a cached vehicle profile with its radius reduced to the collision radius. Keep all other constraints,
 * including headroom. Return nonvehicle profiles unchanged.
 */
export function bodyOf(p: NavProfile): NavProfile {
  const v = p.vehicle;
  if (!v) {
    return p;
  }

  let b = bodies.get(p.name);
  if (!b) {
    bodies.set(p.name, (b = { ...p, name: `${p.name}:body`, radius: v.radius }));
  }

  return b;
}

/** Return the vehicle turning radius plus steering slack, in meters, or zero for pedestrians. */
export function turnRadius(p: NavProfile): number {
  const v = p.vehicle;
  return v ? v.wheelBase / Math.tan(v.maxSteer) + TURN_SLACK : 0;
}

/** Derive clearance and step limits from physics tuning, with separate route preferences for each actor. */
export const NAV = {
  car: {
    name: 'car',
    radius: TUNING.car.radius + MARGIN,
    height: TUNING.car.height + MARGIN,
    stepUp: TUNING.car.stepUp,
    offRoad: 5,
    onStreet: 1,
    lanes: true,
    roomy: 3.2,
    wallCost: 1.6,
    vehicle: TUNING.car,
  },
  truck: {
    name: 'truck',
    radius: TUNING.truck.radius + MARGIN,
    height: TUNING.truck.height + MARGIN,
    stepUp: TUNING.truck.stepUp,
    offRoad: 2,
    onStreet: 1,
    lanes: false,
    roomy: 3.8,
    wallCost: 1.6,
    vehicle: TUNING.truck,
  },
  person: {
    name: 'person',
    radius: TUNING.player.radius,
    height: TUNING.player.height,
    stepUp: TUNING.player.stepUp,
    offRoad: 1,
    onStreet: 2.5,
    lanes: false,
    roomy: 0.9,
    wallCost: 0.3,
  },
} as const satisfies Record<string, NavProfile>;

/**
 * Options for a route request. Exclusion zones apply only to surfaces within their vertical range, so blocking one
 * floor leaves other floors available.
 */
export interface NavQuery {
  /** Exclude surfaces inside these zones. */
  blocks?: readonly ZoneDef[];
  /** Allow surfaces in this zone even when a block overlaps it. */
  allow?: ZoneDef;
  /**
   * Request vehicle pose searches from yaw to endYaw, in radians. With eitherWay, also accept the opposite destination
   * heading. Failed searches leave a fallback segment and set the job's drivable flag to false.
   */
  drive?: { yaw: number; endYaw: number; eitherWay?: boolean };
  /** Allow pedestrian routes to use elevators. Required rides are returned in NavJob.hops. */
  elevators?: boolean;
}

/**
 * Identify an elevator ride by its index in level.elevators, departure and arrival stop indices, and route arc lengths
 * s0 and s1 in meters.
 */
export interface NavHop {
  lift: number;
  from: number;
  to: number;
  s0: number;
  s1: number;
}

/** Shared empty list for routes without elevator rides. */
export const NO_HOPS: readonly NavHop[] = [];

/** One stretch of a vehicle route driven in a single direction. */
export interface RouteLeg {
  path: Polyline;
  reverse: boolean;
}

// grid
const CELL = 0.5;
/** Maximum number of standing surfaces retained per cell, starting with the lowest. */
const LAYERS = 6;
const NONE = -1;
/** Grid margin around the level's solids, in meters. */
const GRID_PAD = 6;
/** Side length of collision-query tiles, in meters. */
const TILE = 8;
/** Minimum headroom for retaining a surface, in meters. Profiles may require more. */
const MIN_ROOM = 1.2;
/** Surface height tolerance in meters. */
const EPS = 0.02;
/** Tolerance around y = 0 used to classify street-level surfaces, in meters. */
const STREET_Y = 0.05;
/** Additional height tolerances for endpoint snapping and clearance across slopes, in meters. */
const SNAP_TOL = 0.6;
const TILT_TOL = 0.15;
/** Wall distances are cached in steps of 1/WALL_RES meters. */
const WALL_RES = 10;
/**
 * Rasterize tall, narrow solids across every overlapping cell so walls cannot fall between cell centers. This height
 * threshold, in meters, excludes stair treads.
 */
const THIN_WALL = 0.6;
/** Maximum sampling attempts per random-position query. */
const SPOT_TRIES = 24;
const ANYWHERE_REACH = 6;
/** Maximum cell-ring radius when snapping a point to a surface node. */
const NEAR_SEARCH = 6;

// lanes
/** Maximum distance from a traffic lane segment for assigning its direction to a cell, in meters. */
const LANE_REACH = 3;
const LANE_WITH = 0.7;
const LANE_AGAINST = 4;
/** Minimum direction cosine for applying the with-lane or against-lane cost. */
const LANE_DOT = 0.5;
/** Clear lane preferences where different traffic loops overlap with an absolute direction cosine below this threshold. */
const LANE_CONFLICT = 0.7;

// ramps
/** Axis-aligned vehicle approach distance beyond each ramp end, in meters. */
const RUN_UP = 3;
/** Height tolerances for identifying ramp approaches and ramp surfaces, in meters. */
const RUN_UP_TOL = 0.3;
const RAMP_TOL = 0.1;
/** Maximum perpendicular heading components allowed on ramps during planning and route following. */
const ALIGN_SLACK = Math.sin(0.45);
const LOOSE_SLACK = Math.sin(0.7);
const enum Align {
  X = 1,
  Z = 2,
  /** Mark the ramp surface so segment shaping also enforces its axis. */
  Ramp = 4,
}
const enum Cell {
  Asphalt = 1,
  Deck = 2,
  /** Building footprint excluded from sidewalk spawn queries. */
  Indoors = 4,
}

// search
/** Heuristic multiplier for weighted A*, trading route optimality for fewer expansions. */
const GREED = 1.6;
/** Base search margin in meters, increased in proportion to endpoint distance. */
const SEARCH_MARGIN = 45;
const SEARCH_MARGIN_PER_M = 0.3;
/** Additional endpoint relaxation distance beyond the profile radius, in meters. Within it, use body clearance. */
const RELAX_EXTRA = 1.2;
/** Expansions between deadline checks. */
const TIME_CHECK_EVERY = 256;
/** Clear node marks before search IDs reach this limit. */
const SID_LIMIT = 0x3ffffffe;
/** Encode open and closed states within each search ID. */
const enum Mark {
  Open = 0,
  Closed = 1,
  Per = 2,
}

// shaping the route
/** Maximum shortcut length in meters. */
const MAX_SEGMENT = 24;
/** Distance between shortcut clearance samples, in meters. */
const SEGMENT_STEP = CELL * 0.5;
/** Allowed shortcut cost relative to the replaced route: a multiplier plus an additive allowance. */
const SHORTCUT_SLACK = 1.03;
const SHORTCUT_GRACE = 0.25;
/** Remove bends below MERGE_ANGLE radians or legs below STUB_LEG meters when a direct segment is valid. */
const MERGE_ANGLE = 0.25;
const STUB_LEG = 1;
/** Maximum separation, in turning radii, for merging two corners that turn in the same direction. */
const STUB_FOLD = 1.5;
const FOLD_PASSES = 8;
/** Minimum turn angle for rounding a corner, in radians. */
const MIN_TURN = 0.12;
/** Maximum fraction of either leg used by an arc, with RADIUS_TOL setting the minimum accepted radius ratio. */
const LEG_SHARE = 0.48;
const RADIUS_TOL = 0.95;
/** Initial arc radii as fractions of the turning radius. Without failure reporting, retry smaller radii down to ARC_MIN. */
const ARC_TRIES = [1, 0.85];
const ARC_SHRINK = 0.7;
const ARC_MIN = 0.4;
/** Target spacing between arc samples, in meters. */
const ARC_SPACING = 1.2;

// drives
/** Search window distances before and after an invalid route section, in turning radii. */
const WINDOW_BACK = 2;
const WINDOW_AHEAD = 0.8;
/** Merge search windows separated by at most this many turning radii. */
const WINDOW_GAP = 1;
/** Margin around sampled route sections for the drive-search guide, in meters. */
const WINDOW_MARGIN = 12;
const BOX_STEP = 1;
/** Window endpoint adjustment step and minimum entry distance from corners, in meters. */
const WINDOW_NUDGE = 0.5;
const CORNER_CLEAR = 0.3;
/** Heading difference in radians that requires a drive-search window at the start. */
const START_SLACK = 0.35;
/**
 * Try rejoining the following straight at REJOIN_STEP turning-radius intervals, up to REJOIN_REACH radii ahead. Leave
 * REJOIN_SPARE meters before the next turn.
 */
const REJOIN_REACH = 3;
const REJOIN_STEP = 0.5;
const REJOIN_SPARE = 0.5;
/** Maximum passes that validate ordinary route sections and add drive-search windows. */
const LAYOUT_PASSES = 6;
/** Distance between vehicle fit checks along ordinary route sections, in meters. */
const CHECK_STEP = 0.5;

const PLAN_BUDGET_MS = 3;

// elevators
/** Elevator cost expressed as equivalent walking distance: a fixed waiting cost plus a cost per vertical meter. */
const LIFT_WAIT = 12;
const LIFT_PER_M = 0.4;
/** Maximum height difference between a stop and its landing node, in meters. */
const LIFT_TOL = 0.1;

const _f = new Vector3();
const _g = new Vector3();

/**
 * Build a layered navigation grid from collision surfaces and their headroom. Search nodes identify a surface within a
 * cell; neighboring nodes connect within the profile's step limit. Clearance, terrain costs and optional elevator links
 * determine usable routes.
 */
export class NavGrid {
  readonly x0: number;
  readonly z0: number;
  readonly nx: number;
  readonly nz: number;
  private readonly count: Uint8Array;
  private readonly h: Float32Array;
  private readonly room: Float32Array;
  private readonly ramp: Uint8Array;
  /** Axis restrictions for vehicle movement on ramps and approaches; zero permits either axis. */
  private readonly align: Uint8Array;
  private readonly cellFlags: Uint8Array;
  private readonly laneX: Float32Array;
  private readonly laneZ: Float32Array;
  private readonly clearance = new Map<string, Uint8Array>();
  /** Distance to the nearest wall or drop per node, in 1/WALL_RES m steps + 1 (0 = not measured yet). */
  private readonly wallDists = new Map<string, Uint8Array>();
  private readonly rings = new Map<string, Int32Array>();
  private readonly disks = new Map<string, Int32Array>();
  // Reuse search buffers across jobs.
  private readonly g: Float32Array;
  private readonly parent: Int32Array;
  private readonly mark: Uint32Array;
  private readonly blockMark: Uint32Array;
  private sid = 0;
  /** Shaft footprints whose enclosed solids are excluded from the grid. Elevator rides connect landing nodes instead. */
  private readonly shafts: readonly ZoneDef[];
  /** Landing node for each elevator stop, or NONE when no suitable surface exists. */
  private readonly lifts: { def: ElevatorDef; nodes: number[] }[];
  /** The elevator stops at each landing node: [elevator, stop] pairs. */
  private readonly liftAt = new Map<number, [number, number][]>();
  /** Runtime elevators that take control of walkers during route hops. */
  elevators: Elevators | null = null;
  /** Grid construction time in milliseconds. */
  buildMs = 0;

  private constructor(
    x0: number,
    z0: number,
    nx: number,
    nz: number,
    /** Collision world used to sample ramp heights. */
    private readonly world: CollisionWorld,
    elevators: readonly ElevatorDef[],
  ) {
    this.x0 = x0;
    this.z0 = z0;
    this.nx = nx;
    this.nz = nz;
    const cells = nx * nz;
    const nodes = cells * LAYERS;
    this.count = new Uint8Array(cells);
    this.h = new Float32Array(nodes);
    this.room = new Float32Array(nodes);
    this.ramp = new Uint8Array(nodes);
    this.align = new Uint8Array(nodes);
    this.cellFlags = new Uint8Array(cells);
    this.laneX = new Float32Array(cells);
    this.laneZ = new Float32Array(cells);
    this.g = new Float32Array(nodes);
    this.parent = new Int32Array(nodes);
    this.mark = new Uint32Array(nodes);
    this.blockMark = new Uint32Array(nodes);
    this.shafts = elevators.map((e) => ({ min: e.min, max: e.max }));
    this.lifts = elevators.map((def) => ({ def, nodes: def.stops.map(() => NONE) }));
  }

  static build(world: CollisionWorld, level: LevelData): NavGrid {
    const t0 = performance.now();
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const s of world.solids) {
      minX = Math.min(minX, s.min[0]);
      minZ = Math.min(minZ, s.min[2]);
      maxX = Math.max(maxX, s.max[0]);
      maxZ = Math.max(maxZ, s.max[2]);
    }

    const x0 = Math.floor((minX - GRID_PAD) / CELL) * CELL;
    const z0 = Math.floor((minZ - GRID_PAD) / CELL) * CELL;
    const nav = new NavGrid(
      x0,
      z0,
      Math.ceil((maxX + GRID_PAD - x0) / CELL),
      Math.ceil((maxZ + GRID_PAD - z0) / CELL),
      world,
      level.elevators ?? [],
    );
    nav.rasterize(world, nav.x0, nav.z0, nav.x0 + nav.nx * CELL, nav.z0 + nav.nz * CELL);
    nav.flagRamps(world.solids);
    nav.flagGround(level);
    nav.rasterizeLanes(level);
    nav.linkLifts();
    nav.buildMs = performance.now() - t0;
    return nav;
  }

  // ---------------------------------------------------------------- build

  /** Return whether the solid's horizontal footprint lies within an elevator shaft, allowing EPS at the edges. */
  private inShaft(s: Solid): boolean {
    for (const z of this.shafts) {
      if (
        s.min[0] >= z.min[0] - EPS &&
        s.max[0] <= z.max[0] + EPS &&
        s.min[2] >= z.min[2] - EPS &&
        s.max[2] <= z.max[2] + EPS
      ) {
        return true;
      }
    }

    return false;
  }

  /**
   * Associate each elevator stop with a nearby surface at its landing point. Leave stops without adequate headroom or a
   * matching height unlinked.
   */
  private linkLifts(): void {
    this.liftAt.clear();
    const at: V3 = [0, 0, 0];
    this.lifts.forEach((l, li) => {
      l.def.stops.forEach((s, si) => {
        landingPoint(l.def, si, at);
        const c = this.cellOf(at[0], at[2]);
        const node = c === NONE ? NONE : this.surface(c, s.y, LIFT_TOL, NAV.person.height);
        l.nodes[si] = node;

        if (node === NONE) {
          return;
        }

        let list = this.liftAt.get(node);
        if (!list) {
          this.liftAt.set(node, (list = []));
        }

        list.push([li, si]);
      });
    });
  }

  /**
   * Rasterize solids over the requested world-coordinate rectangle, extending to tile boundaries and clipping to the
   * grid.
   */
  private rasterize(world: CollisionWorld, x0: number, z0: number, x1: number, z1: number): void {
    const lo: number[] = [];
    const hi: number[] = [];
    const isRamp: boolean[] = [];
    const cand: number[] = [];
    const per = Math.round(TILE / CELL);
    const tz0 = this.z0 + Math.max(0, Math.floor((z0 - this.z0) / TILE)) * TILE;
    const tx0 = this.x0 + Math.max(0, Math.floor((x0 - this.x0) / TILE)) * TILE;
    const tz1 = Math.min(this.z0 + this.nz * CELL, z1);
    const tx1 = Math.min(this.x0 + this.nx * CELL, x1);
    for (let tz = tz0; tz < tz1; tz += TILE) {
      for (let tx = tx0; tx < tx1; tx += TILE) {
        const solids: Solid[] = world.query(tx, tz, tx + TILE, tz + TILE).filter((s) => !this.inShaft(s));
        const i0 = Math.round((tx - this.x0) / CELL);
        const j0 = Math.round((tz - this.z0) / CELL);
        for (let j = j0; j < Math.min(this.nz, j0 + per); j++) {
          const cz = this.z0 + (j + 0.5) * CELL;
          for (let i = i0; i < Math.min(this.nx, i0 + per); i++) {
            const cx = this.x0 + (i + 0.5) * CELL;
            lo.length = 0;
            hi.length = 0;
            isRamp.length = 0;

            for (const s of solids) {
              // Count thin walls that overlap the cell even when they miss its center.
              const wall = s.max[1] - s.min[1] > THIN_WALL;
              const h = CELL / 2;
              const outX =
                wall && s.max[0] - s.min[0] < CELL
                  ? cx + h <= s.min[0] || cx - h >= s.max[0]
                  : cx < s.min[0] || cx > s.max[0];
              const outZ =
                wall && s.max[2] - s.min[2] < CELL
                  ? cz + h <= s.min[2] || cz - h >= s.max[2]
                  : cz < s.min[2] || cz > s.max[2];
              if (outX || outZ) {
                continue;
              }

              lo.push(s.min[1]);
              hi.push(world.topAt(s, cx, cz));
              isRamp.push(!!s.ramp);
            }

            this.fillCell(j * this.nx + i, world.groundPlane(cx, cz), lo, hi, isRamp, cand);
          }
        }
      }
    }
  }

  /**
   * Retain up to LAYERS exposed surfaces with sufficient headroom, ordered from lowest to highest. Candidates are the
   * ground plane and solid tops above it.
   */
  private fillCell(c: number, plane: number, lo: number[], hi: number[], isRamp: boolean[], cand: number[]): void {
    cand.length = 0;
    cand.push(plane);

    for (const t of hi) {
      if (t > plane + EPS) {
        cand.push(t);
      }
    }

    cand.sort((a, b) => a - b);
    let n = 0;
    let last = -Infinity;
    for (const y of cand) {
      if (n >= LAYERS) {
        break;
      }

      if (y - last < EPS) {
        continue;
      }

      let room = Infinity;
      let inside = false;
      let fromRamp = false;
      for (let k = 0; k < lo.length; k++) {
        const l = lo[k] as number;
        const t = hi[k] as number;
        if (Math.abs(t - y) < EPS && isRamp[k]) {
          fromRamp = true;
        }

        if (t <= y + EPS) {
          continue;
        }

        if (l < y - EPS) {
          inside = true;
          break;
        }

        room = Math.min(room, l - y);
      }

      if (inside || room < MIN_ROOM) {
        continue;
      }

      const node = c * LAYERS + n;
      this.h[node] = y;
      this.room[node] = room;
      this.ramp[node] = fromRamp ? 1 : 0;
      n++;
      last = y;
    }

    this.count[c] = n;
  }

  /**
   * Restrict vehicle movement to the ramp axis on its surface and approaches, allowing turns only after leaving the
   * restricted area.
   */
  private flagRamps(solids: readonly Solid[]): void {
    const world = this.world;
    for (const s of solids) {
      const r = s.ramp;
      if (!r) {
        continue;
      }

      const ax = r.axis === 'x' ? 0 : 2;
      const code = r.axis === 'x' ? Align.X : Align.Z;
      const lowAt = r.dir > 0 ? s.min[ax] : s.max[ax];
      const highAt = r.dir > 0 ? s.max[ax] : s.min[ax];
      const up = r.dir > 0 ? 1 : -1;
      const mark = (
        a0: number,
        a1: number,
        value: number,
        test: (y: number, cx: number, cz: number) => boolean,
      ): void => {
        const lo = Math.min(a0, a1);
        const hi = Math.max(a0, a1);
        const [x0, z0, x1, z1] = ax === 0 ? [lo, s.min[2], hi, s.max[2]] : [s.min[0], lo, s.max[0], hi];
        this.forCells(x0, z0, x1, z1, (c, cx, cz) => {
          const n = this.count[c] ?? 0;
          for (let k = 0; k < n; k++) {
            const node = c * LAYERS + k;
            if (test(this.h[node] ?? 0, cx, cz)) {
              this.align[node] = value;
            }
          }
        });
      };

      mark(lowAt - up * RUN_UP, lowAt, code, (y) => Math.abs(y - r.low) < RUN_UP_TOL);
      mark(highAt, highAt + up * RUN_UP, code, (y) => Math.abs(y - s.max[1]) < RUN_UP_TOL);
      mark(s.min[ax], s.max[ax], code | Align.Ramp, (y, cx, cz) => Math.abs(y - world.topAt(s, cx, cz)) < RAMP_TOL);
    }
  }

  private flagGround(level: LevelData): void {
    // Distinguish raised asphalt overlays from the street-level ground box.
    for (const b of level.boxes) {
      if (b.mat !== 'asphalt' || b.max[1] < STREET_Y) {
        continue;
      }

      this.forCells(
        b.min[0],
        b.min[2],
        b.max[0],
        b.max[2],
        (c) => (this.cellFlags[c] = (this.cellFlags[c] ?? 0) | Cell.Asphalt),
      );
    }

    const d = level.deck;
    this.forCells(
      d.min[0],
      d.min[2],
      d.max[0],
      d.max[2],
      (c) => (this.cellFlags[c] = (this.cellFlags[c] ?? 0) | Cell.Deck),
    );

    for (const b of level.buildings ?? []) {
      this.forCells(
        b.min[0],
        b.min[2],
        b.max[0],
        b.max[2],
        (c) => (this.cellFlags[c] = (this.cellFlags[c] ?? 0) | Cell.Indoors),
      );
    }
  }

  /**
   * Assign each cell the nearest traffic lane direction within LANE_REACH. Clear the preference where different loops
   * cross at sufficiently different angles.
   */
  private rasterizeLanes(level: LevelData): void {
    const cells = this.nx * this.nz;
    const conflict = new Uint8Array(cells);
    const dist = new Float32Array(cells).fill(Infinity);
    const owner = new Int32Array(cells).fill(NONE);
    level.paths.forEach((path, pi) => {
      const pts = path.points;
      for (let k = 0; k < pts.length; k++) {
        const a = pts[k] as [number, number, number];
        const b = pts[(k + 1) % pts.length] as [number, number, number];
        const dx = b[0] - a[0];
        const dz = b[2] - a[2];
        const len = Math.hypot(dx, dz);
        if (len < EPS) {
          continue;
        }

        const ux = dx / len;
        const uz = dz / len;
        this.forCells(
          Math.min(a[0], b[0]) - LANE_REACH,
          Math.min(a[2], b[2]) - LANE_REACH,
          Math.max(a[0], b[0]) + LANE_REACH,
          Math.max(a[2], b[2]) + LANE_REACH,
          (c, cx, cz) => {
            const t = clamp((cx - a[0]) * ux + (cz - a[2]) * uz, 0, len);
            const d = Math.hypot(cx - (a[0] + ux * t), cz - (a[2] + uz * t));
            if (d > LANE_REACH || conflict[c]) {
              return;
            }

            const o = owner[c] ?? NONE;
            if (
              o !== NONE &&
              o !== pi &&
              Math.abs((this.laneX[c] ?? 0) * ux + (this.laneZ[c] ?? 0) * uz) < LANE_CONFLICT
            ) {
              conflict[c] = 1;
              this.laneX[c] = 0;
              this.laneZ[c] = 0;
              return;
            }

            if (d >= (dist[c] ?? Infinity)) {
              return;
            }

            dist[c] = d;
            owner[c] = pi;
            this.laneX[c] = ux;
            this.laneZ[c] = uz;
          },
        );
      }
    });
  }

  private forCells(
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    fn: (c: number, cx: number, cz: number) => void,
  ): void {
    const i0 = Math.max(0, Math.ceil((x0 - this.x0) / CELL - 0.5));
    const i1 = Math.min(this.nx - 1, Math.floor((x1 - this.x0) / CELL - 0.5));
    const j0 = Math.max(0, Math.ceil((z0 - this.z0) / CELL - 0.5));
    const j1 = Math.min(this.nz - 1, Math.floor((z1 - this.z0) / CELL - 0.5));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        fn(j * this.nx + i, this.x0 + (i + 0.5) * CELL, this.z0 + (j + 0.5) * CELL);
      }
    }
  }

  // ---------------------------------------------------------------- queries

  cellOf(x: number, z: number): number {
    const i = Math.floor((x - this.x0) / CELL);
    const j = Math.floor((z - this.z0) / CELL);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) {
      return NONE;
    }

    return j * this.nx + i;
  }

  /** Return the surface in cell c nearest y within tol that has the requested headroom, or NONE. */
  private surface(c: number, y: number, tol: number, height: number): number {
    let best = NONE;
    let bd = tol;
    const n = this.count[c] ?? 0;
    for (let k = 0; k < n; k++) {
      const node = c * LAYERS + k;
      const d = Math.abs((this.h[node] ?? 0) - y);
      if (d <= bd && (this.room[node] ?? 0) >= height) {
        bd = d;
        best = node;
      }
    }

    return best;
  }

  /**
   * Sample a standing position between rMin and rMax meters from (x, z), from street level up to upTo. With sidewalk,
   * require a raised surface outside deck and building footprints. Return null after SPOT_TRIES unsuccessful attempts.
   */
  spotNear(
    rng: Rng,
    x: number,
    z: number,
    rMin: number,
    rMax: number,
    p: NavProfile,
    upTo: number,
    sidewalk: boolean,
  ): Vector3 | null {
    for (let t = 0; t < SPOT_TRIES; t++) {
      const a = rng.range(0, TAU);
      const r = rng.range(rMin, rMax);
      const c = this.cellOf(x + Math.sin(a) * r, z + Math.cos(a) * r);
      if (c === NONE || (sidewalk && (this.cellFlags[c] ?? 0) & (Cell.Deck | Cell.Indoors))) {
        continue;
      }

      const n = this.count[c] ?? 0;
      for (let k = 0; k < n; k++) {
        const node = c * LAYERS + k;
        const y = this.h[node] ?? 0;
        // Exclude below-street surfaces such as stair shafts and basements.
        if (y > upTo || y < -STREET_Y || (sidewalk && y < STREET_Y) || !this.clear(node, p)) {
          continue;
        }

        return this.nodePos(node, new Vector3());
      }
    }

    return null;
  }

  /**
   * Sample points across the grid and call spotNear within ANYWHERE_REACH meters of each. Apply the same height and
   * sidewalk restrictions; return null if all attempts fail.
   */
  anywhere(rng: Rng, p: NavProfile, upTo: number, sidewalk: boolean): Vector3 | null {
    for (let t = 0; t < SPOT_TRIES; t++) {
      const x = this.x0 + rng.range(0, this.nx * CELL);
      const z = this.z0 + rng.range(0, this.nz * CELL);
      const at = this.spotNear(rng, x, z, 0, ANYWHERE_REACH, p, upTo, sidewalk);
      if (at) {
        return at;
      }
    }

    return null;
  }

  /**
   * Return a surface height near the supplied point with the required headroom, or null if none is within snapping
   * tolerance. This does not check horizontal clearance.
   */
  heightAt(x: number, y: number, z: number, p: NavProfile = NAV.person): number | null {
    const c = this.cellOf(x, z);
    if (c === NONE) {
      return null;
    }

    const node = this.surface(c, y, p.stepUp + SNAP_TOL, p.height);
    return node === NONE ? null : (this.h[node] ?? null);
  }

  /**
   * Return a surface height within the profile's step limit and with full clearance, or null. For vehicles with a
   * heading, also enforce ramp alignment. With loose, check only ramp surfaces and allow greater heading deviation.
   */
  standable(x: number, y: number, z: number, p: NavProfile, yaw?: number, loose = false): number | null {
    const c = this.cellOf(x, z);
    if (c === NONE) {
      return null;
    }

    const node = this.surface(c, y, p.stepUp, p.height);
    if (node === NONE || !this.clear(node, p)) {
      return null;
    }

    if (yaw !== undefined && p.vehicle && !this.aligned(node, yaw, loose)) {
      return null;
    }

    return this.h[node] ?? null;
  }

  private aligned(node: number, yaw: number, loose: boolean): boolean {
    const al = this.align[node] ?? 0;
    if (loose && !(al & Align.Ramp)) {
      return true;
    }

    const slack = loose ? LOOSE_SLACK : ALIGN_SLACK;
    return !((al & Align.X && Math.abs(Math.cos(yaw)) > slack) || (al & Align.Z && Math.abs(Math.sin(yaw)) > slack));
  }

  private disk(p: NavProfile): Int32Array {
    let d = this.disks.get(p.name);
    if (d) {
      return d;
    }

    const r = Math.ceil(p.radius / CELL);
    const out: number[] = [];
    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) {
        if (Math.hypot(di, dj) * CELL <= p.radius + EPS) {
          out.push(di, dj);
        }
      }
    }

    d = Int32Array.from(out);
    this.disks.set(p.name, d);
    return d;
  }

  /**
   * Check headroom and compatible surface heights at all grid offsets within the profile radius. Cache the result by
   * profile name.
   */
  private clear(node: number, p: NavProfile): boolean {
    let cache = this.clearance.get(p.name);
    if (!cache) {
      this.clearance.set(p.name, (cache = new Uint8Array(this.h.length)));
    }

    const v = cache[node];
    if (v) {
      return v === 1;
    }

    const c = Math.floor(node / LAYERS);
    const i = c % this.nx;
    const j = (c - i) / this.nx;
    const y = this.h[node] ?? 0;
    let ok = (this.room[node] ?? 0) >= p.height;
    const d = this.disk(p);
    const tol = p.stepUp + TILT_TOL;
    for (let k = 0; ok && k < d.length; k += 2) {
      const ii = i + (d[k] ?? 0);
      const jj = j + (d[k + 1] ?? 0);
      if (ii < 0 || jj < 0 || ii >= this.nx || jj >= this.nz) {
        ok = false;
      } else if (this.surface(jj * this.nx + ii, y, tol, p.height) === NONE) {
        ok = false;
      }
    }

    cache[node] = ok ? 1 : 2;
    return ok;
  }

  /** Return offsets beyond the profile radius and within roomy, sorted by distance for nearest-obstacle queries. */
  private ring(p: NavProfile): Int32Array {
    let r = this.rings.get(p.name);
    if (r) {
      return r;
    }

    const n = Math.ceil(p.roomy / CELL);
    const out: [number, number, number][] = [];
    for (let dj = -n; dj <= n; dj++) {
      for (let di = -n; di <= n; di++) {
        const d = Math.hypot(di, dj) * CELL;
        if (d > p.radius && d <= p.roomy) {
          out.push([d, di, dj]);
        }
      }
    }

    out.sort((a, b) => a[0] - b[0]);
    r = Int32Array.from(out.flatMap(([, di, dj]) => [di, dj]));
    this.rings.set(p.name, r);
    return r;
  }

  /**
   * Measure the nearest incompatible surface beyond the profile radius, capped at roomy. Cache distances at WALL_RES
   * precision.
   */
  private wallDist(node: number, p: NavProfile): number {
    let cache = this.wallDists.get(p.name);
    if (!cache) {
      this.wallDists.set(p.name, (cache = new Uint8Array(this.h.length)));
    }

    const v = cache[node];
    if (v) {
      return (v - 1) / WALL_RES;
    }

    const c = Math.floor(node / LAYERS);
    const i = c % this.nx;
    const j = (c - i) / this.nx;
    const y = this.h[node] ?? 0;
    const tol = p.stepUp + TILT_TOL;
    const r = this.ring(p);
    let d = p.roomy;
    for (let k = 0; k < r.length; k += 2) {
      const ii = i + (r[k] ?? 0);
      const jj = j + (r[k + 1] ?? 0);
      const blocked =
        ii < 0 ||
        jj < 0 ||
        ii >= this.nx ||
        jj >= this.nz ||
        this.surface(jj * this.nx + ii, y, tol, p.height) === NONE;
      if (blocked) {
        d = Math.hypot(r[k] ?? 0, r[k + 1] ?? 0) * CELL;
        break;
      }
    }

    cache[node] = Math.min(255, Math.round(d * WALL_RES) + 1);
    return d;
  }

  /** Return the movement cost multiplier for this node and direction, including terrain, lane and wall preferences. */
  private costK(node: number, c: number, dx: number, dz: number, p: NavProfile): number {
    const flags = this.cellFlags[c] ?? 0;
    const street = Math.abs(this.h[node] ?? 0) < STREET_Y && !(flags & Cell.Deck);
    let k: number;
    if (p.offRoad !== 1) {
      const road = street || flags & Cell.Asphalt || flags & Cell.Deck || this.ramp[node];
      k = road ? 1 : p.offRoad;
    } else {
      k = street ? p.onStreet : 1;
    }

    if (p.lanes) {
      const lx = this.laneX[c] ?? 0;
      const lz = this.laneZ[c] ?? 0;
      if (lx || lz) {
        const dot = (dx * lx + dz * lz) / (Math.hypot(dx, dz) || 1);
        if (dot > LANE_DOT) {
          k *= LANE_WITH;
        } else if (dot < -LANE_DOT) {
          k *= LANE_AGAINST;
        }
      }
    }

    if (p.wallCost > 0) {
      // Favor clearance that leaves room for vehicle turns.
      const t = 1 - Math.min(1, (this.wallDist(node, p) - p.radius) / (p.roomy - p.radius));
      k *= 1 + p.wallCost * t * t;
    }

    return k;
  }

  // ---------------------------------------------------------------- search

  /**
   * Return a nearby surface with compatible height and headroom, searching the containing cell then expanding cell
   * rings. This does not check blocks or horizontal clearance.
   */
  private nodeNear(x: number, y: number, z: number, p: NavProfile): number {
    const c = this.cellOf(x, z);
    if (c === NONE) {
      return NONE;
    }

    const i = c % this.nx;
    const j = (c - i) / this.nx;
    for (let r = 0; r <= NEAR_SEARCH; r++) {
      let best = NONE;
      let bd = Infinity;
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) {
            continue;
          }

          const ii = i + di;
          const jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= this.nx || jj >= this.nz) {
            continue;
          }

          const node = this.surface(jj * this.nx + ii, y, p.stepUp + SNAP_TOL, p.height);
          if (node === NONE) {
            continue;
          }

          const d = di * di + dj * dj;
          if (d < bd) {
            bd = d;
            best = node;
          }
        }
      }

      if (best !== NONE) {
        return best;
      }
    }

    return NONE;
  }

  private nodePos(node: number, out: Vector3): Vector3 {
    const c = Math.floor(node / LAYERS);
    const i = c % this.nx;
    const j = (c - i) / this.nx;
    return out.set(this.x0 + (i + 0.5) * CELL, this.h[node] ?? 0, this.z0 + (j + 0.5) * CELL);
  }

  /** Mark (or clear) every surface node inside a zone, by height as well as footprint. */
  private stampZone(z: ZoneDef, value: number): void {
    this.forCells(z.min[0], z.min[2], z.max[0], z.max[2], (c) => {
      const n = this.count[c] ?? 0;
      for (let k = 0; k < n; k++) {
        const node = c * LAYERS + k;
        const y = this.h[node] ?? 0;
        if (y >= z.min[1] - EPS && y <= z.max[1]) {
          this.blockMark[node] = value;
        }
      }
    });
  }

  private stampBlocks(q: NavQuery): void {
    for (const z of q.blocks ?? []) {
      this.stampZone(z, this.sid);
    }

    if (q.allow) {
      this.stampZone(q.allow, 0);
    }
  }

  /**
   * Initialize the job using shared search buffers. Only one job may search this grid at a time; NavPlanner serializes
   * requests.
   */
  begin(job: NavJob): void {
    this.sid++;

    if (this.sid >= SID_LIMIT) {
      this.mark.fill(0);
      this.blockMark.fill(0);
      this.sid = 1;
    }

    this.stampBlocks(job.query);
    const p = job.profile;
    const start = this.nodeNear(job.from.x, job.from.y, job.from.z, p);
    const goal = this.nodeNear(job.to.x, job.to.y, job.to.z, p);
    if (start === NONE || goal === NONE) {
      job.status = 'failed';
      return;
    }

    const sp = this.nodePos(start, new Vector3());
    const gp = this.nodePos(goal, new Vector3());
    const margin = SEARCH_MARGIN + sp.distanceTo(gp) * SEARCH_MARGIN_PER_M;
    const hScale = (p.lanes ? LANE_WITH : 1) * GREED;
    const open = new MinHeap<number>();
    open.push(start, sp.distanceTo(gp) * hScale);
    job.search = {
      sid: this.sid,
      start,
      goal,
      sp,
      gp,
      relax: p.radius + RELAX_EXTRA,
      hScale,
      box: [
        Math.min(sp.x, gp.x) - margin,
        Math.min(sp.z, gp.z) - margin,
        Math.max(sp.x, gp.x) + margin,
        Math.max(sp.z, gp.z) + margin,
      ],
      open,
      pieces: null,
      ground: null,
      lifts: !!job.query.elevators && !p.vehicle && this.liftAt.size > 0,
    };
    this.g[start] = 0;
    this.parent[start] = NONE;
    this.mark[start] = this.sid * Mark.Per + Mark.Open;
    job.status = 'running';
  }

  /**
   * Advance a running job until completion or a deadline check exceeds the performance.now() deadline. Fail jobs whose
   * search state no longer owns the shared buffers.
   */
  advance(job: NavJob, deadline: number): void {
    const S = job.search;
    if (!S || job.status !== 'running' || S.sid !== this.sid) {
      job.status = 'failed';
      return;
    }

    const t0 = performance.now();
    if (S.pieces) {
      this.advanceDrive(job, S, deadline);
    } else {
      this.advanceGrid(job, S, deadline);
    }

    job.ms += performance.now() - t0;
  }

  /** Expand weighted A* nodes until the goal is reached, the queue is exhausted or a periodic deadline check expires. */
  private advanceGrid(job: NavJob, S: NavSearch, deadline: number): void {
    const p = job.profile;
    const { sid, goal, sp, gp, relax, hScale, open } = S;
    const [bx0, bz0, bx1, bz1] = S.box;
    const r2 = relax * relax;
    const openMark = sid * Mark.Per + Mark.Open;
    const closed = sid * Mark.Per + Mark.Closed;
    let budget = 0;
    while (open.size) {
      if (++budget >= TIME_CHECK_EVERY) {
        budget = 0;

        if (performance.now() > deadline) {
          return;
        }
      }

      const n = open.pop();
      if (this.mark[n] === closed) {
        continue;
      }

      this.mark[n] = closed;
      job.expanded++;

      if (n === goal) {
        this.trace(job, S);
        return;
      }

      const c = Math.floor(n / LAYERS);
      const i = c % this.nx;
      const j = (c - i) / this.nx;
      const gn = this.g[n] ?? 0;
      for (let dj = -1; dj <= 1; dj++) {
        const wz = this.z0 + (j + dj + 0.5) * CELL;
        if (wz < bz0 || wz > bz1) {
          continue;
        }

        for (let di = -1; di <= 1; di++) {
          const wx = this.x0 + (i + di + 0.5) * CELL;
          if (wx < bx0 || wx > bx1) {
            continue;
          }

          const m = this.link(n, i, j, di, dj, p, sid);
          if (m === NONE || this.mark[m] === closed) {
            continue;
          }

          const sx = wx - sp.x;
          const sz = wz - sp.z;
          const gx = wx - gp.x;
          const gz = wz - gp.z;
          const nearEnd = sx * sx + sz * sz < r2 || gx * gx + gz * gz < r2;
          if (!this.clear(m, nearEnd ? bodyOf(p) : p)) {
            continue;
          }

          const g = gn + (di && dj ? Math.SQRT2 : 1) * CELL * this.costK(m, Math.floor(m / LAYERS), di, dj, p);
          if (this.mark[m] === openMark && g >= (this.g[m] ?? Infinity)) {
            continue;
          }

          this.g[m] = g;
          this.parent[m] = n;
          this.mark[m] = openMark;
          const gy = (this.h[m] ?? 0) - gp.y;
          open.push(m, g + Math.sqrt(gx * gx + gz * gz + gy * gy) * hScale);
        }
      }

      if (S.lifts) {
        this.rideFrom(n, S, p);
      }
    }

    job.status = 'failed';
  }

  /** Expand valid, unblocked stops reachable by an elevator from this landing node. */
  private rideFrom(n: number, S: NavSearch, p: NavProfile): void {
    const at = this.liftAt.get(n);
    if (!at) {
      return;
    }

    const open = S.sid * Mark.Per + Mark.Open;
    const closed = S.sid * Mark.Per + Mark.Closed;
    const gn = this.g[n] ?? 0;
    const yn = this.h[n] ?? 0;
    for (const [li, si] of at) {
      const nodes = this.lifts[li]?.nodes ?? [];
      for (let sj = 0; sj < nodes.length; sj++) {
        const m = nodes[sj] ?? NONE;
        if (sj === si || m === NONE || this.mark[m] === closed || this.blockMark[m] === S.sid || !this.clear(m, p)) {
          continue;
        }

        const ym = this.h[m] ?? 0;
        const g = gn + LIFT_WAIT + Math.abs(ym - yn) * LIFT_PER_M;
        if (this.mark[m] === open && g >= (this.g[m] ?? Infinity)) {
          continue;
        }

        this.g[m] = g;
        this.parent[m] = n;
        this.mark[m] = open;
        this.nodePos(m, _f);
        S.open.push(m, g + _f.distanceTo(S.gp) * S.hScale);
      }
    }
  }

  /** Map raw path indices to elevator rides when consecutive nodes represent different stops of the same elevator. */
  private ridesAlong(nodes: readonly number[]): Map<number, [number, number, number]> {
    const rides = new Map<number, [number, number, number]>();
    for (let k = 0; k + 1 < nodes.length; k++) {
      const a = this.liftAt.get(nodes[k] ?? NONE);
      const b = this.liftAt.get(nodes[k + 1] ?? NONE);
      if (!a || !b) {
        continue;
      }

      for (const [la, sa] of a) {
        const hit = b.find(([lb, sb]) => lb === la && sb !== sa);
        if (hit) {
          rides.set(k, [la, sa, hit[1]]);
          break;
        }
      }
    }

    return rides;
  }

  /**
   * Return the neighboring surface node within the step limit, or NONE. Reject blocked destinations and diagonal corner
   * cuts; vehicles must follow ramp axes unless anyWay is true. The caller checks horizontal clearance.
   */
  private link(
    n: number,
    i: number,
    j: number,
    di: number,
    dj: number,
    p: NavProfile,
    sid: number,
    anyWay = false,
  ): number {
    if (!di && !dj) {
      return NONE;
    }

    const ii = i + di;
    const jj = j + dj;
    if (ii < 0 || jj < 0 || ii >= this.nx || jj >= this.nz) {
      return NONE;
    }

    const y = this.h[n] ?? 0;
    const m = this.surface(jj * this.nx + ii, y, p.stepUp, p.height);
    if (m === NONE || this.blockMark[m] === sid) {
      return NONE;
    }

    if (p.vehicle && !anyWay) {
      const an = this.align[n] ?? 0;
      const am = this.align[m] ?? 0;
      if ((an & Align.X || am & Align.X) && dj) {
        return NONE;
      }

      if ((an & Align.Z || am & Align.Z) && di) {
        return NONE;
      }
    }

    if (di && dj) {
      const na = this.surface(j * this.nx + ii, y, p.stepUp, p.height);
      const nb = this.surface(jj * this.nx + i, y, p.stepUp, p.height);
      if (na === NONE || nb === NONE || this.blockMark[na] === sid || this.blockMark[nb] === sid) {
        return NONE;
      }
    }

    return m;
  }

  /** Run a job synchronously to completion. Do not call while another job is using the grid's shared search buffers. */
  solve(job: NavJob): NavJob {
    this.begin(job);

    while (job.status === 'running') {
      this.advance(job, Infinity);
    }

    return job;
  }

  /**
   * Recover the grid path and preserve the requested endpoints. Smooth pedestrian routes with elevator hops intact;
   * shape vehicle routes or initialize their pose-search windows.
   */
  private trace(job: NavJob, S: NavSearch): void {
    const nodes: number[] = [];
    for (let n = S.goal; n !== NONE; n = this.parent[n] ?? NONE) {
      nodes.push(n);
    }

    nodes.reverse();
    const raw = nodes.map((n) => this.nodePos(n, new Vector3()));
    const cost = nodes.map((n) => this.g[n] ?? 0);
    raw[0] = job.from.clone();
    raw.push(job.to.clone());
    cost.push((cost[cost.length - 1] ?? 0) + S.gp.distanceTo(job.to));
    const p = job.profile;
    const ends: Ends = { sp: S.sp, gp: S.gp, relax: S.relax };
    const rides = S.lifts ? this.ridesAlong(nodes) : null;
    const pts = this.smooth(raw, cost, p, ends, rides);
    if (!p.vehicle) {
      job.path = new Polyline(pts);
      job.hops = rides?.size ? hopsAlong(pts, raw, rides) : NO_HOPS;
      job.legs = [{ path: job.path, reverse: false }];
      job.status = 'done';
      return;
    }

    const line = this.merge(pts, p, ends);
    if (job.query.drive) {
      S.pieces = this.layout(job, S, line, ends);
      S.ground = this.driveGround(p, S.sid, ends);
      return;
    }

    this.finishRoute(job, this.corners(line, p, ends));
  }

  private finishRoute(job: NavJob, route: RoutePoint[]): void {
    const pts: RoutePoint[] = [];
    for (const r of route) {
      const last = pts[pts.length - 1];
      // Adjacent route sections can repeat a boundary point without adding travel.
      if (last && Math.hypot(r.p.x - last.p.x, r.p.z - last.p.z) < EPS && r.reverse === last.reverse) {
        continue;
      }

      pts.push(r);
    }

    job.path = new Polyline(pts.map((r) => r.p));
    job.legs = toLegs(pts);
    job.status = 'done';
  }

  /**
   * Partition the route into validated lines and arcs plus windows requiring vehicle pose searches, following Pinter,
   * "Toward More Realistic Pathfinding". Always search the destination approach and search the departure when its
   * heading differs. Expand and merge windows to find usable boundary poses, up to LAYOUT_PASSES passes.
   */
  private layout(job: NavJob, S: NavSearch, line: Vector3[], ends: Ends): DrivePiece[] {
    const p = job.profile;
    const v = p.vehicle as VehicleParams;
    const d = job.query.drive as NonNullable<NavQuery['drive']>;
    const R = turnRadius(p);
    const route = new Polyline(line);
    const L = route.total;
    const at: number[] = [0];
    for (let k = 1; k < line.length; k++) {
      at.push((at[k - 1] ?? 0) + (line[k] as Vector3).distanceTo(line[k - 1] as Vector3));
    }

    const ground = this.driveGround(p, S.sid, ends);
    const body = bodyOffsets(v);
    // Follow surface heights incrementally so interpolation across ramps cannot select the wrong floor.
    const floor: number[] = [];
    for (let s = 0, y = job.from.y; s <= L + CHECK_STEP; s += CHECK_STEP) {
      route.sample(Math.min(s, L), _f);
      const c = this.cellOf(_f.x, _f.z);
      const n = c === NONE ? NONE : this.surface(c, y, p.stepUp + TILT_TOL, p.height);
      y = n === NONE ? _f.y : (this.h[n] ?? y);
      floor.push(y);
    }

    const floorAt = (s: number): number =>
      floor[Math.min(floor.length - 1, Math.round(Math.max(0, s) / CHECK_STEP))] as number;
    const fitsAt = (x: number, y: number, z: number, yaw: number): boolean =>
      body.every((o) => ground.fits(x + Math.sin(yaw) * o, y, z + Math.cos(yaw) * o, yaw) !== null);
    const poseAt = (s: number): DrivePose => {
      route.sample(s, _f, _g);
      return { x: _f.x, y: floorAt(s), z: _f.z, yaw: Math.atan2(_g.x, _g.z), reverse: false };
    };

    const fitsAtS = (s: number): boolean => {
      const q = poseAt(s);
      return fitsAt(q.x, q.y, q.z, q.yaw);
    };

    const trouble = (s: number): [number, number] => [s - R * WINDOW_BACK, s + R * WINDOW_AHEAD];

    let spans: [number, number][] = [[L - R * WINDOW_BACK, L]];
    route.sample(0, _f, _g);

    if (Math.abs(wrapAngle(d.yaw - Math.atan2(_g.x, _g.z))) > START_SLACK) {
      spans.push([0, R * WINDOW_AHEAD]);
    }

    let pieces: DrivePiece[] = [];
    for (let pass = 0; pass < LAYOUT_PASSES; pass++) {
      // Expand boundaries until the vehicle fits; keep entries away from corners and merge nearby windows.
      for (const sp of spans) {
        sp[0] = Math.max(0, sp[0]);
        sp[1] = Math.min(L, sp[1]);

        while (sp[0] > 0 && (at.some((a) => Math.abs(a - sp[0]) < CORNER_CLEAR) || !fitsAtS(sp[0]))) {
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
        if (s0 > s + EPS) {
          const pts = [
            poseAt(s),
            ...line.filter((_, k) => (at[k] ?? 0) > s + EPS && (at[k] ?? 0) < s0 - EPS),
            poseAt(s0),
          ].map((q) => new Vector3(q.x, q.y, q.z));
          if (s === 0) {
            pts[0] = job.from.clone();
          }

          const failed: number[] = [];
          const plain = this.corners(pts, p, ends, failed);
          for (const k of failed) {
            found.push(route.project(pts[k] as Vector3, s, s0 - s));
          }

          const check = new Polyline(plain.map((r) => r.p));
          for (let c = CHECK_STEP, y = floorAt(s); c < check.total; c += CHECK_STEP) {
            check.sample(c, _f, _g);
            const n = this.cellOf(_f.x, _f.z);
            const m = n === NONE ? NONE : this.surface(n, y, p.stepUp + TILT_TOL, p.height);
            y = m === NONE ? y : (this.h[m] ?? y);

            if (m === NONE || !fitsAt(_f.x, y, _f.z, Math.atan2(_g.x, _g.z))) {
              found.push(route.project(_f.setY(y), s, s0 - s));
              c += R; // Space failure reports by one turning radius.
            }
          }

          pieces.push({ pts: plain });
        }

        if (s1 > s0) {
          const from =
            s0 <= 0 ? { x: job.from.x, y: job.from.y, z: job.from.z, yaw: d.yaw, reverse: false } : poseAt(s0);
          const goals: DriveGoals = s1 >= L ? this.endPoses(job, d) : [{ ...poseAt(s1), rest: 0 }];
          // Include maneuvering space around the route in the guide bounds.
          const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
          for (let c = s0; c <= s1 + BOX_STEP; c += BOX_STEP) {
            route.sample(Math.min(c, s1), _f);
            box[0] = Math.min(box[0], _f.x - WINDOW_MARGIN);
            box[1] = Math.min(box[1], _f.z - WINDOW_MARGIN);
            box[2] = Math.max(box[2], _f.x + WINDOW_MARGIN);
            box[3] = Math.max(box[3], _f.z + WINDOW_MARGIN);
          }

          pieces.push({
            window: { from, goals, box, until: s1, midway: { start: s0 > 0, end: s1 < L }, search: null, poses: null },
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
        { x: g0.x, y: floorAt(a.window.until), z: g0.z, yaw: g0.yaw, reverse: false, rest: 0 },
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
        q.rest = Math.hypot(last.x - q.x, last.z - q.z) * ground.cost(q.x, q.y, q.z, q.yaw);
      }

      a.window.goals = goals;
    }

    return pieces;
  }

  /** Return the destination pose at endYaw, plus its opposite heading when eitherWay is enabled. */
  private endPoses(job: NavJob, d: NonNullable<NavQuery['drive']>): DriveGoals {
    const to = job.to;
    const facing: DriveGoal = { x: to.x, y: to.y, z: to.z, yaw: d.endYaw, reverse: false, rest: 0 };
    return d.eitherWay ? [facing, { ...facing, yaw: d.endYaw + Math.PI }] : [facing];
  }

  /**
   * Search each drive window within the deadline, then assemble the route. Replace failed windows with straight
   * fallback segments and mark the job as not drivable.
   */
  private advanceDrive(job: NavJob, S: NavSearch, deadline: number): void {
    const p = job.profile;
    const ground = S.ground as DriveGround;
    for (const piece of S.pieces as DrivePiece[]) {
      if (!('window' in piece)) {
        continue;
      }

      const w = piece.window;
      if (w.poses || w.search?.status === 'failed') {
        continue;
      }

      w.search ??= new DriveSearch(
        { ...ground, toGo: this.windowField(w, p, S) },
        p.vehicle as VehicleParams,
        w.from,
        w.goals,
        w.midway,
      );
      const before = w.search.expanded;
      const status = w.search.run(deadline);
      job.expanded += w.search.expanded - before;

      if (status === 'running') {
        return;
      }

      if (status === 'done') {
        w.poses = w.search.poses;
      }
    }

    const at = (q: { x: number; y: number; z: number }): string =>
      `(${q.x.toFixed(1)},${q.y.toFixed(1)},${q.z.toFixed(1)})`;
    job.layout = (S.pieces as DrivePiece[]).map((piece) => {
      if ('pts' in piece) {
        return `plain ${at((piece.pts[0] as RoutePoint).p)}..${at((piece.pts[piece.pts.length - 1] as RoutePoint).p)}`;
      }

      const w = piece.window;
      const r = w.goals[w.search?.reached ?? -1];
      return `window ${at(w.from)}->${r ? at(r) : 'none'} ${w.search?.status} after ${w.search?.expanded} expansions`;
    });
    const route: RoutePoint[] = [];
    let ended: DriveGoal | null = null;
    for (const piece of S.pieces as DrivePiece[]) {
      if ('pts' in piece) {
        // Resume from the rejoin goal selected by the preceding window.
        route.push(
          ...(ended
            ? [{ p: new Vector3(ended.x, ended.y, ended.z), reverse: false }, ...piece.pts.slice(1)]
            : piece.pts),
        );
        ended = null;
        continue;
      }

      const w = piece.window;
      ended = w.poses && w.search ? (w.goals[w.search.reached] ?? null) : null;

      if (w.poses) {
        route.push(...w.poses.map((q) => ({ p: new Vector3(q.x, q.y, q.z), reverse: q.reverse })));
      } else {
        // Preserve guidance through failed windows, but report that the route is not drivable.
        job.drivable = false;
        const g = w.goals[0];
        route.push(
          { p: new Vector3(w.from.x, w.from.y, w.from.z), reverse: false },
          { p: new Vector3(g.x, g.y, g.z), reverse: false },
        );
      }
    }

    this.finishRoute(job, route);
  }

  /**
   * Build a reverse Dijkstra cost field from the window's destination poses, following Dolgov's
   * holonomic-with-obstacles heuristic. Include grid costs and clearance but omit ramp direction restrictions. Return
   * Infinity for locations outside the field or unreachable from its goals.
   */
  private windowField(w: DriveWindow, p: NavProfile, S: NavSearch): (x: number, y: number, z: number) => number {
    // Include every alternative destination in the guide bounds.
    const box = w.box.slice();
    for (const q of w.goals) {
      box[0] = Math.min(box[0] as number, q.x - WINDOW_MARGIN);
      box[1] = Math.min(box[1] as number, q.z - WINDOW_MARGIN);
      box[2] = Math.max(box[2] as number, q.x + WINDOW_MARGIN);
      box[3] = Math.max(box[3] as number, q.z + WINDOW_MARGIN);
    }

    const i0 = Math.max(0, Math.floor(((box[0] as number) - this.x0) / CELL));
    const j0 = Math.max(0, Math.floor(((box[1] as number) - this.z0) / CELL));
    const i1 = Math.min(this.nx - 1, Math.floor(((box[2] as number) - this.x0) / CELL));
    const j1 = Math.min(this.nz - 1, Math.floor(((box[3] as number) - this.z0) / CELL));
    const bw = i1 - i0 + 1;
    const local = (n: number): number => {
      const c = Math.floor(n / LAYERS);
      const i = c % this.nx;
      const j = (c - i) / this.nx;
      if (i < i0 || i > i1 || j < j0 || j > j1) {
        return NONE;
      }

      return ((j - j0) * bw + (i - i0)) * LAYERS + (n % LAYERS);
    };

    const dist = new Float32Array(bw * (j1 - j0 + 1) * LAYERS).fill(Infinity);
    const done = new Uint8Array(dist.length);
    const r2 = S.relax * S.relax;
    const usable = (m: number): boolean => {
      if (this.clear(m, p)) {
        return true;
      }

      this.nodePos(m, _f);
      const near = (_f.x - S.sp.x) ** 2 + (_f.z - S.sp.z) ** 2 < r2 || (_f.x - S.gp.x) ** 2 + (_f.z - S.gp.z) ** 2 < r2;
      return near && this.clear(m, bodyOf(p));
    };

    const open = new MinHeap<number>();
    for (const q of w.goals) {
      const goal = this.nodeNear(q.x, q.y, q.z, p);
      const lg = goal === NONE ? NONE : local(goal);
      if (lg === NONE || q.rest >= (dist[lg] as number)) {
        continue;
      }

      dist[lg] = q.rest;
      open.push(goal, q.rest);
    }

    while (open.size) {
      const n = open.pop();
      const ln = local(n);
      if (done[ln]) {
        continue;
      }

      done[ln] = 1;
      const c = Math.floor(n / LAYERS);
      const i = c % this.nx;
      const j = (c - i) / this.nx;
      const gn = dist[ln] as number;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const m = this.link(n, i, j, di, dj, p, S.sid, true);
          if (m === NONE) {
            continue;
          }

          const lm = local(m);
          if (lm === NONE || done[lm] || !usable(m)) {
            continue;
          }

          // Reverse expansion uses the forward movement cost from m into n.
          const g = gn + (di && dj ? Math.SQRT2 : 1) * CELL * this.costK(n, c, -di, -dj, p);
          if (g >= (dist[lm] as number)) {
            continue;
          }

          dist[lm] = g;
          open.push(m, g);
        }
      }
    }

    return (x, y, z) => {
      const c = this.cellOf(x, z);
      const n = c === NONE ? NONE : this.surface(c, y, p.stepUp, p.height);
      const ln = n === NONE ? NONE : local(n);
      return ln === NONE ? Infinity : (dist[ln] as number);
    };
  }

  /**
   * Provide surface fit, movement cost and wall clearance queries for vehicle pose searches. Respect query blocks and
   * relax clearance and ramp alignment near route endpoints.
   */
  private driveGround(p: NavProfile, sid: number, e: Ends): DriveGround {
    const node = (x: number, y: number, z: number): number => {
      const c = this.cellOf(x, z);
      return c === NONE ? NONE : this.surface(c, y, p.stepUp, p.height);
    };

    return {
      stepUp: p.stepUp,
      fits: (x, y, z, yaw) => {
        const n = node(x, y, z);
        if (n === NONE || this.blockMark[n] === sid) {
          return null;
        }

        // Relax clearance and ramp alignment near endpoints to allow departure and parking maneuvers.
        const near = Math.hypot(x - e.sp.x, z - e.sp.z) < e.relax || Math.hypot(x - e.gp.x, z - e.gp.z) < e.relax;
        if (!this.clear(n, near ? bodyOf(p) : p)) {
          return null;
        }

        if (!this.aligned(n, yaw, near)) {
          return null;
        }

        return this.h[n] ?? null;
      },
      cost: (x, y, z, dir) => {
        const n = node(x, y, z);
        return n === NONE ? Infinity : this.costK(n, Math.floor(n / LAYERS), Math.sin(dir), Math.cos(dir), p);
      },
      toGo: () => Infinity,
      clearance: (x, y, z) => {
        const n = node(x, y, z);
        return n === NONE ? 0 : this.wallDist(n, p);
      },
    };
  }

  // ---------------------------------------------------------------- shaping

  /**
   * Return the sampled ground-following cost of a straight horizontal segment, or Infinity if it exceeds MAX_SEGMENT or
   * violates clearance, blocks, ramp alignment or step limits. Require the final surface height to match b within the
   * step limit.
   */
  private segmentCost(a: Vector3, b: Vector3, p: NavProfile, e: Ends): number {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len > MAX_SEGMENT) {
      return Infinity;
    }

    const steps = Math.max(1, Math.ceil(len / SEGMENT_STEP));
    const stepLen = len / steps;
    let y = a.y;
    let cost = 0;
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const x = a.x + dx * t;
      const z = a.z + dz * t;
      const c = this.cellOf(x, z);
      if (c === NONE) {
        return Infinity;
      }

      const node = this.surface(c, y, p.stepUp, p.height);
      if (node === NONE || this.blockMark[node] === this.sid) {
        return Infinity;
      }

      // Enforce axis alignment on the ramp surface; approaches constrain the grid search only.
      if (
        p.vehicle &&
        this.align[node] &&
        this.align[node] & Align.Ramp &&
        !this.aligned(node, Math.atan2(dx, dz), false)
      ) {
        return Infinity;
      }

      y = this.h[node] ?? y;
      const nearEnd = Math.hypot(x - e.sp.x, z - e.sp.z) < e.relax || Math.hypot(x - e.gp.x, z - e.gp.z) < e.relax;
      if (!this.clear(node, nearEnd ? bodyOf(p) : p)) {
        return Infinity;
      }

      cost += stepLen * this.costK(node, c, dx, dz, p);
    }

    return Math.abs(y - b.y) <= p.stepUp ? cost : Infinity;
  }

  /**
   * Replace successive raw path sections with the farthest valid straight segment whose cost stays within the shortcut
   * allowance. Preserve elevator landing pairs and stop shortcuts at rides.
   */
  private smooth(
    raw: Vector3[],
    cost: number[],
    p: NavProfile,
    e: Ends,
    rides: ReadonlyMap<number, unknown> | null = null,
  ): Vector3[] {
    const out: Vector3[] = [raw[0] as Vector3];
    let i = 0;
    while (i < raw.length - 1) {
      let j = i + 1;
      // Preserve consecutive elevator landings so ride intervals survive smoothing.
      while (j + 1 < raw.length && !rides?.has(i) && !rides?.has(j)) {
        const c = this.segmentCost(raw[i] as Vector3, raw[j + 1] as Vector3, p, e);
        if (c > ((cost[j + 1] ?? 0) - (cost[i] ?? 0)) * SHORTCUT_SLACK + SHORTCUT_GRACE) {
          break;
        }

        j++;
      }

      out.push(raw[j] as Vector3);
      i = j;
    }

    return out;
  }

  /**
   * Remove shallow bends and short legs when a direct segment is valid. Merge nearby corners turning in the same
   * direction at the intersection of their outer legs, provided both replacement segments remain valid.
   */
  private merge(pts: Vector3[], p: NavProfile, e: Ends): Vector3[] {
    const ok = (a: Vector3, b: Vector3): boolean => this.segmentCost(a, b, p, e) < Infinity;
    const out: Vector3[] = [pts[0] as Vector3];
    for (let k = 1; k < pts.length - 1; k++) {
      const a = out[out.length - 1] as Vector3;
      const b = pts[k] as Vector3;
      const c = pts[k + 1] as Vector3;
      const l1 = Math.hypot(b.x - a.x, b.z - a.z);
      const l2 = Math.hypot(c.x - b.x, c.z - b.z);
      const cos = l1 > EPS && l2 > EPS ? ((b.x - a.x) * (c.x - b.x) + (b.z - a.z) * (c.z - b.z)) / (l1 * l2) : 1;
      if ((cos > Math.cos(MERGE_ANGLE) || l1 < STUB_LEG || l2 < STUB_LEG) && ok(a, c)) {
        continue;
      }

      out.push(b);
    }

    out.push(pts[pts.length - 1] as Vector3);

    const stub = turnRadius(p) * STUB_FOLD;
    for (let changed = true, pass = 0; changed && pass < FOLD_PASSES; pass++) {
      changed = false;

      for (let k = 1; k + 2 < out.length; k++) {
        const a = out[k - 1] as Vector3;
        const b = out[k] as Vector3;
        const c = out[k + 1] as Vector3;
        const d = out[k + 2] as Vector3;
        if (Math.hypot(c.x - b.x, c.z - b.z) > stub) {
          continue;
        }

        const t1 = (b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x);
        const t2 = (c.x - b.x) * (d.z - c.z) - (c.z - b.z) * (d.x - c.x);
        if (t1 * t2 <= 0) {
          continue;
        }

        // Intersect the outer legs beyond b to replace both turns with one.
        const ux = b.x - a.x;
        const uz = b.z - a.z;
        const vx = d.x - c.x;
        const vz = d.z - c.z;
        const den = ux * vz - uz * vx;
        if (Math.abs(den) < EPS) {
          continue;
        }

        const s1 = ((c.x - a.x) * vz - (c.z - a.z) * vx) / den;
        if (s1 < 1) {
          continue;
        }

        const x = new Vector3(a.x + ux * s1, 0, a.z + uz * s1);
        x.y = this.heightAt(x.x, (b.y + c.y) / 2, x.z, p) ?? (b.y + c.y) / 2;

        if (!ok(a, x) || !ok(x, d)) {
          continue;
        }

        out.splice(k, 2, x);
        changed = true;
      }
    }

    return out;
  }

  /**
   * Try rounding each corner at the configured vehicle radius fractions. If these fail, append the corner index to
   * failed when supplied; otherwise try smaller radii. Retain sharp corners when no arc fits.
   */
  private corners(pts: Vector3[], p: NavProfile, e: Ends, failed?: number[]): RoutePoint[] {
    const R = turnRadius(p);
    const out: RoutePoint[] = [{ p: pts[0] as Vector3, reverse: false }];
    for (let k = 1; k < pts.length - 1; k++) {
      const a = (out[out.length - 1] as RoutePoint).p;
      const b = pts[k] as Vector3;
      const c = pts[k + 1] as Vector3;
      const l1 = Math.hypot(b.x - a.x, b.z - a.z);
      const l2 = Math.hypot(c.x - b.x, c.z - b.z);
      if (l1 < EPS || l2 < EPS) {
        out.push({ p: b, reverse: false });
        continue;
      }

      const cr: Corner = {
        a,
        b,
        c,
        l1,
        l2,
        u1x: (b.x - a.x) / l1,
        u1z: (b.z - a.z) / l1,
        u2x: (c.x - b.x) / l2,
        u2z: (c.z - b.z) / l2,
        turn: 0,
      };
      cr.turn = Math.acos(clamp(cr.u1x * cr.u2x + cr.u1z * cr.u2z, -1, 1));

      if (cr.turn < MIN_TURN) {
        out.push({ p: b, reverse: false });
        continue;
      }

      let fix: RoutePoint[] | null = null;
      for (const f of ARC_TRIES) {
        fix ??= this.arc(cr, R * f, p, e);
      }

      // Report failed turns so layout can add pose-search windows.
      if (!fix && failed) {
        failed.push(k);
      }

      for (let r = R * ARC_SHRINK; !fix && !failed && r >= R * ARC_MIN; r *= ARC_SHRINK) {
        fix = this.arc(cr, r, p, e);
      }

      out.push(...(fix ?? [{ p: b, reverse: false }]));
    }

    out.push({ p: pts[pts.length - 1] as Vector3, reverse: false });
    return out;
  }

  /**
   * Return arc samples when the available leg lengths preserve the requested radius within tolerance and all sampled
   * segments are valid; otherwise return null.
   */
  private arc(cr: Corner, r: number, p: NavProfile, e: Ends): RoutePoint[] | null {
    const { a, b, c, l1, l2, u1x, u1z, u2x, u2z, turn } = cr;
    const t = Math.min(r * Math.tan(turn / 2), l1 * LEG_SHARE, l2 * LEG_SHARE);
    const rr = t / Math.tan(turn / 2);
    // Reject arcs whose available leg lengths force the radius below tolerance.
    if (rr < r * RADIUS_TOL) {
      return null;
    }

    const p1 = new Vector3(b.x - u1x * t, b.y + (a.y - b.y) * (t / l1), b.z - u1z * t);
    const p2 = new Vector3(b.x + u2x * t, b.y + (c.y - b.y) * (t / l2), b.z + u2z * t);
    // Offset the arc center toward the inside of the turn.
    const side = u1x * u2z - u1z * u2x > 0 ? 1 : -1;
    const cx = p1.x - u1z * rr * side;
    const cz = p1.z + u1x * rr * side;
    const a0 = Math.atan2(p1.z - cz, p1.x - cx);
    const n = Math.max(2, Math.ceil((turn * rr) / ARC_SPACING));
    const pts: Vector3[] = [p1];
    for (let i = 1; i < n; i++) {
      const f = i / n;
      const ang = a0 + turn * side * f;
      pts.push(new Vector3(cx + Math.cos(ang) * rr, p1.y + (p2.y - p1.y) * f, cz + Math.sin(ang) * rr));
    }

    pts.push(p2);

    if (this.segmentCost(a, p1, p, e) === Infinity) {
      return null;
    }

    for (let i = 1; i < pts.length; i++) {
      if (this.segmentCost(pts[i - 1] as Vector3, pts[i] as Vector3, p, e) === Infinity) {
        return null;
      }
    }

    return pts.map((q) => ({ p: q, reverse: false }));
  }
}

/** Search endpoints and the distance within which vehicle clearance is reduced to body radius. */
interface Ends {
  sp: Vector3;
  gp: Vector3;
  relax: number;
}

interface Corner {
  a: Vector3;
  b: Vector3;
  c: Vector3;
  l1: number;
  l2: number;
  u1x: number;
  u1z: number;
  u2x: number;
  u2z: number;
  turn: number;
}

interface RoutePoint {
  p: Vector3;
  /** Whether travel into this point is in reverse. */
  reverse: boolean;
}

/** Split a route where its direction of travel changes; the cusp point ends one leg and starts the next. */
function toLegs(route: RoutePoint[]): RouteLeg[] {
  const legs: RouteLeg[] = [];
  let pts: Vector3[] = [(route[0] as RoutePoint).p];
  let reverse = route[1]?.reverse ?? false;
  for (let i = 1; i < route.length; i++) {
    const r = route[i] as RoutePoint;
    if (r.reverse !== reverse && pts.length >= 2) {
      legs.push({ path: new Polyline(pts), reverse });
      pts = [pts[pts.length - 1] as Vector3];
      reverse = r.reverse;
    }

    pts.push(r.p);
  }

  legs.push({ path: new Polyline(pts), reverse });
  return legs;
}

/**
 * Convert raw-path elevator rides to arc-length intervals on the smoothed route. Both landing objects must remain
 * consecutive in pts; skip rides that no longer satisfy this condition.
 */
function hopsAlong(
  pts: readonly Vector3[],
  raw: readonly Vector3[],
  rides: ReadonlyMap<number, [number, number, number]>,
): NavHop[] {
  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push((cum[i - 1] ?? 0) + (pts[i] as Vector3).distanceTo(pts[i - 1] as Vector3));
  }

  const hops: NavHop[] = [];
  for (const [k, [lift, from, to]] of rides) {
    const i = pts.indexOf(raw[k] as Vector3);
    if (i < 0 || pts[i + 1] !== raw[k + 1]) {
      continue;
    }

    hops.push({ lift, from, to, s0: cum[i] ?? 0, s1: cum[i + 1] ?? 0 });
  }

  return hops.sort((a, b) => a.s0 - b.s0);
}

export type NavStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

interface NavSearch {
  sid: number;
  start: number;
  goal: number;
  sp: Vector3;
  gp: Vector3;
  relax: number;
  hScale: number;
  /** Search bounds in world coordinates: x0, z0, x1, z1. */
  box: [number, number, number, number];
  open: MinHeap<number>;
  /** Vehicle route sections and pose-search windows, populated after the grid path is found. */
  pieces: DrivePiece[] | null;
  ground: DriveGround | null;
  /** Whether this pedestrian search may use elevator links. */
  lifts: boolean;
}

/** A route section whose vehicle poses must be found by DriveSearch. */
interface DriveWindow {
  from: DrivePose;
  goals: DriveGoals;
  /** Guide bounds in world coordinates: x0, z0, x1, z1. */
  box: [number, number, number, number];
  /** Route arc length at the first goal, in meters. */
  until: number;
  /** Whether either boundary lies inside the route rather than at a requested endpoint. */
  midway: { start: boolean; end: boolean };
  search: DriveSearch | null;
  poses: DrivePose[] | null;
}

/** An ordinary route section or a window requiring vehicle pose search. */
type DrivePiece = { pts: RoutePoint[] } | { window: DriveWindow };

/**
 * A route request with polled status. A done job provides path and legs; drivable reports whether vehicle searches
 * required fallback segments.
 */
export class NavJob {
  status: NavStatus = 'queued';
  /** Complete route polyline for guidance and pedestrian movement. */
  path: Polyline | null = null;
  /** Elevator rides along the pedestrian route, indexed by arc length. */
  hops: readonly NavHop[] = NO_HOPS;
  /** The route split into stretches driven forward or in reverse (vehicles). */
  legs: RouteLeg[] | null = null;
  /** False when a failed vehicle search is replaced by a straight fallback segment. */
  drivable = true;
  /** Debug descriptions of vehicle route sections and window searches. */
  layout: string[] = [];
  /** Accumulated search time in milliseconds. */
  ms = 0;
  expanded = 0;
  /** Search state while running (owned by NavGrid). */
  search: NavSearch | null = null;

  constructor(
    readonly from: Vector3,
    readonly to: Vector3,
    readonly profile: NavProfile,
    readonly query: NavQuery = {},
  ) {}

  get settled(): boolean {
    return this.status === 'done' || this.status === 'failed' || this.status === 'cancelled';
  }

  cancel(): void {
    if (!this.settled) {
      this.status = 'cancelled';
    }
  }
}

/**
 * Queue route requests and run them serially because searches share the grid's scratch buffers. Advance searches within
 * a per-frame time budget; individual operations may exceed it between deadline checks.
 */
export class NavPlanner {
  private readonly queue: NavJob[] = [];

  constructor(
    readonly grid: NavGrid,
    private readonly budgetMs = PLAN_BUDGET_MS,
  ) {}

  request(from: Vector3, to: Vector3, p: NavProfile, q: NavQuery = {}): NavJob {
    const job = new NavJob(from.clone(), to.clone(), p, q);
    this.queue.push(job);
    return job;
  }

  /** Spend this frame's budget. */
  update(): void {
    this.run(performance.now() + this.budgetMs, null);
  }

  /** Synchronously process queued requests through this job, including earlier requests. */
  finish(job: NavJob): NavJob {
    this.run(Infinity, job);
    return job;
  }

  private run(deadline: number, until: NavJob | null): void {
    while (this.queue.length && performance.now() < deadline) {
      const job = this.queue[0] as NavJob;
      if (job.status === 'queued') {
        this.grid.begin(job);
      }

      // Continue from grid search into vehicle pose search under the same frame deadline.
      while (job.status === 'running' && performance.now() < deadline) {
        this.grid.advance(job, deadline);
      }

      if (job.status === 'running') {
        return;
      }

      this.queue.shift();
      job.search = null;

      if (job === until) {
        return;
      }
    }
  }
}
