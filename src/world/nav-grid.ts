import { Vector3 } from 'three';

import { TUNING } from '@/config';
import { clamp, TAU } from '@/engine/core/math';
import { MinHeap } from '@/engine/core/min-heap';
import type { Rng } from '@/engine/core/rng';
import { type DriveBounds, DrivePlan } from '@/engine/nav/drive-plan';
import type { DriveGoal, DriveGoals, DriveGround, DrivePose } from '@/engine/nav/drive-search';
import { Polyline } from '@/engine/nav/polyline';
import { ROUTE_EPS, RouteShaper, type RouteLeg, type RoutePoint, toLegs } from '@/engine/nav/route-shaper';
import type { CollisionWorld, Solid } from '@/engine/physics/collision';
import type { VehicleParams } from '@/engine/physics/vehicle-params';

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
const PLAN_BUDGET_MS = 3;

// elevators
/** Elevator cost expressed as equivalent walking distance: a fixed waiting cost plus a cost per vertical meter. */
const LIFT_WAIT = 12;
const LIFT_PER_M = 0.4;
/** Maximum height difference between a stop and its landing node, in meters. */
const LIFT_TOL = 0.1;

const _f = new Vector3();

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
      drive: null,
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
    if (S.drive) {
      const before = S.drive.expanded;
      const route = S.drive.advance(deadline);
      job.expanded += S.drive.expanded - before;

      if (route) {
        job.drivable = S.drive.drivable;
        job.layout = S.drive.layout;
        this.finishRoute(job, route);
      }
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
    const shape = new RouteShaper(turnRadius(p), {
      cost: (a, b) => this.segmentCost(a, b, p, ends),
      heightAt: (x, y, z) => this.heightAt(x, y, z, p),
    });
    const pts = shape.smooth(raw, cost, rides);
    if (!p.vehicle) {
      job.path = new Polyline(pts);
      job.hops = rides?.size ? hopsAlong(pts, raw, rides, job.path.distances) : NO_HOPS;
      job.legs = [{ path: job.path, reverse: false }];
      job.status = 'done';
      return;
    }

    const line = shape.merge(pts);
    const d = job.query.drive;
    if (d) {
      const from: DrivePose = { x: job.from.x, y: job.from.y, z: job.from.z, yaw: d.yaw, reverse: false };
      const goal: DriveGoal = { x: job.to.x, y: job.to.y, z: job.to.z, yaw: d.endYaw, reverse: false, rest: 0 };
      S.drive = new DrivePlan(
        line,
        shape,
        {
          ground: this.driveGround(p, S.sid, ends),
          heightAt: (x, y, z) => {
            const c = this.cellOf(x, z);
            const n = c === NONE ? NONE : this.surface(c, y, p.stepUp + TILT_TOL, p.height);
            return n === NONE ? null : (this.h[n] ?? null);
          },
          guide: (bounds, goals) => this.windowField(bounds, goals, p, S),
        },
        { vehicle: p.vehicle, from, goals: d.eitherWay ? [goal, { ...goal, yaw: d.endYaw + Math.PI }] : [goal] },
      );
      return;
    }

    this.finishRoute(job, shape.corners(line));
  }

  private finishRoute(job: NavJob, route: RoutePoint[]): void {
    const pts: RoutePoint[] = [];
    for (const r of route) {
      const last = pts[pts.length - 1];
      // Adjacent route sections can repeat a boundary point without adding travel.
      if (last && Math.hypot(r.p.x - last.p.x, r.p.z - last.p.z) < ROUTE_EPS && r.reverse === last.reverse) {
        continue;
      }

      pts.push(r);
    }

    job.path = new Polyline(pts.map((r) => r.p));
    job.legs = toLegs(pts);
    job.status = 'done';
  }

  /**
   * Build a reverse Dijkstra cost field from the window's destination poses, following Dolgov's
   * holonomic-with-obstacles heuristic. Include grid costs and clearance but omit ramp direction restrictions. Return
   * Infinity for locations outside the field or unreachable from its goals.
   */
  private windowField(box: DriveBounds, goals: DriveGoals, p: NavProfile, S: NavSearch): DriveGround['toGo'] {
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
    for (const q of goals) {
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
}

/** Search endpoints and the distance within which vehicle clearance is reduced to body radius. */
interface Ends {
  sp: Vector3;
  gp: Vector3;
  relax: number;
}

/**
 * Convert raw-path elevator rides to arc-length intervals on the smoothed route. Both landing objects must remain
 * consecutive in pts; skip rides that no longer satisfy this condition.
 */
function hopsAlong(
  pts: readonly Vector3[],
  raw: readonly Vector3[],
  rides: ReadonlyMap<number, [number, number, number]>,
  distances: readonly number[],
): NavHop[] {
  const hops: NavHop[] = [];
  for (const [k, [lift, from, to]] of rides) {
    const i = pts.indexOf(raw[k] as Vector3);
    if (i < 0 || pts[i + 1] !== raw[k + 1]) {
      continue;
    }

    hops.push({ lift, from, to, s0: distances[i] ?? 0, s1: distances[i + 1] ?? 0 });
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
  /** Vehicle maneuvers planned after the grid path is found. */
  drive: DrivePlan | null;
  /** Whether this pedestrian search may use elevator links. */
  lifts: boolean;
}

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
