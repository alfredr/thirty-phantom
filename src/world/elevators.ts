import { type BufferAttribute, BoxGeometry, Group, type Material, Mesh, Sphere, Vector3 } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import { TUNING } from '@/config';
import type { V3 } from '@/engine/core/math';
import type { RouteCursor } from '@/engine/nav/polyline';
import type { CollisionWorld, Solid } from '@/engine/physics/collision';
import { GeometryBatch, NO_TINT, whiteColors } from '@/render/geometry';
import type { MaterialLibrary, MatKey } from '@/render/materials';

import { doorPoint, facingAxis, landingPoint, LIFT, shaftCenter } from './elevator-shaft';
import type { ElevatorDef, Facing } from './level-data';
import { NavRoute, type NavHop } from './nav-grid';

/**
 * ElevatorDef describes shaft bounds and ordered stops; elevator-shaft.ts builds static geometry, while this module
 * controls moving cabins, doors, and riders. Cab floors move as collision solids. Landing collision opens only when the
 * cabin is present and its doors pass DOOR_PASS. Requests prefer reachable stops in the previous travel direction, then
 * the nearest request. Navigation routes expose elevator hops; ride() handles boarding, travel, and exit before
 * advancing the route cursor. Cody controls elevators through game/cody/cody-actions.ts. Indoor elevators simulate
 * continuously but build only their cabin and the landing nearest Cody when Interiors calls show().
 */

/** Doors this far open let people through: the doorway's solid is off and riders get on and off. */
const DOOR_PASS = 0.9;
/** The cab is at its target once it's within this (m). */
const ARRIVE = 0.002;
/** Someone this far below the cab's floor still stands in it (feet settling onto it). */
const CARRY_BELOW = 0.3;
/** Feet within this of a landing's floor are on it. */
const SAME_FLOOR = 1;
/**
 * Door-hold margin in meters on either side of the shaft wall. Approaching the current landing can reopen closing
 * doors.
 */
const DOORWAY = 0.5;
/** Maximum horizontal distance in meters from the departure landing to begin a route hop. */
const BOARD_REACH = 0.6;
/** Arrival tolerance in meters for boarding and exit movement. */
const STEP_DONE = 0.05;
/** Distance in meters indicating that another system moved a rider; cancel the stored ride. */
const RIDER_LOST = 1.5;
/** Seconds without a ride() call before discarding a rider's state. */
const RIDE_STALE = 2;
/** Rider-slot offsets from the cabin centre, oriented to the departure door as (outward, across). */
const SLOTS: readonly [number, number][] = [
  [-0.45, -0.55],
  [-0.45, 0.55],
  [0.35, 0],
];
/** The cab's walls and door panels (m thick), and a landing's door panels. */
const CAB_WALL = 0.06;
const CAB_DOOR = 0.05;
const LANDING_DOOR = 0.08;
/** The call button and the arrival lantern (m). */
const BUTTON: V3 = [0.12, 0.12, 0.04];
const LANTERN_DEPTH = 0.06;

const _p: V3 = [0, 0, 0];
const _v = new Vector3();
const _w = new Vector3();

/** Step `x` toward `to` by at most `step`. */
function approach(x: number, to: number, step: number): number {
  return x < to ? Math.min(to, x + step) : Math.max(to, x - step);
}

/** Create a white-vertex-colored box aligned with facing f, with width across the wall and depth perpendicular to it. */
function wallBox(f: Facing, across: number, h: number, depth: number): BoxGeometry {
  return whiteColors(facingAxis(f).axis === 2 ? new BoxGeometry(across, h, depth) : new BoxGeometry(depth, h, across));
}

/** The horizontal axis along a wall facing f. */
function acrossOf(f: Facing): 'x' | 'z' {
  return facingAxis(f).axis === 2 ? 'x' : 'z';
}

/**
 * Represent a pair of sliding doors as one mesh centred on the doorway. set() changes panel vertices for an opening
 * fraction from 0 to 1, skipping unchanged values.
 */
class DoorPair {
  readonly mesh: Mesh;
  /** One panel's corners, centred on the doorway. */
  private readonly panel: Float32Array;
  private readonly pos: BufferAttribute;
  private shown = -1;

  constructor(
    private readonly facing: Facing,
    private readonly width: number,
    readonly center: Vector3,
    depth: number,
    mat: Material,
    shadows = true,
  ) {
    const one = wallBox(facing, width / 2, LIFT.doorTop, depth);
    const geo = mergeGeometries([one, one]);
    this.panel = (one.getAttribute('position').array as Float32Array).slice();
    one.dispose();
    this.pos = geo.getAttribute('position') as BufferAttribute;
    // Use fixed bounds enclosing the fully open panels to avoid culling during motion.
    geo.boundingSphere = new Sphere(new Vector3(), width + LIFT.doorTop);
    this.mesh = new Mesh(geo, mat);
    this.mesh.position.copy(center);
    this.mesh.castShadow = shadows;
    this.mesh.receiveShadow = true;
    this.set(0);
  }

  set(open: number): void {
    if (open === this.shown) {
      return;
    }

    this.shown = open;
    const k = acrossOf(this.facing) === 'x' ? 0 : 2;
    const off = this.width / 4 + (open * this.width) / 2;
    const n = this.panel.length / 3;
    const a = this.pos.array as Float32Array;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 3; c++) {
        const v = this.panel[i * 3 + c] ?? 0;
        a[i * 3 + c] = c === k ? v - off : v;
        a[(n + i) * 3 + c] = c === k ? v + off : v;
      }
    }

    this.pos.needsUpdate = true;
  }
}

/** What's drawn at a landing: its doors and lights. */
interface LandingLook {
  doors: DoorPair;
  /** Lit while the cab's been called here. */
  button: Mesh;
  /** Arrival lantern, omitted indoors to avoid an additional mesh per landing. */
  lantern: Mesh | null;
}

interface Landing {
  /** Null while it isn't drawn (an indoor elevator away from Cody). */
  look: LandingLook | null;
  /** The closed doors: off while they're open with the cab here. */
  solid: Solid;
}

/** The materials the lights switch between. */
interface Lights {
  lit: Material;
  button: Material;
  lantern: Material;
}

/** One elevator: its cab, its landings' doors and lights, and where it's been called to. */
export class Elevator {
  /** Height of the cab's floor, and how fast it's moving (m/s, up positive). */
  y: number;
  v = 0;
  /** The stop it's standing at (doors open or shut), or null while it's between stops. */
  at: number | null;
  /** The stop it's heading for while it moves. */
  target: number;
  /** How far open its doors are (0..1): the cab's, and the landing's where it stands. */
  door = 0;
  /** Stops it's been called or sent to. */
  readonly requests = new Set<number>();
  /** The floor last picked on the cab's panel, until the cab gets there. */
  picked: number | null = null;
  /** The cab, moving with its floor (its origin is the middle of the shaft at floor level). */
  readonly cab = new Group();
  /** Seconds the doors stay open for. */
  private dwell = 0;
  /** The way it last moved: it keeps on that way while there are calls ahead. */
  private dir: 1 | -1 = 1;
  private readonly floor: Solid;
  private readonly landings: Landing[] = [];
  /** The cab's doors, one pair for each side a stop faces. */
  private readonly cabDoors = new Map<Facing, DoorPair>();

  constructor(
    readonly def: ElevatorDef,
    private readonly collision: CollisionWorld,
    private readonly mats: MaterialLibrary,
    private readonly lights: Lights,
    private readonly root: Group,
  ) {
    // Start at the stop nearest world Y=0.
    let home = 0;
    def.stops.forEach((s, i) => {
      if (Math.abs(s.y) < Math.abs(def.stops[home]?.y ?? Infinity)) {
        home = i;
      }
    });
    this.at = this.target = home;
    this.y = def.stops[home]?.y ?? 0;
    this.floor = collision.add([def.min[0], this.y - LIFT.floor, def.min[2]], [def.max[0], this.y, def.max[2]]);
    shaftCenter(def, 0, _p);
    this.cab.position.set(_p[0], this.y, _p[2]);
    root.add(this.cab);
    def.stops.forEach((s, i) => {
      const { axis, sign } = facingAxis(s.facing);
      // the closed doors' solid fills the doorway through the wall
      doorPoint(def, i, 0, _p);
      const half = def.door / 2;
      const lo: V3 = [_p[0], s.y, _p[2]];
      const hi: V3 = [_p[0], s.y + LIFT.doorTop, _p[2]];
      const across = axis === 2 ? 0 : 2;
      lo[across] -= half;
      hi[across] += half;
      lo[axis] = Math.min(_p[axis], _p[axis] + sign * LIFT.wall);
      hi[axis] = Math.max(_p[axis], _p[axis] + sign * LIFT.wall);
      const solid = collision.add(lo, hi);
      this.landings.push({ look: null, solid });
    });

    // Defer indoor geometry until its building activates show().
    if (!def.indoors) {
      this.buildCab();
      def.stops.forEach((_, i) => this.buildLanding(i));
    }

    this.sync();
  }

  /**
   * For indoor elevators, build the cabin and the landing nearest world height `y`, disposing other landing geometry.
   * Pass null to dispose all indoor render geometry. Non-indoor elevators are unchanged.
   */
  show(y: number | null): void {
    if (!this.def.indoors) {
      return;
    }

    const near = y === null ? -1 : this.nearestTo(y);
    if (y !== null && this.cab.children.length === 0) {
      this.buildCab();
    }

    if (y === null) {
      this.dropCab();
    }

    this.landings.forEach((l, i) => {
      if (i === near && !l.look) {
        this.buildLanding(i);
      } else if (i !== near && l.look) {
        this.dropLanding(l);
      }
    });
    this.sync();
  }

  /** Stop i's doors, call button and arrival lantern. */
  private buildLanding(i: number): void {
    const s = this.def.stops[i];
    const l = this.landings[i];
    if (!s || !l) {
      return;
    }

    const def = this.def;
    // the doors, in the middle of the wall's thickness
    doorPoint(def, i, LIFT.wall / 2, _p);
    const doors = new DoorPair(
      s.facing,
      def.door,
      new Vector3(_p[0], s.y + LIFT.doorTop / 2, _p[2]),
      LANDING_DOOR,
      this.mats.get('metalLight'),
      !def.indoors,
    );
    // the call button on its plate, beside the door
    const P = LIFT.plate;
    doorPoint(def, i, LIFT.wall + LIFT.trim + BUTTON[2] / 2, _p);
    const button = new Mesh(wallBox(s.facing, BUTTON[0], BUTTON[1], BUTTON[2]), this.lights.button);
    button.position.set(_p[0], s.y + (P.y0 + P.y1) / 2, _p[2]);
    button.position[acrossOf(s.facing)] += def.door / 2 + (P.from + P.to) / 2;
    // the arrival lantern over the door
    let lantern: Mesh | null = null;
    if (!def.indoors) {
      doorPoint(def, i, LIFT.wall + LANTERN_DEPTH / 2, _p);
      lantern = new Mesh(wallBox(s.facing, def.door, LIFT.lantern.h, LANTERN_DEPTH), this.lights.lantern);
      lantern.position.set(_p[0], s.y + LIFT.lantern.y + LIFT.lantern.h / 2, _p[2]);
      this.root.add(lantern);
    }

    this.root.add(doors.mesh, button);
    l.look = { doors, button, lantern };
  }

  private dropLanding(l: Landing): void {
    if (!l.look) {
      return;
    }

    const { doors, button, lantern } = l.look;
    for (const m of [doors.mesh, button, lantern]) {
      if (!m) {
        continue;
      }

      this.root.remove(m);
      m.geometry.dispose();
    }

    l.look = null;
  }

  private dropCab(): void {
    for (const o of [...this.cab.children]) {
      this.cab.remove(o);
      (o as Mesh).geometry?.dispose();
    }

    this.cabDoors.clear();
  }

  /** The stop whose floor is nearest height y. */
  private nearestTo(y: number): number {
    let best = 0;
    this.def.stops.forEach((s, i) => {
      if (Math.abs(s.y - y) < Math.abs(this.stopY(best) - y)) {
        best = i;
      }
    });
    return best;
  }

  /** Return the stop label, or an empty string for an invalid index. */
  label(i: number): string {
    return this.def.stops[i]?.label ?? '';
  }

  /** Return the stop's floor height, or the current cabin height for an invalid index. */
  stopY(i: number): number {
    return this.def.stops[i]?.y ?? this.y;
  }

  /** Queue a valid stop request. Ignore invalid indices. */
  call(i: number): void {
    if (this.def.stops[i]) {
      this.requests.add(i);
    }
  }

  /** Standing at stop i with the doors open enough to get on or off. */
  openAt(i: number): boolean {
    return this.at === i && this.door >= DOOR_PASS;
  }

  /**
   * Cycle the panel destination up or down from the last selection, current stop, or nearest stop, wrapping at the
   * ends. Replace the previous panel request and shorten an active door dwell to panelDelay.
   */
  pick(dir: 1 | -1): void {
    const n = this.def.stops.length;
    const i = ((this.picked ?? this.at ?? this.nearest()) + dir + n) % n;
    if (this.picked !== null && this.picked !== i) {
      this.requests.delete(this.picked);
    }

    this.picked = i;
    this.requests.add(i);

    // Shorten active dwell after a panel selection without interrupting doors already closing.
    if (this.dwell > 0) {
      this.dwell = TUNING.elevator.panelDelay;
    }
  }

  /** Test whether p lies within the cabin footprint and vertical carrying range at floor height `y`. */
  holds(p: Vector3, y = this.y): boolean {
    const { min, max } = this.def;
    return (
      p.x >= min[0] &&
      p.x <= max[0] &&
      p.z >= min[2] &&
      p.z <= max[2] &&
      p.y >= y - CARRY_BELOW &&
      p.y <= y + LIFT.cabHeight
    );
  }

  /** Test whether p is in the current landing's door-hold region. Return false while travelling between stops. */
  inDoorway(p: Vector3): boolean {
    if (this.at === null) {
      return false;
    }

    const s = this.def.stops[this.at];
    if (!s || Math.abs(p.y - s.y) > SAME_FLOOR) {
      return false;
    }

    const { axis, sign } = facingAxis(s.facing);
    const face = sign > 0 ? this.def.max[axis] : this.def.min[axis];
    const out = ((axis === 0 ? p.x : p.z) - face) * sign;
    const mid = axis === 0 ? (this.def.min[2] + this.def.max[2]) / 2 : (this.def.min[0] + this.def.max[0]) / 2;
    const across = Math.abs((axis === 0 ? p.z : p.x) - mid);
    return out > -DOORWAY && out < LIFT.wall + DOORWAY && across < this.def.door / 2;
  }

  /**
   * Advance cabin motion and doors by `dt` seconds, extending the open dwell when `held` is true. Synchronize rendering
   * and collision, then return the vertical displacement in meters.
   */
  update(dt: number, held: boolean): number {
    const E = TUNING.elevator;
    if (this.picked !== null && !this.requests.has(this.picked)) {
      this.picked = null;
    }

    const y0 = this.y;
    const at = this.at;
    if (at !== null) {
      if (this.requests.delete(at)) {
        this.dwell = Math.max(this.dwell, E.dwell);
      }

      if (this.picked === at) {
        this.picked = null;
      }

      if (held) {
        this.dwell = Math.max(this.dwell, E.hold);
      }

      this.dwell = Math.max(0, this.dwell - dt);
      this.door = approach(this.door, this.dwell > 0 ? 1 : 0, dt / E.doorTime);
      const next = this.door === 0 ? this.next(false) : null;
      if (next !== null) {
        this.target = next;
        this.at = null;
      }
    }

    if (this.at === null) {
      this.move(dt);
    }

    this.sync();
    return this.y - y0;
  }

  /** Retarget from queued requests and integrate acceleration toward the destination, braking to stop at its floor. */
  private move(dt: number): void {
    const E = TUNING.elevator;
    const next = this.next(true);
    if (next !== null) {
      this.target = next;
    }

    const goal = this.stopY(this.target);
    const d = goal - this.y;
    const want = Math.sign(d) * Math.min(E.speed, Math.sqrt(2 * E.accel * Math.abs(d)));
    this.v = approach(this.v, want, E.accel * dt);
    const step = this.v * dt;
    if (Math.abs(d) < ARRIVE || (Math.sign(step) === Math.sign(d) && Math.abs(step) >= Math.abs(d))) {
      this.y = goal;
      this.v = 0;
      this.at = this.target;
      this.requests.delete(this.target);

      if (this.picked === this.target) {
        this.picked = null;
      }

      this.dwell = E.dwell;
      return;
    }

    this.y += step;

    if (this.v !== 0) {
      this.dir = this.v > 0 ? 1 : -1;
    }
  }

  /**
   * Select the nearest requested stop ahead beyond braking distance, otherwise the nearest request in either direction.
   * Return null when there are no requests.
   */
  private next(moving: boolean): number | null {
    const brake = moving ? (this.v * this.v) / (2 * TUNING.elevator.accel) : 0;
    let best: number | null = null;
    let bd = Infinity;
    for (const i of this.requests) {
      const d = (this.stopY(i) - this.y) * this.dir;
      if (d >= brake - ARRIVE && d < bd) {
        bd = d;
        best = i;
      }
    }

    if (best !== null) {
      return best;
    }

    for (const i of this.requests) {
      const d = Math.abs(this.stopY(i) - this.y);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }

    return best;
  }

  /** The stop nearest the cab's floor. */
  private nearest(): number {
    return this.nearestTo(this.y);
  }

  /** Synchronize cabin geometry, moving floor collision, landing-door collision, and request lights. */
  private sync(): void {
    this.cab.position.y = this.y;
    this.collision.setHeight(this.floor, this.y - LIFT.floor, this.y);
    const here = this.at !== null ? this.def.stops[this.at] : undefined;
    for (const [f, pair] of this.cabDoors) {
      pair.set(here?.facing === f ? this.door : 0);
    }

    this.landings.forEach((l, i) => {
      const open = this.at === i ? this.door : 0;
      l.solid.enabled = open < DOOR_PASS;

      if (!l.look) {
        return;
      }

      l.look.doors.set(open);
      l.look.button.material = this.requests.has(i) ? this.lights.lit : this.lights.button;

      if (l.look.lantern) {
        l.look.lantern.material = this.at === i && this.door > 0 ? this.lights.lit : this.lights.lantern;
      }
    });
  }

  /**
   * Build cabin geometry and doors for all landing-facing sides. Batch by material; indoor cabins use fewer materials
   * and do not cast shadows.
   */
  private buildCab(): void {
    const mats = this.mats;
    const indoors = !!this.def.indoors;
    const { min, max } = this.def;
    const hw = (max[0] - min[0]) / 2;
    const hd = (max[2] - min[2]) / 2;
    const H = LIFT.cabHeight;
    const T = CAB_WALL;
    const batches = new Map<MatKey, GeometryBatch>();
    const box = (key: MatKey, lo: V3, hi: V3): void => {
      const mat: MatKey = !indoors
        ? key
        : key === 'linePurple' || key === 'lampGreen'
          ? 'neonGreen'
          : key === 'metalLight'
            ? 'metal'
            : key;
      let b = batches.get(mat);
      if (!b) {
        batches.set(mat, (b = new GeometryBatch()));
      }

      b.box(lo, hi, NO_TINT, 2, true);
    };

    /** A slab on side f of the cab, `a0..a1` along it, `d0..d1` in from its outside, between heights y0 and y1. */
    const onSide = (
      mat: MatKey,
      f: Facing,
      a0: number,
      a1: number,
      y0: number,
      y1: number,
      d0: number,
      d1: number,
    ): void => {
      const { axis, sign } = facingAxis(f);
      const face = sign * (axis === 0 ? hw : hd);
      const c0 = face - sign * d0;
      const c1 = face - sign * d1;
      if (axis === 2) {
        box(mat, [a0, y0, Math.min(c0, c1)], [a1, y1, Math.max(c0, c1)]);
      } else {
        box(mat, [Math.min(c0, c1), y0, a0], [Math.max(c0, c1), y1, a1]);
      }
    };

    const facings = new Set(this.def.stops.map((s) => s.facing));
    const door = this.def.door / 2;
    box('metal', [-hw, -LIFT.floor, -hd], [hw, 0, hd]);

    for (const f of ['x-', 'x+', 'z-', 'z+'] as Facing[]) {
      const ax = facingAxis(f).axis;
      // the x walls run the cab's full depth, the z walls fit between them
      const [a0, a1] = ax === 0 ? [-hd, hd] : [-hw + T, hw - T];
      if (!facings.has(f)) {
        onSide('metalLight', f, a0, a1, 0, H, 0, T);
        // a neon handrail stripe
        onSide('linePurple', f, a0 + T, a1 - T, 0.95, 1.0, T, T + 0.02);
        continue;
      }

      onSide('metalLight', f, a0, -door, 0, H, 0, T);
      onSide('metalLight', f, door, a1, 0, H, 0, T);
      onSide('metal', f, -door, door, LIFT.doorTop, H, 0, T);
      // the floor buttons, inside beside the door
      onSide('metal', f, door + 0.1, door + 0.32, 1.0, 1.45, T, T + 0.02);
      onSide('neonGreen', f, door + 0.15, door + 0.27, 1.08, 1.37, T + 0.02, T + 0.03);
      const { sign } = facingAxis(f);
      const c = new Vector3(0, LIFT.doorTop / 2, 0);
      // in the wall's plane, so they slide into it
      c[ax === 0 ? 'x' : 'z'] = sign * ((ax === 0 ? hw : hd) - T / 2);
      const pair = new DoorPair(f, this.def.door, c, CAB_DOOR, mats.get('metal'), !indoors);
      this.cab.add(pair.mesh);
      this.cabDoors.set(f, pair);
    }

    box('metal', [-hw, H, -hd], [hw, H + 0.08, hd]);
    box('lampGreen', [-0.5, H - 0.03, -0.3], [0.5, H, 0.3]);
    // the crosshead the cables hang it by
    box('metal', [-hw * 0.6, H + 0.08, -0.1], [hw * 0.6, H + 0.3, 0.1]);

    for (const [mat, b] of batches) {
      const m = new Mesh(b.build(), mats.get(mat));
      m.castShadow = !indoors && (mat === 'metal' || mat === 'metalLight');
      m.receiveShadow = true;
      this.cab.add(m);
    }
  }
}

/** Walker state and facing control needed for boarding, travel, and exit. */
export interface ElevatorRider {
  readonly pos: Vector3;
  readonly vel: Vector3;
  speed: number;
  face(p: Vector3): void;
}

/** A walker's ride: waiting for the cab, walking in, riding, walking out. */
interface Ride {
  hop: NavHop;
  /** Route cursor to advance beyond the hop after exit, if it is still the active cursor. */
  cursor: RouteCursor | null;
  phase: 'call' | 'in' | 'ride' | 'out';
  /** Where in the cab it stands (SLOTS). */
  slot: number;
  /** Last managed position, used to detect external movement. */
  at: Vector3;
  /** Seconds since ride() last updated this rider. */
  idle: number;
}

/** Manage all level elevators, direct passenger carrying, and route-based walker rides. */
export class Elevators {
  readonly root = new Group();
  readonly list: Elevator[];
  private readonly rides = new Map<ElevatorRider, Ride>();

  constructor(defs: readonly ElevatorDef[], collision: CollisionWorld, mats: MaterialLibrary) {
    this.root.name = 'elevators';
    const lights: Lights = {
      lit: mats.get('neonGreen'),
      button: mats.get('metalLight'),
      lantern: mats.get('neonPurple'),
    };
    this.list = defs.map((d) => new Elevator(d, collision, mats, lights, this.root));
  }

  /** Draw indoor elevator i's cab and the landing nearest height y, or nothing (null): see Elevator.show. */
  show(i: number, y: number | null): void {
    this.list[i]?.show(y);
  }

  /**
   * Advance elevators and discard stale rides. Hold doors for direct riders in doorways and walkers boarding or
   * exiting. Move direct rider positions by the cabin's displacement when they lie within its carrying range.
   */
  update(dt: number, riders: readonly Vector3[]): void {
    for (const [w, r] of this.rides) {
      if ((r.idle += dt) > RIDE_STALE) {
        this.rides.delete(w);
      }
    }

    for (const e of this.list) {
      let held = false;
      for (const p of riders) {
        held ||= e.inDoorway(p);
      }

      for (const r of this.rides.values()) {
        if (this.list[r.hop.lift] !== e) {
          continue;
        }

        held ||= (r.phase === 'in' && e.at === r.hop.from) || (r.phase === 'out' && e.at === r.hop.to);
      }

      const y0 = e.y;
      const dy = e.update(dt, held);
      if (dy !== 0) {
        for (const p of riders) {
          if (e.holds(p, y0)) {
            p.y += dy;
          }
        }
      }
    }
  }

  /** The elevator whose cab p is standing in, or null. */
  cabAt(p: Vector3): Elevator | null {
    for (const e of this.list) {
      if (e.holds(p)) {
        return e;
      }
    }

    return null;
  }

  /** Return the first landing within horizontal `reach` and SAME_FLOOR vertical tolerance of p, or null. */
  landingAt(p: Vector3, reach: number): { elevator: Elevator; stop: number } | null {
    for (const e of this.list) {
      for (let i = 0; i < e.def.stops.length; i++) {
        landingPoint(e.def, i, _p);

        if (Math.abs(p.y - _p[1]) < SAME_FLOOR && Math.hypot(p.x - _p[0], p.z - _p[2]) < reach) {
          return { elevator: e, stop: i };
        }
      }
    }

    return null;
  }

  /**
   * Advance a walker through a route hop: call, board, ride, then exit. Return true while controlling the walker and
   * false when no ride applies or exit completes. Advance the matching cursor beyond the hop after exit. Route changes
   * cancel waiting rides; external displacement can cancel any ride.
   */
  ride(w: ElevatorRider, cursor: RouteCursor | null, dt: number): boolean {
    let r = this.rides.get(w);
    // Cancel externally displaced riders or waiting riders whose route changed.
    if (r && (w.pos.distanceTo(r.at) > RIDER_LOST || (r.phase === 'call' && cursor !== r.cursor))) {
      this.rides.delete(w);
      r = undefined;
    }

    if (!r) {
      const hop = cursor && this.hopAt(w.pos, cursor);
      if (!hop || !cursor) {
        return false;
      }

      r = { hop, cursor, phase: 'call', slot: 0, at: w.pos.clone(), idle: 0 };
      this.rides.set(w, r);
    }

    r.idle = 0;
    const e = this.list[r.hop.lift];
    if (!e) {
      this.rides.delete(w);
      return false;
    }

    const { from, to } = r.hop;
    switch (r.phase) {
      case 'call':
        // to the landing, then wait for the cab facing the door
        e.call(from);

        if (this.walkTo(w, _v.fromArray(landingPoint(e.def, from, _p)), dt)) {
          w.face(_w.fromArray(doorPoint(e.def, from, 0, _p)));
          // Wait at the landing until a cabin slot becomes available.
          const slot = e.openAt(from) ? this.freeSlot(e) : null;
          if (slot !== null) {
            r.slot = slot;
            r.phase = 'in';
          }
        }

        break;
      case 'in':
        if (this.walkTo(w, this.slotPoint(e, from, r.slot, _v), dt)) {
          w.face(_w.fromArray(doorPoint(e.def, from, 0, _p)));
          r.phase = 'ride';
        }

        break;
      case 'ride':
        e.call(to);
        w.pos.copy(this.slotPoint(e, from, r.slot, _v)).setY(e.y);
        w.vel.set(0, 0, 0);
        w.speed = 0;

        if (e.openAt(to)) {
          r.phase = 'out';
        }

        break;
      case 'out':
        if (this.walkTo(w, _v.fromArray(landingPoint(e.def, to, _p)), dt)) {
          this.rides.delete(w);

          // Resume only the cursor that originally requested this hop.
          if (cursor && cursor === r.cursor) {
            cursor.s = r.hop.s1;
          }

          return false;
        }

        break;
    }

    r.at.copy(w.pos);
    return true;
  }

  /**
   * Return the next uncompleted route hop when the cursor and walker are close enough to its departure landing, or
   * null.
   */
  private hopAt(pos: Vector3, cursor: RouteCursor): NavHop | null {
    const path = cursor.path;
    if (!(path instanceof NavRoute)) {
      return null;
    }

    for (const h of path.hops) {
      if (h.s1 <= cursor.s) {
        continue;
      }

      if (cursor.s < h.s0 - BOARD_REACH) {
        return null;
      }

      const e = this.list[h.lift];
      if (!e) {
        return null;
      }

      landingPoint(e.def, h.from, _p);
      return Math.abs(pos.y - _p[1]) < SAME_FLOOR && Math.hypot(pos.x - _p[0], pos.z - _p[2]) < BOARD_REACH ? h : null;
    }

    return null;
  }

  /** Return the first cabin slot not occupied by a boarding, riding, or exiting walker, or null when full. */
  private freeSlot(e: Elevator): number | null {
    for (let k = 0; k < SLOTS.length; k++) {
      let taken = false;
      for (const r of this.rides.values()) {
        taken ||= this.list[r.hop.lift] === e && r.phase !== 'call' && r.slot === k;
      }

      if (!taken) {
        return k;
      }
    }

    return null;
  }

  /** Write slot k's cabin position into `out`, oriented to stop i's door and at the current floor height. Return `out`. */
  private slotPoint(e: Elevator, i: number, k: number, out: Vector3): Vector3 {
    const s = e.def.stops[i];
    const [inward, across] = SLOTS[k] ?? [0, 0];
    shaftCenter(e.def, e.y, _p);
    out.fromArray(_p);

    if (!s) {
      return out;
    }

    const { axis, sign } = facingAxis(s.facing);
    if (axis === 0) {
      out.set(out.x + sign * inward, out.y, out.z + across);
    } else {
      out.set(out.x + across, out.y, out.z + sign * inward);
    }

    return out;
  }

  /**
   * Move w directly toward p at boarding speed, setting its height to p.y. Return true after snapping to the
   * destination and stopping.
   */
  private walkTo(w: ElevatorRider, p: Vector3, dt: number): boolean {
    const dx = p.x - w.pos.x;
    const dz = p.z - w.pos.z;
    const d = Math.hypot(dx, dz);
    const pace = TUNING.elevator.boardPace;
    if (d <= Math.max(STEP_DONE, pace * dt)) {
      w.pos.copy(p);
      w.vel.set(0, 0, 0);
      w.speed = 0;
      return true;
    }

    w.vel.set((dx / d) * pace, 0, (dz / d) * pace);
    w.pos.set(w.pos.x + w.vel.x * dt, p.y, w.pos.z + w.vel.z * dt);
    w.speed = pace;
    w.face(p);
    return false;
  }
}
