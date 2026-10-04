import { Vector3 } from 'three';
import { TUNING } from '@/config';
import { wrapAngle } from '@/engine/core/math';
import type { Rng } from '@/engine/core/rng';
import { type DriveGoal, type DriveGoals, type DriveGround, type DrivePose, DriveSearch } from '@/engine/nav/drive-search';
import { Polyline } from '@/engine/nav/polyline';
import type { CollisionWorld, Solid } from '@/engine/physics/collision';
import { bodyOffsets, type VehicleParams } from '@/engine/physics/vehicle-params';
import { landingPoint } from './elevator-shaft';
import type { Elevators } from './elevators';
import type { ElevatorDef, LevelData, V3, ZoneDef } from './level-data';

/** Who is moving: how much room they need and what ground they like. */
export interface NavProfile {
  readonly name: string;
  /** Clearance kept from walls and drop-offs. */
  readonly radius: number;
  /** Headroom needed above a surface. */
  readonly height: number;
  /** Biggest height change between neighbouring cells (kerbs, stairs, ramps). */
  readonly stepUp: number;
  /** Cars: everything that isn't road costs this much more. */
  readonly offRoad: number;
  /** People: street-level road costs this much more (they stay on sidewalks). */
  readonly onStreet: number;
  /** Follow traffic lane directions (cheap with the flow, expensive against it). */
  readonly lanes: boolean;
  /** Clearance it likes to keep: closer than this to a wall or drop costs more, so routes run down the middle. */
  readonly roomy: number;
  /** Extra cost at the minimum clearance (fades to none at `roomy`). */
  readonly wallCost: number;
  /** Vehicles: the physics parameters routes are shaped for (turning circle, body length). */
  readonly vehicle?: VehicleParams;
}

/** Extra room kept beyond the collision radius, so a planned line isn't a scrape. */
const MARGIN = 0.1;
/** Slack added to a vehicle's tightest circle, so a follower has steering left to correct with. */
const TURN_SLACK = 1.2;

const bodies = new Map<string, NavProfile>();

/**
 * The profile without its clearance margin, just the body: what a vehicle
 * needs near the ends of a route (pulling away from a kerb, nosing into a
 * spot) and what a moving one checks its next few metres against.
 */
export function bodyOf(p: NavProfile): NavProfile {
  const v = p.vehicle;
  if (!v) return p;
  let b = bodies.get(p.name);
  if (!b) bodies.set(p.name, (b = { ...p, name: `${p.name}:body`, radius: v.radius }));
  return b;
}

/** The circle corners are rounded to for a vehicle profile; 0 for people (corners stay sharp). */
export function turnRadius(p: NavProfile): number {
  const v = p.vehicle;
  return v ? v.wheelBase / Math.tan(v.maxSteer) + TURN_SLACK : 0;
}

/**
 * Profiles come straight from the physics tuning, so a planned route only uses
 * steps, gaps and headroom the actor can actually take.
 */
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
 * Per-plan exclusions, as the level's own region primitive (an AABB zone):
 * only surfaces inside a zone's height range are closed, so a car parked on
 * one floor doesn't block the same spot on the floors above and below.
 */
export interface NavQuery {
  /** Regions a plan must not use (parked cars, the exit lane). */
  blocks?: readonly ZoneDef[];
  /** Kept open even where a block covers it (the target spot). */
  allow?: ZoneDef;
  /**
   * Vehicles: shape the route for the car to drive it, starting at heading
   * `yaw` and ending at `endYaw` (or its reverse, with `eitherWay`): turns
   * within its turning circle, reversing where it has to.
   */
  drive?: { yaw: number; endYaw: number; eitherWay?: boolean };
  /**
   * People: may ride elevators, coming back as a NavRoute with its rides in
   * `hops`. Only for a Walker to follow: it knows how to ride (the elevators
   * take it over at a ride).
   */
  elevators?: boolean;
}

/** An elevator ride on a route: which elevator (its index in level.elevators), from stop to stop, and where along the route it gets on and off (arc length). */
export interface NavHop {
  lift: number;
  from: number;
  to: number;
  s0: number;
  s1: number;
}

/** A planned walk that rides elevators on the way: from each hop's s0 to its s1 the route goes straight up or down the shaft. */
export class NavRoute extends Polyline {
  constructor(
    points: readonly Vector3[],
    readonly hops: readonly NavHop[],
  ) {
    super(points);
  }
}

/** One stretch of a vehicle route driven in a single direction. */
export interface RouteLeg {
  path: Polyline;
  reverse: boolean;
}

// grid
const CELL = 0.5;
/** Surfaces kept per cell (ground plus slabs, ramps and stair treads above it). */
const LAYERS = 6;
const NONE = -1;
/** Margin around the level's solids. */
const GRID_PAD = 6;
/** Side of the collision-query tiles the grid is filled in. */
const TILE = 8;
/** A surface counts if at least this much room is above it (the profiles then ask for their own height). */
const MIN_ROOM = 1.2;
/** Heights this close are the same surface. */
const EPS = 0.02;
/** Surfaces within this of y=0 are the street itself (or below it, a pit's floor or stairs). */
const STREET_Y = 0.05;
/** Tolerances for snapping an arbitrary height to a surface, and for ground tilting across a body (ramps). */
const SNAP_TOL = 0.6;
const TILT_TOL = 0.15;
/** Wall distances are cached in steps of 1/WALL_RES metres. */
const WALL_RES = 10;
/**
 * A solid thinner than a cell (a guardrail panel, a post) can slip between
 * cell centers. One taller than this, so not a stair tread, blocks every cell
 * it overlaps.
 */
const THIN_WALL = 0.6;
/** Random picks spotNear makes before giving up; `anywhere` looks this far (m) round each random point it tries. */
const SPOT_TRIES = 24;
const ANYWHERE_REACH = 6;
/** Cells searched (in rings) for the nearest usable node to a point. */
const NEAR_SEARCH = 6;

// lanes
/** A lane's direction holds this far either side of its line: out to the middle of a two-lane street, where the nearest lane wins. */
const LANE_REACH = 3;
const LANE_WITH = 0.7;
const LANE_AGAINST = 4;
/** Moves this aligned (cosine) with a lane count as with or against it. */
const LANE_DOT = 0.5;
/** Lanes of different loops whose directions are neither this parallel nor this opposed (|cosine|) cross: an intersection, no preference. */
const LANE_CONFLICT = 0.7;

// ramps
/** Straight run-up vehicles take before and after a ramp mouth. */
const RUN_UP = 3;
/** Height matches for run-up floors and ramp surfaces. */
const RUN_UP_TOL = 0.3;
const RAMP_TOL = 0.1;
/** How far off a ramp's axis a vehicle may point inside its lane: the planner's rule, and a tracking car's. */
const ALIGN_SLACK = Math.sin(0.45);
const LOOSE_SLACK = Math.sin(0.7);
const enum Align {
  X = 1,
  Z = 2,
  /** On the ramp itself (not just its run-up): straight lines must follow the axis here too. */
  Ramp = 4,
}
const enum Cell {
  Asphalt = 1,
  Deck = 2,
  /** Inside a walk-in building (level.buildings): somewhere to go, not somewhere townsfolk turn up. */
  Indoors = 4,
}

// search
/** Weighted A*: a slightly greedy heuristic keeps long cross-town plans fast; smoothing tidies the result. */
const GREED = 1.6;
/** Search box: both ends plus this margin, and a bit more per metre between them. */
const SEARCH_MARGIN = 45;
const SEARCH_MARGIN_PER_M = 0.3;
/** Within this much beyond the profile's radius of either end, the body without its margin only has to fit (leaving a kerb, entering a spot). */
const RELAX_EXTRA = 1.2;
/** Expansions between deadline checks. */
const TIME_CHECK_EVERY = 256;
/** Search ids are kept below this, then the marks are cleared. */
const SID_LIMIT = 0x3ffffffe;
/** Node marks per search id: open and closed. */
const enum Mark {
  Open = 0,
  Closed = 1,
  Per = 2,
}

// shaping the route
/** Longest straight segment a shortcut may make. */
const MAX_SEGMENT = 24;
/** Shortcuts are sampled this finely (fraction of a cell). */
const SEGMENT_STEP = CELL * 0.5;
/** A shortcut may cost this much more than the stretch it replaces (proportion, plus a flat allowance). */
const SHORTCUT_SLACK = 1.03;
const SHORTCUT_GRACE = 0.25;
/** Merging: bends gentler than this (radians), or legs shorter than this, get dropped. */
const MERGE_ANGLE = 0.25;
const STUB_LEG = 1;
/** Two same-way corners joined by a stub shorter than this many turning radii fold into one. */
const STUB_FOLD = 1.5;
const FOLD_PASSES = 8;
/** Corners gentler than this (radians) stay as they are. */
const MIN_TURN = 0.12;
/** An arc may use up to this share of each leg, and must come out within RADIUS_TOL of the radius asked for. */
const LEG_SHARE = 0.48;
const RADIUS_TOL = 0.95;
/** Radii tried for a corner arc, as fractions of the turning radius; then tighter ones, shrinking by ARC_SHRINK down to ARC_MIN. */
const ARC_TRIES = [1, 0.85];
const ARC_SHRINK = 0.7;
const ARC_MIN = 0.4;
/** Spacing of the points along arcs. */
const ARC_SPACING = 1.2;

// drives
/** A drive search window reaches this many turning radii back before trouble, and on past it. */
const WINDOW_BACK = 2;
const WINDOW_AHEAD = 0.8;
/** Windows closer than this many turning radii merge (the stretch between is too short to bother with). */
const WINDOW_GAP = 1;
/** A window's guide covers the route through it (sampled every BOX_STEP) plus this margin (metres). */
const WINDOW_MARGIN = 12;
const BOX_STEP = 1;
/** Window ends move this far at a time until the car fits there, and stay this far off the route's corners (metres). */
const WINDOW_NUDGE = 0.5;
const CORNER_CLEAR = 0.3;
/** A car pointing further than this (radians) from the way out starts with a window. */
const START_SLACK = 0.35;
/** A window may end up to REJOIN_REACH turning radii along the straight after it (tried every REJOIN_STEP), short of the next turn by REJOIN_SPARE metres. */
const REJOIN_REACH = 3;
const REJOIN_STEP = 0.5;
const REJOIN_SPARE = 0.5;
/** Rounds of checking the plain stretches and opening windows on trouble. */
const LAYOUT_PASSES = 6;
/** Plain stretches are checked every this many metres. */
const CHECK_STEP = 0.5;

const PLAN_BUDGET_MS = 3;

// elevators
/** A ride costs as much as walking this far (waiting for the cab, the doors), plus this much per metre it goes up or down. */
const LIFT_WAIT = 12;
const LIFT_PER_M = 0.4;
/** A landing's node is the surface within this of its floor where riders wait. */
const LIFT_TOL = 0.1;

const _f = new Vector3();
const _g = new Vector3();

/**
 * Layered 2.5D walkability grid built from the collision world: every cell
 * holds the surfaces something could stand on (ground, slab tops, ramp tops,
 * stair treads) with the headroom above each. A* runs over (cell, surface)
 * nodes; neighbours connect when their heights differ by at most the profile's
 * step, so kerbs, ramps and stairs link up and walls and drops don't.
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
  /** Vehicles may only move along this axis here: ramp lanes and their run-ups (Align, 0 = free). */
  private readonly align: Uint8Array;
  private readonly cellFlags: Uint8Array;
  private readonly laneX: Float32Array;
  private readonly laneZ: Float32Array;
  private readonly clearance = new Map<string, Uint8Array>();
  /** Distance to the nearest wall or drop per node, in 1/WALL_RES m steps + 1 (0 = not measured yet). */
  private readonly wallDists = new Map<string, Uint8Array>();
  private readonly rings = new Map<string, Int32Array>();
  private readonly disks = new Map<string, Int32Array>();
  // search scratch, reused between plans
  private readonly g: Float32Array;
  private readonly parent: Int32Array;
  private readonly mark: Uint32Array;
  private readonly blockMark: Uint32Array;
  private sid = 0;
  /** Elevator shafts' insides: their cabs move, so nothing in one is ground to stand on (rides link the landings instead). */
  private readonly shafts: readonly ZoneDef[];
  /** Each elevator's landings as nodes, by stop (NONE while its level isn't built). */
  private readonly lifts: { def: ElevatorDef; nodes: number[] }[];
  /** The elevator stops at each landing node: [elevator, stop] pairs. */
  private readonly liftAt = new Map<number, [number, number][]>();
  /** The elevators walkers ride, once the game has built them: a Walker hands itself over to them at a ride on its route. */
  elevators: Elevators | null = null;
  /** Milliseconds the build took. */
  buildMs = 0;

  private constructor(
    x0: number,
    z0: number,
    nx: number,
    nz: number,
    /** The ramps' surfaces are read from it. */
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
    const nav = new NavGrid(x0, z0, Math.ceil((maxX + GRID_PAD - x0) / CELL), Math.ceil((maxZ + GRID_PAD - z0) / CELL), world, level.elevators ?? []);
    nav.rasterize(world, nav.x0, nav.z0, nav.x0 + nav.nx * CELL, nav.z0 + nav.nz * CELL);
    nav.flagRamps(world.solids);
    nav.flagGround(level);
    nav.rasterizeLanes(level);
    nav.linkLifts();
    nav.buildMs = performance.now() - t0;
    return nav;
  }

  // ---------------------------------------------------------------- build

  /** Is the solid inside an elevator shaft (the cab's floor, wherever it is now)? */
  private inShaft(s: Solid): boolean {
    for (const z of this.shafts) {
      if (s.min[0] >= z.min[0] - EPS && s.max[0] <= z.max[0] + EPS && s.min[2] >= z.min[2] - EPS && s.max[2] <= z.max[2] + EPS) return true;
    }
    return false;
  }

  /** Find each elevator's landings on the grid: the surface at a stop's floor where riders wait (none on a level that isn't built). */
  private linkLifts(): void {
    this.liftAt.clear();
    const at: V3 = [0, 0, 0];
    this.lifts.forEach((l, li) => {
      l.def.stops.forEach((s, si) => {
        landingPoint(l.def, si, at);
        const c = this.cellOf(at[0], at[2]);
        const node = c === NONE ? NONE : this.surface(c, s.y, LIFT_TOL, NAV.person.height);
        l.nodes[si] = node;
        if (node === NONE) return;
        let list = this.liftAt.get(node);
        if (!list) this.liftAt.set(node, (list = []));
        list.push([li, si]);
      });
    });
  }

  /** Fill the cells in x0..x1, z0..z1 (world coordinates, rounded out to whole tiles) from the solids there. */
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
              // the cell's center inside it, or for a thin wall, any of the cell
              const wall = s.max[1] - s.min[1] > THIN_WALL;
              const h = CELL / 2;
              const outX = wall && s.max[0] - s.min[0] < CELL ? cx + h <= s.min[0] || cx - h >= s.max[0] : cx < s.min[0] || cx > s.max[0];
              const outZ = wall && s.max[2] - s.min[2] < CELL ? cz + h <= s.min[2] || cz - h >= s.max[2] : cz < s.min[2] || cz > s.max[2];
              if (outX || outZ) continue;
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

  /** Standing surfaces of one cell from the solids covering it, lowest first: the ground plane (0, or a pit's floor), then solid tops. */
  private fillCell(c: number, plane: number, lo: number[], hi: number[], isRamp: boolean[], cand: number[]): void {
    cand.length = 0;
    cand.push(plane);
    for (const t of hi) if (t > plane + EPS) cand.push(t);
    cand.sort((a, b) => a - b);
    let n = 0;
    let last = -Infinity;
    for (const y of cand) {
      if (n >= LAYERS) break;
      if (y - last < EPS) continue;
      let room = Infinity;
      let inside = false;
      let fromRamp = false;
      for (let k = 0; k < lo.length; k++) {
        const l = lo[k] as number;
        const t = hi[k] as number;
        if (Math.abs(t - y) < EPS && isRamp[k]) fromRamp = true;
        if (t <= y + EPS) continue;
        if (l < y - EPS) {
          inside = true;
          break;
        }
        room = Math.min(room, l - y);
      }
      if (inside || room < MIN_ROOM) continue;
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
   * Vehicles take ramps square: on a ramp and for a run-up beyond each mouth,
   * only moves along the ramp's axis are allowed, so routes line up first and
   * make their turn on open floor where there's room for the turning circle.
   */
  private flagRamps(solids: readonly Solid[]): void {
    const world = this.world;
    for (const s of solids) {
      const r = s.ramp;
      if (!r) continue;
      const ax = r.axis === 'x' ? 0 : 2;
      const code = r.axis === 'x' ? Align.X : Align.Z;
      const lowAt = r.dir > 0 ? s.min[ax] : s.max[ax];
      const highAt = r.dir > 0 ? s.max[ax] : s.min[ax];
      const up = r.dir > 0 ? 1 : -1;
      const mark = (a0: number, a1: number, value: number, test: (y: number, cx: number, cz: number) => boolean): void => {
        const lo = Math.min(a0, a1);
        const hi = Math.max(a0, a1);
        const [x0, z0, x1, z1] = ax === 0 ? [lo, s.min[2], hi, s.max[2]] : [s.min[0], lo, s.max[0], hi];
        this.forCells(x0, z0, x1, z1, (c, cx, cz) => {
          const n = this.count[c] ?? 0;
          for (let k = 0; k < n; k++) {
            const node = c * LAYERS + k;
            if (test(this.h[node] ?? 0, cx, cz)) this.align[node] = value;
          }
        });
      };
      mark(lowAt - up * RUN_UP, lowAt, code, (y) => Math.abs(y - r.low) < RUN_UP_TOL);
      mark(highAt, highAt + up * RUN_UP, code, (y) => Math.abs(y - s.max[1]) < RUN_UP_TOL);
      mark(s.min[ax], s.max[ax], code | Align.Ramp, (y, cx, cz) => Math.abs(y - world.topAt(s, cx, cz)) < RAMP_TOL);
    }
  }

  private flagGround(level: LevelData): void {
    // drivable overlays (lots, driveways); the big ground box under the city is the street itself
    for (const b of level.boxes) {
      if (b.mat !== 'asphalt' || b.max[1] < STREET_Y) continue;
      this.forCells(b.min[0], b.min[2], b.max[0], b.max[2], (c) => (this.cellFlags[c] = (this.cellFlags[c] ?? 0) | Cell.Asphalt));
    }
    const d = level.deck;
    this.forCells(d.min[0], d.min[2], d.max[0], d.max[2], (c) => (this.cellFlags[c] = (this.cellFlags[c] ?? 0) | Cell.Deck));
    for (const b of level.buildings ?? []) this.forCells(b.min[0], b.min[2], b.max[0], b.max[2], (c) => (this.cellFlags[c] = (this.cellFlags[c] ?? 0) | Cell.Indoors));
  }

  /**
   * Traffic loops as a direction field, so planned drives keep to the right
   * side of the street: each cell takes the direction of the nearest lane
   * line within LANE_REACH. Where lanes of different loops cross (an
   * intersection) there's no preference.
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
        if (len < EPS) continue;
        const ux = dx / len;
        const uz = dz / len;
        this.forCells(Math.min(a[0], b[0]) - LANE_REACH, Math.min(a[2], b[2]) - LANE_REACH, Math.max(a[0], b[0]) + LANE_REACH, Math.max(a[2], b[2]) + LANE_REACH, (c, cx, cz) => {
          const t = Math.max(0, Math.min(len, (cx - a[0]) * ux + (cz - a[2]) * uz));
          const d = Math.hypot(cx - (a[0] + ux * t), cz - (a[2] + uz * t));
          if (d > LANE_REACH || conflict[c]) return;
          const o = owner[c] ?? NONE;
          if (o !== NONE && o !== pi && Math.abs((this.laneX[c] ?? 0) * ux + (this.laneZ[c] ?? 0) * uz) < LANE_CONFLICT) {
            conflict[c] = 1;
            this.laneX[c] = 0;
            this.laneZ[c] = 0;
            return;
          }
          if (d >= (dist[c] ?? Infinity)) return;
          dist[c] = d;
          owner[c] = pi;
          this.laneX[c] = ux;
          this.laneZ[c] = uz;
        });
      }
    });
  }

  private forCells(x0: number, z0: number, x1: number, z1: number, fn: (c: number, cx: number, cz: number) => void): void {
    const i0 = Math.max(0, Math.ceil((x0 - this.x0) / CELL - 0.5));
    const i1 = Math.min(this.nx - 1, Math.floor((x1 - this.x0) / CELL - 0.5));
    const j0 = Math.max(0, Math.ceil((z0 - this.z0) / CELL - 0.5));
    const j1 = Math.min(this.nz - 1, Math.floor((z1 - this.z0) / CELL - 0.5));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) fn(j * this.nx + i, this.x0 + (i + 0.5) * CELL, this.z0 + (j + 0.5) * CELL);
    }
  }

  // ---------------------------------------------------------------- queries

  cellOf(x: number, z: number): number {
    const i = Math.floor((x - this.x0) / CELL);
    const j = Math.floor((z - this.z0) / CELL);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) return NONE;
    return j * this.nx + i;
  }

  /** The surface node of cell c nearest to height y within tol (and with room for p), or NONE. */
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
   * A random spot where profile p can stand, between rMin and rMax of (x, z),
   * at street level (no higher than `upTo`) and, with `sidewalk`, off the
   * road and outside the deck and buildings: where townsfolk walk. Null after SPOT_TRIES misses.
   */
  spotNear(rng: Rng, x: number, z: number, rMin: number, rMax: number, p: NavProfile, upTo: number, sidewalk: boolean): Vector3 | null {
    for (let t = 0; t < SPOT_TRIES; t++) {
      const a = rng.range(0, Math.PI * 2);
      const r = rng.range(rMin, rMax);
      const c = this.cellOf(x + Math.sin(a) * r, z + Math.cos(a) * r);
      if (c === NONE || (sidewalk && (this.cellFlags[c] ?? 0) & (Cell.Deck | Cell.Indoors))) continue;
      const n = this.count[c] ?? 0;
      for (let k = 0; k < n; k++) {
        const node = c * LAYERS + k;
        const y = this.h[node] ?? 0;
        // street level and up: not down a stair shaft or in a basement
        if (y > upTo || y < -STREET_Y || (sidewalk && y < STREET_Y) || !this.clear(node, p)) continue;
        return this.nodePos(node, new Vector3());
      }
    }
    return null;
  }

  /** A random spot anywhere on the grid where profile p can stand, as spotNear (no higher than `upTo`, `sidewalk` as there). */
  anywhere(rng: Rng, p: NavProfile, upTo: number, sidewalk: boolean): Vector3 | null {
    for (let t = 0; t < SPOT_TRIES; t++) {
      const x = this.x0 + rng.range(0, this.nx * CELL);
      const z = this.z0 + rng.range(0, this.nz * CELL);
      const at = this.spotNear(rng, x, z, 0, ANYWHERE_REACH, p, upTo, sidewalk);
      if (at) return at;
    }
    return null;
  }

  /** Ground height an agent standing near (x, y, z) would be on, or null off the grid. */
  heightAt(x: number, y: number, z: number, p: NavProfile = NAV.person): number | null {
    const c = this.cellOf(x, z);
    if (c === NONE) return null;
    const node = this.surface(c, y, p.stepUp + SNAP_TOL, p.height);
    return node === NONE ? null : (this.h[node] ?? null);
  }

  /**
   * Ground height where profile p could stand with full clearance near (x, y, z),
   * or null (wall, drop, too close to either). With a heading, vehicles also
   * have to be lined up with a ramp lane they're in: by default the planner's
   * rule (ramp and run-up, within ALIGN_SLACK); `loose` checks only the ramp
   * itself with more slack, for a car that's tracking a route rather than
   * shaping one.
   */
  standable(x: number, y: number, z: number, p: NavProfile, yaw?: number, loose = false): number | null {
    const c = this.cellOf(x, z);
    if (c === NONE) return null;
    const node = this.surface(c, y, p.stepUp, p.height);
    if (node === NONE || !this.clear(node, p)) return null;
    if (yaw !== undefined && p.vehicle && !this.aligned(node, yaw, loose)) return null;
    return this.h[node] ?? null;
  }

  private aligned(node: number, yaw: number, loose: boolean): boolean {
    const al = this.align[node] ?? 0;
    if (loose && !(al & Align.Ramp)) return true;
    const slack = loose ? LOOSE_SLACK : ALIGN_SLACK;
    return !((al & Align.X && Math.abs(Math.cos(yaw)) > slack) || (al & Align.Z && Math.abs(Math.sin(yaw)) > slack));
  }

  private disk(p: NavProfile): Int32Array {
    let d = this.disks.get(p.name);
    if (d) return d;
    const r = Math.ceil(p.radius / CELL);
    const out: number[] = [];
    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) {
        if (Math.hypot(di, dj) * CELL <= p.radius + EPS) out.push(di, dj);
      }
    }
    d = Int32Array.from(out);
    this.disks.set(p.name, d);
    return d;
  }

  /** Every cell within the profile's radius has ground at a compatible height (no wall, no drop). */
  private clear(node: number, p: NavProfile): boolean {
    let cache = this.clearance.get(p.name);
    if (!cache) this.clearance.set(p.name, (cache = new Uint8Array(this.h.length)));
    const v = cache[node];
    if (v) return v === 1;
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
      if (ii < 0 || jj < 0 || ii >= this.nx || jj >= this.nz) ok = false;
      else if (this.surface(jj * this.nx + ii, y, tol, p.height) === NONE) ok = false;
    }
    cache[node] = ok ? 1 : 2;
    return ok;
  }

  /** Offsets within `roomy`, nearest first, so the wall search stops at the first hit. */
  private ring(p: NavProfile): Int32Array {
    let r = this.rings.get(p.name);
    if (r) return r;
    const n = Math.ceil(p.roomy / CELL);
    const out: [number, number, number][] = [];
    for (let dj = -n; dj <= n; dj++) {
      for (let di = -n; di <= n; di++) {
        const d = Math.hypot(di, dj) * CELL;
        if (d > p.radius && d <= p.roomy) out.push([d, di, dj]);
      }
    }
    out.sort((a, b) => a[0] - b[0]);
    r = Int32Array.from(out.flatMap(([, di, dj]) => [di, dj]));
    this.rings.set(p.name, r);
    return r;
  }

  /** How far node is from the nearest wall or drop, capped at the profile's `roomy`. */
  private wallDist(node: number, p: NavProfile): number {
    let cache = this.wallDists.get(p.name);
    if (!cache) this.wallDists.set(p.name, (cache = new Uint8Array(this.h.length)));
    const v = cache[node];
    if (v) return (v - 1) / WALL_RES;
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
      const blocked = ii < 0 || jj < 0 || ii >= this.nx || jj >= this.nz || this.surface(jj * this.nx + ii, y, tol, p.height) === NONE;
      if (blocked) {
        d = Math.hypot(r[k] ?? 0, r[k + 1] ?? 0) * CELL;
        break;
      }
    }
    cache[node] = Math.min(255, Math.round(d * WALL_RES) + 1);
    return d;
  }

  /** Cost per metre of being on node `node` (cell c) while moving along (dx, dz). */
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
        if (dot > LANE_DOT) k *= LANE_WITH;
        else if (dot < -LANE_DOT) k *= LANE_AGAINST;
      }
    }
    if (p.wallCost > 0) {
      // keep to the middle: hugging a wall costs more, which also leaves room to swing wide into turns
      const t = 1 - Math.min(1, (this.wallDist(node, p) - p.radius) / (p.roomy - p.radius));
      k *= 1 + p.wallCost * t * t;
    }
    return k;
  }

  // ---------------------------------------------------------------- search

  /** Nearest usable node to a point: its own cell first, then rings around it. */
  private nodeNear(x: number, y: number, z: number, p: NavProfile): number {
    const c = this.cellOf(x, z);
    if (c === NONE) return NONE;
    const i = c % this.nx;
    const j = (c - i) / this.nx;
    for (let r = 0; r <= NEAR_SEARCH; r++) {
      let best = NONE;
      let bd = Infinity;
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
          const ii = i + di;
          const jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= this.nx || jj >= this.nz) continue;
          const node = this.surface(jj * this.nx + ii, y, p.stepUp + SNAP_TOL, p.height);
          if (node === NONE) continue;
          const d = di * di + dj * dj;
          if (d < bd) {
            bd = d;
            best = node;
          }
        }
      }
      if (best !== NONE) return best;
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
        if (y >= z.min[1] - EPS && y <= z.max[1]) this.blockMark[node] = value;
      }
    });
  }

  private stampBlocks(q: NavQuery): void {
    for (const z of q.blocks ?? []) this.stampZone(z, this.sid);
    if (q.allow) this.stampZone(q.allow, 0);
  }

  /** Start a job's search: claims the shared scratch, so only one job may run at a time (NavPlanner). */
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
    job.search = {
      sid: this.sid,
      start,
      goal,
      sp,
      gp,
      relax: p.radius + RELAX_EXTRA,
      hScale,
      box: [Math.min(sp.x, gp.x) - margin, Math.min(sp.z, gp.z) - margin, Math.max(sp.x, gp.x) + margin, Math.max(sp.z, gp.z) + margin],
      heapN: [start],
      heapF: [sp.distanceTo(gp) * hScale],
      pieces: null,
      ground: null,
      lifts: !!job.query.elevators && !p.vehicle && this.liftAt.size > 0,
    };
    this.g[start] = 0;
    this.parent[start] = NONE;
    this.mark[start] = this.sid * Mark.Per + Mark.Open;
    job.status = 'running';
  }

  /** Work on the job until it settles or `deadline` (performance.now() time) passes. */
  advance(job: NavJob, deadline: number): void {
    const S = job.search;
    if (!S || job.status !== 'running' || S.sid !== this.sid) {
      job.status = 'failed';
      return;
    }
    const t0 = performance.now();
    if (S.pieces) this.advanceDrive(job, S, deadline);
    else this.advanceGrid(job, S, deadline);
    job.ms += performance.now() - t0;
  }

  /** The grid A*: expand nodes until the goal, or the deadline. */
  private advanceGrid(job: NavJob, S: NavSearch, deadline: number): void {
    const p = job.profile;
    const { sid, goal, sp, gp, relax, hScale, heapN, heapF } = S;
    const [bx0, bz0, bx1, bz1] = S.box;
    const r2 = relax * relax;
    const open = sid * Mark.Per + Mark.Open;
    const closed = sid * Mark.Per + Mark.Closed;
    let budget = 0;
    while (heapN.length) {
      if (++budget >= TIME_CHECK_EVERY) {
        budget = 0;
        if (performance.now() > deadline) return;
      }
      const n = this.heapPop(heapN, heapF);
      if (this.mark[n] === closed) continue;
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
        if (wz < bz0 || wz > bz1) continue;
        for (let di = -1; di <= 1; di++) {
          const wx = this.x0 + (i + di + 0.5) * CELL;
          if (wx < bx0 || wx > bx1) continue;
          const m = this.link(n, i, j, di, dj, p, sid);
          if (m === NONE || this.mark[m] === closed) continue;
          const sx = wx - sp.x;
          const sz = wz - sp.z;
          const gx = wx - gp.x;
          const gz = wz - gp.z;
          const nearEnd = sx * sx + sz * sz < r2 || gx * gx + gz * gz < r2;
          if (!this.clear(m, nearEnd ? bodyOf(p) : p)) continue;
          const g = gn + (di && dj ? Math.SQRT2 : 1) * CELL * this.costK(m, Math.floor(m / LAYERS), di, dj, p);
          if (this.mark[m] === open && g >= (this.g[m] ?? Infinity)) continue;
          this.g[m] = g;
          this.parent[m] = n;
          this.mark[m] = open;
          const gy = (this.h[m] ?? 0) - gp.y;
          this.heapPush(heapN, heapF, m, g + Math.sqrt(gx * gx + gz * gz + gy * gy) * hScale);
        }
      }
      if (S.lifts) this.rideFrom(n, S, p);
    }
    job.status = 'failed';
  }

  /** From an elevator landing, every other stop of that elevator is a ride away. */
  private rideFrom(n: number, S: NavSearch, p: NavProfile): void {
    const at = this.liftAt.get(n);
    if (!at) return;
    const open = S.sid * Mark.Per + Mark.Open;
    const closed = S.sid * Mark.Per + Mark.Closed;
    const gn = this.g[n] ?? 0;
    const yn = this.h[n] ?? 0;
    for (const [li, si] of at) {
      const nodes = this.lifts[li]?.nodes ?? [];
      for (let sj = 0; sj < nodes.length; sj++) {
        const m = nodes[sj] ?? NONE;
        if (sj === si || m === NONE || this.mark[m] === closed || this.blockMark[m] === S.sid || !this.clear(m, p)) continue;
        const ym = this.h[m] ?? 0;
        const g = gn + LIFT_WAIT + Math.abs(ym - yn) * LIFT_PER_M;
        if (this.mark[m] === open && g >= (this.g[m] ?? Infinity)) continue;
        this.g[m] = g;
        this.parent[m] = n;
        this.mark[m] = open;
        this.nodePos(m, _f);
        this.heapPush(S.heapN, S.heapF, m, g + _f.distanceTo(S.gp) * S.hScale);
      }
    }
  }

  /** Consecutive nodes of a found path that are two landings of one elevator: rides, by the index of the node they start from. */
  private ridesAlong(nodes: readonly number[]): Map<number, [number, number, number]> {
    const rides = new Map<number, [number, number, number]>();
    for (let k = 0; k + 1 < nodes.length; k++) {
      const a = this.liftAt.get(nodes[k] ?? NONE);
      const b = this.liftAt.get(nodes[k + 1] ?? NONE);
      if (!a || !b) continue;
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
   * The move from node n (cell i, j) to its neighbour (di, dj), as the node
   * it lands on, or NONE: within a step of height, outside the plan's blocks,
   * along the axis in ramp lanes and run-ups (vehicles, unless `anyWay`), and
   * no cutting corners. Clearance is the caller's call (it's relaxed near the
   * ends).
   */
  private link(n: number, i: number, j: number, di: number, dj: number, p: NavProfile, sid: number, anyWay = false): number {
    if (!di && !dj) return NONE;
    const ii = i + di;
    const jj = j + dj;
    if (ii < 0 || jj < 0 || ii >= this.nx || jj >= this.nz) return NONE;
    const y = this.h[n] ?? 0;
    const m = this.surface(jj * this.nx + ii, y, p.stepUp, p.height);
    if (m === NONE || this.blockMark[m] === sid) return NONE;
    if (p.vehicle && !anyWay) {
      const an = this.align[n] ?? 0;
      const am = this.align[m] ?? 0;
      if ((an & Align.X || am & Align.X) && dj) return NONE;
      if ((an & Align.Z || am & Align.Z) && di) return NONE;
    }
    if (di && dj) {
      const na = this.surface(j * this.nx + ii, y, p.stepUp, p.height);
      const nb = this.surface(jj * this.nx + i, y, p.stepUp, p.height);
      if (na === NONE || nb === NONE || this.blockMark[na] === sid || this.blockMark[nb] === sid) return NONE;
    }
    return m;
  }

  /** Run a job to completion now. Only safe when no planner job is mid-search (tests, tools). */
  solve(job: NavJob): NavJob {
    this.begin(job);
    while (job.status === 'running') this.advance(job, Infinity);
    return job;
  }

  /** Raw cell path from the search tree, shaped into waypoints (and, for a drive, laid out for the car). */
  private trace(job: NavJob, S: NavSearch): void {
    const nodes: number[] = [];
    for (let n = S.goal; n !== NONE; n = this.parent[n] ?? NONE) nodes.push(n);
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
      job.path = rides?.size ? new NavRoute(pts, hopsAlong(pts, raw, rides)) : new Polyline(pts);
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
      // zero-length pieces (where a window meets a plain stretch, a Dubins arc of no length) would repeat a point
      if (last && Math.hypot(r.p.x - last.p.x, r.p.z - last.p.z) < EPS && r.reverse === last.reverse) continue;
      pts.push(r);
    }
    job.path = new Polyline(pts.map((r) => r.p));
    job.legs = toLegs(pts);
    job.status = 'done';
  }

  /**
   * Lay a drive out along the shaped route (after Pinter, "Toward More
   * Realistic Pathfinding"): plain stretches of straight lines and arcs at the
   * turning radius wherever every pose along them fits, and windows where
   * they don't (a turn too tight for the floor, a ramp mouth to line up with)
   * for a drive search to fill. There's always a window into the end, which
   * has a heading, and one out of the start when the car points the wrong
   * way. Windows reach a little before and after the trouble, grow until the
   * car fits at both ends, and merge when close.
   */
  private layout(job: NavJob, S: NavSearch, line: Vector3[], ends: Ends): DrivePiece[] {
    const p = job.profile;
    const v = p.vehicle as VehicleParams;
    const d = job.query.drive as NonNullable<NavQuery['drive']>;
    const R = turnRadius(p);
    const route = new Polyline(line);
    const L = route.total;
    const at: number[] = [0];
    for (let k = 1; k < line.length; k++) at.push((at[k - 1] ?? 0) + (line[k] as Vector3).distanceTo(line[k - 1] as Vector3));
    const ground = this.driveGround(p, S.sid, ends);
    const body = bodyOffsets(v);
    // the ground along the route, followed step by step (a straight line between waypoints can be a storey off: up a ramp and on)
    const floor: number[] = [];
    for (let s = 0, y = job.from.y; s <= L + CHECK_STEP; s += CHECK_STEP) {
      route.sample(Math.min(s, L), _f);
      const c = this.cellOf(_f.x, _f.z);
      const n = c === NONE ? NONE : this.surface(c, y, p.stepUp + TILT_TOL, p.height);
      y = n === NONE ? _f.y : (this.h[n] ?? y);
      floor.push(y);
    }
    const floorAt = (s: number): number => floor[Math.min(floor.length - 1, Math.round(Math.max(0, s) / CHECK_STEP))] as number;
    const fitsAt = (x: number, y: number, z: number, yaw: number): boolean => body.every((o) => ground.fits(x + Math.sin(yaw) * o, y, z + Math.cos(yaw) * o, yaw) !== null);
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
    if (Math.abs(wrapAngle(d.yaw - Math.atan2(_g.x, _g.z))) > START_SLACK) spans.push([0, R * WINDOW_AHEAD]);
    let pieces: DrivePiece[] = [];
    for (let pass = 0; pass < LAYOUT_PASSES; pass++) {
      // tidy the spans: in range, ends where the car fits and off any corner, merged when close
      for (const sp of spans) {
        sp[0] = Math.max(0, sp[0]);
        sp[1] = Math.min(L, sp[1]);
        while (sp[0] > 0 && (at.some((a) => Math.abs(a - sp[0]) < CORNER_CLEAR) || !fitsAtS(sp[0]))) sp[0] = Math.max(0, sp[0] - WINDOW_NUDGE);
        while (sp[1] < L && !fitsAtS(sp[1])) sp[1] = Math.min(L, sp[1] + WINDOW_NUDGE);
      }
      spans.sort((a, b) => a[0] - b[0]);
      const merged: [number, number][] = [];
      for (const sp of spans) {
        const last = merged[merged.length - 1];
        if (last && sp[0] <= last[1] + R * WINDOW_GAP) last[1] = Math.max(last[1], sp[1]);
        else merged.push([sp[0], sp[1]]);
      }
      spans = merged;
      // the plain stretches between them, and anything wrong with those
      pieces = [];
      const found: number[] = [];
      let s = 0;
      for (const [s0, s1] of [...spans, [L, L] as [number, number]]) {
        if (s0 > s + EPS) {
          const pts = [poseAt(s), ...line.filter((_, k) => (at[k] ?? 0) > s + EPS && (at[k] ?? 0) < s0 - EPS), poseAt(s0)].map((q) => new Vector3(q.x, q.y, q.z));
          if (s === 0) pts[0] = job.from.clone();
          const failed: number[] = [];
          const plain = this.corners(pts, p, ends, failed);
          for (const k of failed) found.push(route.project(pts[k] as Vector3, s, s0 - s));
          const check = new Polyline(plain.map((r) => r.p));
          for (let c = CHECK_STEP, y = floorAt(s); c < check.total; c += CHECK_STEP) {
            check.sample(c, _f, _g);
            const n = this.cellOf(_f.x, _f.z);
            const m = n === NONE ? NONE : this.surface(n, y, p.stepUp + TILT_TOL, p.height);
            y = m === NONE ? y : (this.h[m] ?? y);
            if (m === NONE || !fitsAt(_f.x, y, _f.z, Math.atan2(_g.x, _g.z))) {
              found.push(route.project(_f.setY(y), s, s0 - s));
              c += R; // one report per bit of trouble
            }
          }
          pieces.push({ pts: plain });
        }
        if (s1 > s0) {
          const from = s0 <= 0 ? { x: job.from.x, y: job.from.y, z: job.from.z, yaw: d.yaw, reverse: false } : poseAt(s0);
          const goals: DriveGoals = s1 >= L ? this.endPoses(job, d) : [{ ...poseAt(s1), rest: 0 }];
          // the guide covers the route through the window, plus room to swing wide
          const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
          for (let c = s0; c <= s1 + BOX_STEP; c += BOX_STEP) {
            route.sample(Math.min(c, s1), _f);
            box[0] = Math.min(box[0], _f.x - WINDOW_MARGIN);
            box[1] = Math.min(box[1], _f.z - WINDOW_MARGIN);
            box[2] = Math.max(box[2], _f.x + WINDOW_MARGIN);
            box[3] = Math.max(box[3], _f.z + WINDOW_MARGIN);
          }
          pieces.push({ window: { from, goals, box, until: s1, midway: { start: s0 > 0, end: s1 < L }, search: null, poses: null } });
        }
        s = s1;
      }
      if (!found.length) break;
      for (const f of found) spans.push(trouble(f));
    }
    // a window may end anywhere along the straight start of the stretch after it, so the car can ease back onto the line
    for (let k = 0; k + 1 < pieces.length; k++) {
      const a = pieces[k] as DrivePiece;
      const b = pieces[k + 1] as DrivePiece;
      if (!('window' in a) || !('pts' in b) || b.pts.length < 2) continue;
      const g0 = a.window.goals[0];
      const p0 = (b.pts[0] as RoutePoint).p;
      const p1 = (b.pts[1] as RoutePoint).p;
      const straight = Math.hypot(p1.x - p0.x, p1.z - p0.z) - REJOIN_SPARE;
      const ux = (p1.x - p0.x) / (straight + REJOIN_SPARE);
      const uz = (p1.z - p0.z) / (straight + REJOIN_SPARE);
      const reach = Math.min(straight, R * REJOIN_REACH);
      // its own end, then on along the straight as far as the car fits (none further if it's too short)
      const goals: [DriveGoal, ...DriveGoal[]] = [{ x: g0.x, y: floorAt(a.window.until), z: g0.z, yaw: g0.yaw, reverse: false, rest: 0 }];
      let last = goals[0];
      for (let t = R * REJOIN_STEP; t <= reach; t += R * REJOIN_STEP) {
        const x = g0.x + ux * t;
        const z = g0.z + uz * t;
        const y = floorAt(a.window.until + t);
        if (!fitsAt(x, y, z, g0.yaw)) break;
        last = { x, y, z, yaw: g0.yaw, reverse: false, rest: 0 };
        goals.push(last);
      }
      // ending further along leaves less of the stretch to drive
      for (const q of goals) q.rest = Math.hypot(last.x - q.x, last.z - q.z) * ground.cost(q.x, q.y, q.z, q.yaw);
      a.window.goals = goals;
    }
    return pieces;
  }

  /** Where a drive ends: at the goal facing endYaw (or either way round). */
  private endPoses(job: NavJob, d: NonNullable<NavQuery['drive']>): DriveGoals {
    const to = job.to;
    const facing: DriveGoal = { x: to.x, y: to.y, z: to.z, yaw: d.endYaw, reverse: false, rest: 0 };
    return d.eitherWay ? [facing, { ...facing, yaw: d.endYaw + Math.PI }] : [facing];
  }

  /** Fill the drive's windows one search at a time, then put the route together. */
  private advanceDrive(job: NavJob, S: NavSearch, deadline: number): void {
    const p = job.profile;
    const ground = S.ground as DriveGround;
    for (const piece of S.pieces as DrivePiece[]) {
      if (!('window' in piece)) continue;
      const w = piece.window;
      if (w.poses || w.search?.status === 'failed') continue;
      w.search ??= new DriveSearch({ ...ground, toGo: this.windowField(w, p, S) }, p.vehicle as VehicleParams, w.from, w.goals, w.midway);
      const before = w.search.expanded;
      const status = w.search.run(deadline);
      job.expanded += w.search.expanded - before;
      if (status === 'running') return;
      if (status === 'done') w.poses = w.search.poses;
    }
    const at = (q: { x: number; y: number; z: number }): string => `(${q.x.toFixed(1)},${q.y.toFixed(1)},${q.z.toFixed(1)})`;
    job.layout = (S.pieces as DrivePiece[]).map((piece) => {
      if ('pts' in piece) return `plain ${at((piece.pts[0] as RoutePoint).p)}..${at((piece.pts[piece.pts.length - 1] as RoutePoint).p)}`;
      const w = piece.window;
      const r = w.goals[w.search?.reached ?? -1];
      return `window ${at(w.from)}->${r ? at(r) : 'none'} ${w.search?.status} after ${w.search?.expanded} expansions`;
    });
    const route: RoutePoint[] = [];
    let ended: DriveGoal | null = null;
    for (const piece of S.pieces as DrivePiece[]) {
      if ('pts' in piece) {
        // picks up where the window before it ended (on its first straight)
        route.push(...(ended ? [{ p: new Vector3(ended.x, ended.y, ended.z), reverse: false }, ...piece.pts.slice(1)] : piece.pts));
        ended = null;
        continue;
      }
      const w = piece.window;
      ended = w.poses && w.search ? (w.goals[w.search.reached] ?? null) : null;
      if (w.poses) {
        route.push(...w.poses.map((q) => ({ p: new Vector3(q.x, q.y, q.z), reverse: q.reverse })));
      } else {
        // no drivable way found: straight across, and the driver copes
        job.drivable = false;
        const g = w.goals[0];
        route.push({ p: new Vector3(w.from.x, w.from.y, w.from.z), reverse: false }, { p: new Vector3(g.x, g.y, g.z), reverse: false });
      }
    }
    this.finishRoute(job, route);
  }

  /**
   * A window's guide (Dolgov's holonomic-with-obstacles heuristic): the cost
   * from every node in a box around the window to its end, by Dijkstra from
   * there with the grid's own costs. Moves are free in any direction (the
   * search itself keeps ramps square). Outside the box: Infinity.
   */
  private windowField(w: DriveWindow, p: NavProfile, S: NavSearch): (x: number, y: number, z: number) => number {
    // the box, stretched to take in every place it may end
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
      if (i < i0 || i > i1 || j < j0 || j > j1) return NONE;
      return ((j - j0) * bw + (i - i0)) * LAYERS + (n % LAYERS);
    };
    const dist = new Float32Array(bw * (j1 - j0 + 1) * LAYERS).fill(Infinity);
    const done = new Uint8Array(dist.length);
    const r2 = S.relax * S.relax;
    const usable = (m: number): boolean => {
      if (this.clear(m, p)) return true;
      this.nodePos(m, _f);
      const near = (_f.x - S.sp.x) ** 2 + (_f.z - S.sp.z) ** 2 < r2 || (_f.x - S.gp.x) ** 2 + (_f.z - S.gp.z) ** 2 < r2;
      return near && this.clear(m, bodyOf(p));
    };
    const heapN: number[] = [];
    const heapF: number[] = [];
    for (const q of w.goals) {
      const goal = this.nodeNear(q.x, q.y, q.z, p);
      const lg = goal === NONE ? NONE : local(goal);
      if (lg === NONE || q.rest >= (dist[lg] as number)) continue;
      dist[lg] = q.rest;
      this.heapPush(heapN, heapF, goal, q.rest);
    }
    while (heapN.length) {
      const n = this.heapPop(heapN, heapF);
      const ln = local(n);
      if (done[ln]) continue;
      done[ln] = 1;
      const c = Math.floor(n / LAYERS);
      const i = c % this.nx;
      const j = (c - i) / this.nx;
      const gn = dist[ln] as number;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const m = this.link(n, i, j, di, dj, p, S.sid, true);
          if (m === NONE) continue;
          const lm = local(m);
          if (lm === NONE || done[lm] || !usable(m)) continue;
          // the car moves from m into n: n's cost, heading (-di, -dj)
          const g = gn + (di && dj ? Math.SQRT2 : 1) * CELL * this.costK(n, c, -di, -dj, p);
          if (g >= (dist[lm] as number)) continue;
          dist[lm] = g;
          this.heapPush(heapN, heapF, m, g);
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

  /** The ground as a drive search sees it: body fits (outside the plan's blocks, ramps taken square), costs, wall distance. */
  private driveGround(p: NavProfile, sid: number, e: Ends): DriveGround {
    const node = (x: number, y: number, z: number): number => {
      const c = this.cellOf(x, z);
      return c === NONE ? NONE : this.surface(c, y, p.stepUp, p.height);
    };
    return {
      stepUp: p.stepUp,
      fits: (x, y, z, yaw) => {
        const n = node(x, y, z);
        if (n === NONE || this.blockMark[n] === sid) return null;
        // near either end the body just has to fit, and ramps are taken loosely (leaving a kerb, nosing into a spot)
        const near = Math.hypot(x - e.sp.x, z - e.sp.z) < e.relax || Math.hypot(x - e.gp.x, z - e.gp.z) < e.relax;
        if (!this.clear(n, near ? bodyOf(p) : p)) return null;
        if (!this.aligned(n, yaw, near)) return null;
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

  private heapPush(heapN: number[], heapF: number[], n: number, f: number): void {
    let k = heapN.length;
    heapN.push(n);
    heapF.push(f);
    while (k > 0) {
      const up = (k - 1) >> 1;
      if ((heapF[up] as number) <= f) break;
      heapN[k] = heapN[up] as number;
      heapF[k] = heapF[up] as number;
      k = up;
    }
    heapN[k] = n;
    heapF[k] = f;
  }

  private heapPop(heapN: number[], heapF: number[]): number {
    const top = heapN[0] as number;
    const n = heapN.pop() as number;
    const f = heapF.pop() as number;
    if (heapN.length) {
      let k = 0;
      for (;;) {
        const l = k * 2 + 1;
        if (l >= heapN.length) break;
        const r = l + 1;
        const c = r < heapN.length && (heapF[r] as number) < (heapF[l] as number) ? r : l;
        if ((heapF[c] as number) >= f) break;
        heapN[k] = heapN[c] as number;
        heapF[k] = heapF[c] as number;
        k = c;
      }
      heapN[k] = n;
      heapF[k] = f;
    }
    return top;
  }

  // ---------------------------------------------------------------- shaping

  /**
   * Cost of going straight from a to b while keeping to the ground (each
   * sample must be within a step of the last, so a line can't hop between
   * stacked floors), or Infinity when it can't be done.
   */
  private segmentCost(a: Vector3, b: Vector3, p: NavProfile, e: Ends): number {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len > MAX_SEGMENT) return Infinity;
    const steps = Math.max(1, Math.ceil(len / SEGMENT_STEP));
    const stepLen = len / steps;
    let y = a.y;
    let cost = 0;
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const x = a.x + dx * t;
      const z = a.z + dz * t;
      const c = this.cellOf(x, z);
      if (c === NONE) return Infinity;
      const node = this.surface(c, y, p.stepUp, p.height);
      if (node === NONE || this.blockMark[node] === this.sid) return Infinity;
      // on the ramp proper straight lines follow the axis; the run-up only shapes the search
      if (p.vehicle && this.align[node] && this.align[node] & Align.Ramp && !this.aligned(node, Math.atan2(dx, dz), false)) return Infinity;
      y = this.h[node] ?? y;
      const nearEnd = Math.hypot(x - e.sp.x, z - e.sp.z) < e.relax || Math.hypot(x - e.gp.x, z - e.gp.z) < e.relax;
      if (!this.clear(node, nearEnd ? bodyOf(p) : p)) return Infinity;
      cost += stepLen * this.costK(node, c, dx, dz, p);
    }
    return Math.abs(y - b.y) <= p.stepUp ? cost : Infinity;
  }

  /**
   * String-pull the raw cell path: from each kept waypoint, reach as far along
   * the path as a straight segment can go without costing more than the
   * stretch of path it replaces (so shortcuts never cut across kerbs, planters
   * or the wrong lane).
   */
  private smooth(raw: Vector3[], cost: number[], p: NavProfile, e: Ends, rides: ReadonlyMap<number, unknown> | null = null): Vector3[] {
    const out: Vector3[] = [raw[0] as Vector3];
    let i = 0;
    while (i < raw.length - 1) {
      let j = i + 1;
      // an elevator ride's two landings stay as they are, and no shortcut runs past one
      while (j + 1 < raw.length && !rides?.has(i) && !rides?.has(j)) {
        const c = this.segmentCost(raw[i] as Vector3, raw[j + 1] as Vector3, p, e);
        if (c > ((cost[j + 1] ?? 0) - (cost[i] ?? 0)) * SHORTCUT_SLACK + SHORTCUT_GRACE) break;
        j++;
      }
      out.push(raw[j] as Vector3);
      i = j;
    }
    return out;
  }

  /**
   * Prepare corners for rounding: drop waypoints that barely bend the route (or
   * sit on stubby legs), then fold pairs of same-way corners joined by a short
   * stub into one corner where their outer legs meet, so a single wide turn can
   * use the whole floor (a U-turn at the foot of a ramp).
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
      if ((cos > Math.cos(MERGE_ANGLE) || l1 < STUB_LEG || l2 < STUB_LEG) && ok(a, c)) continue;
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
        if (Math.hypot(c.x - b.x, c.z - b.z) > stub) continue;
        const t1 = (b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x);
        const t2 = (c.x - b.x) * (d.z - c.z) - (c.z - b.z) * (d.x - c.x);
        if (t1 * t2 <= 0) continue;
        // where line a->b meets line c->d, beyond b
        const ux = b.x - a.x;
        const uz = b.z - a.z;
        const vx = d.x - c.x;
        const vz = d.z - c.z;
        const den = ux * vz - uz * vx;
        if (Math.abs(den) < EPS) continue;
        const s1 = ((c.x - a.x) * vz - (c.z - a.z) * vx) / den;
        if (s1 < 1) continue;
        const x = new Vector3(a.x + ux * s1, 0, a.z + uz * s1);
        x.y = this.heightAt(x.x, (b.y + c.y) / 2, x.z, p) ?? (b.y + c.y) / 2;
        if (!ok(a, x) || !ok(x, d)) continue;
        out.splice(k, 2, x);
        changed = true;
      }
    }
    return out;
  }

  /**
   * Round each corner into an arc at the vehicle's turning radius where the
   * legs and the ground allow it. Otherwise: with `failed`, the corner's index
   * goes there and it stays sharp (a drive's layout opens a window on it);
   * without, a tighter arc has to do (good enough to point the way).
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
      const cr: Corner = { a, b, c, l1, l2, u1x: (b.x - a.x) / l1, u1z: (b.z - a.z) / l1, u2x: (c.x - b.x) / l2, u2z: (c.z - b.z) / l2, turn: 0 };
      cr.turn = Math.acos(Math.max(-1, Math.min(1, cr.u1x * cr.u2x + cr.u1z * cr.u2z)));
      if (cr.turn < MIN_TURN) {
        out.push({ p: b, reverse: false });
        continue;
      }
      let fix: RoutePoint[] | null = null;
      for (const f of ARC_TRIES) fix ??= this.arc(cr, R * f, p, e);
      // a drive's layout wants to know (it opens a window here); otherwise tighter will have to do
      if (!fix && failed) failed.push(k);
      for (let r = R * ARC_SHRINK; !fix && !failed && r >= R * ARC_MIN; r *= ARC_SHRINK) fix = this.arc(cr, r, p, e);
      out.push(...(fix ?? [{ p: b, reverse: false }]));
    }
    out.push({ p: pts[pts.length - 1] as Vector3, reverse: false });
    return out;
  }

  /** The corner rounded into an arc of radius r, if the legs and the ground allow it. */
  private arc(cr: Corner, r: number, p: NavProfile, e: Ends): RoutePoint[] | null {
    const { a, b, c, l1, l2, u1x, u1z, u2x, u2z, turn } = cr;
    const t = Math.min(r * Math.tan(turn / 2), l1 * LEG_SHARE, l2 * LEG_SHARE);
    const rr = t / Math.tan(turn / 2);
    // short legs force a tighter arc than asked for: that's not this radius, let the caller try another way
    if (rr < r * RADIUS_TOL) return null;
    const p1 = new Vector3(b.x - u1x * t, b.y + (a.y - b.y) * (t / l1), b.z - u1z * t);
    const p2 = new Vector3(b.x + u2x * t, b.y + (c.y - b.y) * (t / l2), b.z + u2z * t);
    // arc center sits off p1 toward the inside of the turn
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
    if (this.segmentCost(a, p1, p, e) === Infinity) return null;
    for (let i = 1; i < pts.length; i++) if (this.segmentCost(pts[i - 1] as Vector3, pts[i] as Vector3, p, e) === Infinity) return null;
    return pts.map((q) => ({ p: q, reverse: false }));
  }
}

/** Ends of a search: near them only the body has to fit (bodyOf). */
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
  /** Travelled into in reverse. */
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
 * The rides on a smoothed route: `rides` maps the raw path's index where each
 * starts to [elevator, from, to]; smoothing keeps both landings, consecutive.
 */
function hopsAlong(pts: readonly Vector3[], raw: readonly Vector3[], rides: ReadonlyMap<number, [number, number, number]>): NavHop[] {
  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i++) cum.push((cum[i - 1] ?? 0) + (pts[i] as Vector3).distanceTo(pts[i - 1] as Vector3));
  const hops: NavHop[] = [];
  for (const [k, [lift, from, to]] of rides) {
    const i = pts.indexOf(raw[k] as Vector3);
    if (i < 0 || pts[i + 1] !== raw[k + 1]) continue;
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
  /** x0, z0, x1, z1 */
  box: [number, number, number, number];
  heapN: number[];
  heapF: number[];
  /** Drives: once the cell route is found, its plain stretches and the windows being searched. */
  pieces: DrivePiece[] | null;
  ground: DriveGround | null;
  /** May ride elevators (people who asked to). */
  lifts: boolean;
}

/** A stretch of a drive the plain route can't take, for a drive search to fill. */
interface DriveWindow {
  from: DrivePose;
  goals: DriveGoals;
  /** Area its guide covers: x0, z0, x1, z1. */
  box: [number, number, number, number];
  /** How far along the route it ends (at its first goal). */
  until: number;
  /** Whether it starts and ends partway along the drive (rather than at its start and goal). */
  midway: { start: boolean; end: boolean };
  search: DriveSearch | null;
  poses: DrivePose[] | null;
}

/** A drive in order: plain stretches (lines and arcs) and windows. */
type DrivePiece = { pts: RoutePoint[] } | { window: DriveWindow };

/** One route request. Poll `status`; `path` (and `legs`) are set once it's 'done'. */
export class NavJob {
  status: NavStatus = 'queued';
  /** The whole route as one line (guidance, walkers). */
  path: Polyline | null = null;
  /** The route split into stretches driven forward or in reverse (vehicles). */
  legs: RouteLeg[] | null = null;
  /** Drives: false when a stretch had no drivable shape and was left for the driver to cope with. */
  drivable = true;
  /** Drives: how the route was put together (debugging). */
  layout: string[] = [];
  /** Search time so far, summed over frames. */
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
    if (!this.settled) this.status = 'cancelled';
  }
}

/**
 * Every route request goes through here. Searches share the grid's scratch
 * buffers, so they run one at a time, a few milliseconds per frame: a long
 * cross-town drive never stalls a frame, short walks finish within one.
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

  /** Finish everything queued up to and including `job` right now (debug, tests). */
  finish(job: NavJob): NavJob {
    this.run(Infinity, job);
    return job;
  }

  private run(deadline: number, until: NavJob | null): void {
    while (this.queue.length && performance.now() < deadline) {
      const job = this.queue[0] as NavJob;
      if (job.status === 'queued') this.grid.begin(job);
      // a drive goes on from the grid search to the pose search within the same budget
      while (job.status === 'running' && performance.now() < deadline) this.grid.advance(job, deadline);
      if (job.status === 'running') return;
      this.queue.shift();
      job.search = null;
      if (job === until) return;
    }
  }
}
