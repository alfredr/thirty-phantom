import { Group, Vector3 } from 'three';

import { Gait } from '@/actors/models/person';
import type { CharacterRig } from '@/actors/models/rig';
import { buildSkeleton } from '@/actors/models/skeleton';
import { clamp, damp, dampAngle, TAU, type V3 } from '@/engine/core/math';
import { RouteCursor } from '@/engine/nav/polyline';
import type { CollisionWorld } from '@/engine/physics/collision';
import type { Claims } from '@/engine/sim/claims';
import { type EventOf, Mind, mind, type MindEvent, type State, type StateOf } from '@/engine/sim/mind';
import type { ClaimKind } from '@/game/rules/claim-kinds';
import { NAV, type NavGrid, type NavJob, type NavPlanner } from '@/world/nav-grid';

/** Victim queries and attacks through opaque handles. A target remains usable while victimAt() succeeds. */
export interface Prey {
  /**
   * Return the nearest living victim within horizontal `reach` and vertical `sameLevel`, both in meters, that passes
   * `may`; otherwise return null.
   */
  victimNear(at: Vector3, reach: number, sameLevel: number, may: (v: object) => boolean): object | null;
  /** Write the victim’s current position into `out`; return false when dead or absent. */
  victimAt(v: object, out: Vector3): boolean;
  /** Apply an attack and report whether the victim was hit, knocked down, or killed. */
  maul(v: object, from: Vector3, damage: number): 'hit' | 'downed' | 'killed';
}

/** Vehicle geometry and motion used for three-circle skeleton collision checks. */
export interface SkeletonCrusher {
  readonly pos: Vector3;
  readonly vel: Vector3;
  readonly yaw: number;
  readonly params: { readonly radius: number; readonly length: number; readonly height: number };
  readonly gone: boolean;
}

/** Population cap, maximum count per summon, and summon cooldown in seconds. */
const MAX = 9;
const PER_SUMMON = 3;
const SUMMON_EVERY = 4;
/** Spawn radius range in meters, rise duration in seconds, and starting burial depth in meters. */
const RING: readonly [number, number] = [1.6, 3.4];
const RISE = 1.3;
const BURIED = 1.9;
/** Hunting radius and vertical tolerance in meters, followed by retarget interval in seconds. */
const HUNT = 26;
const SAME_LEVEL = 2.5;
const RETARGET = 0.6;
/** Walking pace in m/s and following thresholds in meters. Start returning beyond HEEL[1] and stop inside HEEL[0]. */
const PACE = 4.3;
const HEEL: readonly [number, number] = [4, 7];
/** Collision radius, height, and maximum step height, in meters. */
const RADIUS = 0.35;
const HEIGHT = 1.8;
const STEP = 0.5;
/** Attack reach in meters, interval in seconds, and damage range. */
const REACH = 1.05;
const SWING_EVERY = 0.8;
const DAMAGE: readonly [number, number] = [22, 34];
/** Initial health, vehicle damage per m/s of impact, and minimum damaging speed in m/s. */
const HEALTH = 100;
const CAR_DAMAGE = 9;
const CAR_MIN = 3;
/** Vehicle knockback distance in meters and stagger duration in seconds. */
const KNOCK = 1.4;
const STAGGER = 0.6;
/** Maximum distance from the summoner before removal, in meters. */
const STRAY = 95;
/** Route refresh interval while obstructed, in seconds. */
const REPLAN = 1.5;
/**
 * Separation ranges in meters, steering weight, and idle separation pace in m/s. Skeletons sharing a target use the
 * smaller CROWD range.
 */
const SPREAD = 3.5;
const CROWD = 1.1;
const APART = 1.2;
const AMBLE = 1.1;
/** Minimum spacing force that triggers idle movement, to avoid jitter. */
const SETTLED = 0.02;

/** Skeleton animation and behavior states. */
type Undead =
  /** Rise from the ground; negative elapsed seconds stagger the start times. */
  | State<'rising', { t: number }>
  /** Hunt victims or follow the summoner. */
  | State<'hunting'>
  /** Pause hunting for `t` seconds after a vehicle hit. */
  | State<'staggered', { t: number }>;

/** Events accepted by skeleton behavior. */
type UndeadEvent =
  /** Stagger for the supplied duration in seconds after a vehicle impact. */
  MindEvent<'struck', { t: number }>;

const stagger = (_s: Skeleton, _st: Undead, { t }: EventOf<UndeadEvent, 'struck'>): StateOf<Undead, 'staggered'> => ({
  at: 'staggered',
  t,
});

/** Rise, hunt, and temporarily stagger after vehicle impacts. */
const SKELETON_MIND = mind<Skeleton, Undead, UndeadEvent>({
  rising: {
    tick: (s, st, dt) => (s.pack.rise(s, st, dt) ? { at: 'hunting' } : null),
  },
  hunting: {
    tick: (s, _st, dt) => {
      s.pack.hunt(s, dt);
      return null;
    },
    on: { struck: stagger },
  },
  staggered: {
    tick: (s, st, dt) => {
      st.t -= dt;
      s.speed = damp(s.speed, 0, 6, dt);
      return st.t <= 0 ? { at: 'hunting' } : null;
    },
    on: { struck: stagger },
  },
});

/** One summoned skeleton’s movement, targeting, and animation state. */
class Skeleton {
  readonly mind: Mind<Skeleton, Undead, UndeadEvent>;
  readonly gait = new Gait();
  speed = 0;
  hp = HEALTH;
  /** Current quarry and remaining retarget delay in seconds. */
  target: object | null = null;
  retarget = 0;
  /** Remaining attack animation and cooldown time in seconds. */
  swing = 0;
  /** Whether the skeleton is returning to the summoner under HEEL thresholds. */
  heeling = false;
  /** Pending route, active cursor, and remaining replanning delay. */
  job: NavJob | null = null;
  route: RouteCursor | null = null;
  replan = 0;

  constructor(
    readonly pack: Skeletons,
    readonly rig: CharacterRig,
    readonly pos: Vector3,
    public yaw: number,
  ) {
    this.mind = new Mind<Skeleton, Undead, UndeadEvent>(SKELETON_MIND, this, {
      at: 'rising',
      t: -Math.random() * 0.35,
    });
  }
}

const _goal = new Vector3();
const _step = new Vector3();
/** Reusable separation vector populated by spacing(). */
const _sep = new Vector3();
const _p: V3 = [0, 0, 0];
const _a: V3 = [0, 0, 0];
const _b: V3 = [0, 0, 0];

/**
 * Spawn skeletons, acquire victims, and navigate or attack them. Optional quarry claims limit attackers per victim.
 * Skeletons follow the summoner without prey, take damage from vehicles, and report kills and removal for effects.
 */
export class Skeletons {
  readonly root = new Group();
  /** Current skeleton position references, refreshed every update. */
  readonly threats: Vector3[] = [];
  /** Notify effects when a skeleton begins rising. */
  onRise: ((at: Vector3) => void) | null = null;
  /** Notify effects when a skeleton is removed. */
  onCrumble: ((at: Vector3) => void) | null = null;
  /** Notify effects at the position of a killed victim. */
  onKill: ((at: Vector3) => void) | null = null;

  private readonly list: Skeleton[] = [];
  private cooldown = 0;
  /** Current following target; null disables following but still permits hunting and spacing. */
  private master: Vector3 | null = null;

  constructor(
    private readonly world: CollisionWorld,
    private readonly nav: NavGrid,
    private readonly planner: NavPlanner,
    private readonly prey: Prey | null,
    /** Optional quarry reservations that limit attackers per victim. */
    private readonly claims: Claims<ClaimKind> | null = null,
  ) {}

  get count(): number {
    return this.list.length;
  }

  /**
   * Attempt to spawn skeletons near `at` and return the count. Return zero during cooldown, at capacity, or when no
   * valid positions are found.
   */
  summon(at: Vector3, yaw: number): number {
    if (this.cooldown > 0 || this.list.length >= MAX) {
      return 0;
    }

    this.cooldown = SUMMON_EVERY;
    let n = 0;
    for (let k = 0; k < PER_SUMMON && this.list.length < MAX; k++) {
      // Try positions ahead of the summoner before trying behind.
      for (let tries = 0; tries < 6; tries++) {
        const a = yaw + (k - (PER_SUMMON - 1) / 2) * 0.9 + (Math.random() - 0.5) * 0.6 + (tries > 2 ? Math.PI : 0);
        const r = RING[0] + Math.random() * (RING[1] - RING[0]);
        const x = at.x + Math.sin(a) * r;
        const z = at.z + Math.cos(a) * r;
        const y = this.nav.standable(x, at.y, z, NAV.person);
        if (y === null || this.crowded(x, y, z)) {
          continue;
        }

        this.add(new Vector3(x, y, z), a);
        n++;
        break;
      }
    }

    return n;
  }

  /** Remove all skeletons and emit their crumble callbacks. */
  crumbleAll(): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      this.crumble(i);
    }
  }

  /**
   * @param master Following target when no prey is available; null disables following.
   * @param cars Vehicles checked for damaging contact.
   */
  update(dt: number, master: Vector3 | null, cars: readonly SkeletonCrusher[]): void {
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.master = master;
    this.threats.length = 0;

    for (let i = this.list.length - 1; i >= 0; i--) {
      const s = this.list[i];
      if (!s) {
        continue;
      }

      if (master && s.pos.distanceTo(master) > STRAY) {
        this.crumble(i);
        continue;
      }

      // Rising skeletons are immune to vehicle contacts.
      if (!s.mind.in('rising')) {
        this.runOver(s, cars);

        if (s.hp <= 0) {
          this.crumble(i);
          continue;
        }
      }

      s.mind.tick(dt);
      this.threats.push(s.pos);
    }

    this.unstack();

    for (const s of this.list) {
      if (!s.mind.in('rising')) {
        this.pose(s, dt);
      }
    }
  }

  private add(pos: Vector3, yaw: number): void {
    const rig = buildSkeleton();
    rig.root.position.set(pos.x, pos.y - BURIED, pos.z);
    rig.root.rotation.y = yaw;
    this.root.add(rig.root);
    this.list.push(new Skeleton(this, rig, pos, yaw));
  }

  /** Test spawn spacing against existing skeletons on the same level. */
  private crowded(x: number, y: number, z: number): boolean {
    for (const o of this.list) {
      const dx = o.pos.x - x;
      const dz = o.pos.z - z;
      if (Math.abs(o.pos.y - y) < SAME_LEVEL && dx * dx + dz * dz < CROWD * CROWD) {
        return true;
      }
    }

    return false;
  }

  /** Advance the emergence animation and notify effects at its start. Return true when fully above ground. */
  rise(s: Skeleton, st: { t: number }, dt: number): boolean {
    const was = st.t;
    st.t += dt;

    if (was < 0 && st.t >= 0) {
      this.onRise?.(s.pos);
    }

    const k = clamp(st.t / RISE, 0, 1);
    const ease = 1 - (1 - k) * (1 - k);
    const r = s.rig;
    r.root.position.set(s.pos.x + Math.sin(st.t * 40) * 0.03 * (1 - k), s.pos.y - BURIED * (1 - ease), s.pos.z);
    r.root.rotation.y = s.yaw;

    r.armL.rotation.x = -2.6 + Math.sin(st.t * 12) * 0.5 * (1 - k);
    r.armR.rotation.x = -2.6 + Math.cos(st.t * 12) * 0.5 * (1 - k);

    if (k < 1) {
      return false;
    }

    r.armL.rotation.x = 0;
    r.armR.rotation.x = 0;
    return true;
  }

  /** Allow the existing quarry or a target with available reservation capacity. */
  private canHunt(s: Skeleton, v: object): boolean {
    return v === s.target || !this.claims || this.claims.free('quarry', v);
  }

  /** Release the quarry claim and discard its route. */
  private letGo(s: Skeleton): void {
    if (s.target) {
      this.claims?.drop('quarry', s, s.target);
    }

    s.target = null;
    this.drop(s);
  }

  /** Select an eligible victim, attack within reach, or follow the summoner when no victim is available. */
  hunt(s: Skeleton, dt: number): void {
    const master = this.master;
    s.retarget -= dt;
    s.swing = Math.max(0, s.swing - dt);

    if (this.prey && (s.retarget <= 0 || !s.target)) {
      s.retarget = RETARGET;
      const v = this.prey.victimNear(s.pos, HUNT, SAME_LEVEL, (o) => this.canHunt(s, o));
      if (v !== s.target) {
        this.letGo(s);

        if (v) {
          this.claims?.take('quarry', s, v, { owner: s });
        }

        s.target = v;
      }
    }

    let goal: Vector3 | null = null;
    if (s.target && this.prey?.victimAt(s.target, _goal)) {
      goal = _goal;
    } else if (s.target) {
      this.letGo(s);
    }

    if (goal && s.target && this.prey) {
      const d = Math.hypot(goal.x - s.pos.x, goal.z - s.pos.z);
      if (d < REACH) {
        s.yaw = dampAngle(s.yaw, Math.atan2(goal.x - s.pos.x, goal.z - s.pos.z), 12, dt);
        s.speed = damp(s.speed, 0, 10, dt);

        if (s.swing <= 0) {
          s.swing = SWING_EVERY;
          const hurt = this.prey.maul(s.target, s.pos, DAMAGE[0] + Math.random() * (DAMAGE[1] - DAMAGE[0]));
          if (hurt === 'killed') {
            this.onKill?.(goal);
            this.letGo(s);
          }
        }

        return;
      }
    } else if (master) {
      // Use separate start and stop distances to avoid oscillating near Cody.
      const d = Math.hypot(master.x - s.pos.x, master.z - s.pos.z);
      if (d > HEEL[1]) {
        s.heeling = true;
      } else if (d < HEEL[0]) {
        s.heeling = false;
      }

      if (s.heeling) {
        goal = master;
      }
    }

    if (!goal) {
      // Apply only separation movement when there is no target.
      const push = this.spacing(s);
      if (push > SETTLED) {
        this.walk(s, _sep.x, _sep.z, AMBLE * Math.min(1, push * 2), dt);
      } else {
        s.speed = damp(s.speed, 0, 6, dt);
      }

      return;
    }

    this.go(s, goal, dt);
  }

  /** Move toward the goal, requesting routes around obstructions or height changes and blending in separation. */
  private go(s: Skeleton, goal: Vector3, dt: number): void {
    _a[0] = s.pos.x;
    _a[1] = s.pos.y + 1;
    _a[2] = s.pos.z;
    _b[0] = goal.x;
    _b[1] = goal.y + 1;
    _b[2] = goal.z;
    let to: Vector3 = goal;
    if (this.world.segmentBlocked(_a, _b) || Math.abs(goal.y - s.pos.y) > STEP) {
      s.replan -= dt;

      if (s.job?.settled) {
        const path = s.job.path;
        s.job = null;
        s.route = path ? new RouteCursor(path) : null;
      }

      if (!s.job && (s.replan <= 0 || !s.route)) {
        s.replan = REPLAN;
        s.job = this.planner.request(s.pos, goal, NAV.person);
      }

      if (s.route) {
        s.route.track(s.pos);
        to = s.route.ahead(1.2, _step);
      }
    } else if (s.route || s.job) {
      this.drop(s);
    }

    const dx = to.x - s.pos.x;
    const dz = to.z - s.pos.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < 1e-3) {
      return;
    }

    this.spacing(s);
    this.walk(s, dx / d + _sep.x * APART, dz / d + _sep.z * APART, PACE, dt);
  }

  /** Turn toward the desired direction and move forward with collision resolution. `pace` is in m/s. */
  private walk(s: Skeleton, dx: number, dz: number, pace: number, dt: number): void {
    if (dx * dx + dz * dz > 1e-8) {
      s.yaw = dampAngle(s.yaw, Math.atan2(dx, dz), 8, dt);
    }

    s.speed = damp(s.speed, pace, 4, dt);
    _p[0] = s.pos.x + Math.sin(s.yaw) * s.speed * dt;
    _p[1] = s.pos.y;
    _p[2] = s.pos.z + Math.cos(s.yaw) * s.speed * dt;
    this.world.resolveCircle(_p, RADIUS, HEIGHT, STEP);
    const y = this.nav.heightAt(_p[0], s.pos.y, _p[2]) ?? this.world.groundAt(_p[0], _p[2], s.pos.y, STEP);
    s.pos.set(_p[0], Math.abs(y - s.pos.y) > 0.6 ? y : damp(s.pos.y, y, 20, dt), _p[2]);
  }

  /**
   * Write a distance-weighted separation vector into _sep and return its magnitude. Use reduced spacing for skeletons
   * sharing a quarry.
   */
  private spacing(s: Skeleton): number {
    let x = 0;
    let z = 0;
    for (let j = 0; j < this.list.length; j++) {
      const o = this.list[j];
      if (!o || o === s || Math.abs(o.pos.y - s.pos.y) > SAME_LEVEL) {
        continue;
      }

      const r = s.target && o.target === s.target ? CROWD : SPREAD;
      const dx = s.pos.x - o.pos.x;
      const dz = s.pos.z - o.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) {
        continue;
      }

      const d = Math.sqrt(d2);
      const w = (1 - d / r) * (1 - d / r);
      if (d > 1e-4) {
        x += (dx / d) * w;
        z += (dz / d) * w;
      } else {
        // Use list order to choose a deterministic direction for coincident positions.
        x += j < this.list.indexOf(s) ? w : -w;
      }
    }

    _sep.set(x, 0, z);
    return Math.sqrt(x * x + z * z);
  }

  /**
   * Separate overlapping pairs while respecting walls. Rising skeletons stay fixed; pairs that are both rising are
   * skipped.
   */
  private unstack(): void {
    const n = this.list.length;
    for (let i = 0; i < n; i++) {
      const a = this.list[i];
      if (!a) {
        continue;
      }

      for (let j = i + 1; j < n; j++) {
        const b = this.list[j];
        if (!b || Math.abs(a.pos.y - b.pos.y) > SAME_LEVEL) {
          continue;
        }

        const dx = b.pos.x - a.pos.x;
        const dz = b.pos.z - a.pos.z;
        const d2 = dx * dx + dz * dz;
        const r = RADIUS * 2;
        if (d2 >= r * r) {
          continue;
        }

        const d = Math.sqrt(d2);
        const nx = d > 1e-4 ? dx / d : 1;
        const nz = d > 1e-4 ? dz / d : 0;
        const fixedA = !!a.mind.in('rising');
        const fixedB = !!b.mind.in('rising');
        if (fixedA && fixedB) {
          continue;
        }

        const gap = r - d;
        const ka = fixedA ? 0 : fixedB ? 1 : 0.5;
        if (ka > 0) {
          this.nudge(a, -nx * gap * ka, -nz * gap * ka);
        }

        if (ka < 1) {
          this.nudge(b, nx * gap * (1 - ka), nz * gap * (1 - ka));
        }
      }
    }
  }

  /** Apply a horizontal displacement with wall collision resolution. */
  private nudge(s: Skeleton, dx: number, dz: number): void {
    _p[0] = s.pos.x + dx;
    _p[1] = s.pos.y;
    _p[2] = s.pos.z + dz;
    this.world.resolveCircle(_p, RADIUS, HEIGHT, STEP);
    s.pos.x = _p[0];
    s.pos.z = _p[2];
  }

  /** Cancel pending navigation and clear the active route. */
  private drop(s: Skeleton): void {
    s.job?.cancel();
    s.job = null;
    s.route = null;
  }

  /** Apply damage, knockback, and stagger for the first qualifying vehicle-circle impact. */
  private runOver(s: Skeleton, cars: readonly SkeletonCrusher[]): void {
    for (const v of cars) {
      if (v.gone || Math.abs(v.pos.y - s.pos.y) > 2) {
        continue;
      }

      const P = v.params;
      const half = P.length / 2 - P.radius;
      const fx = Math.sin(v.yaw);
      const fz = Math.cos(v.yaw);
      for (let c = -1; c <= 1; c++) {
        const dx = s.pos.x - (v.pos.x + fx * half * c);
        const dz = s.pos.z - (v.pos.z + fz * half * c);
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d >= P.radius + RADIUS || d < 1e-4) {
          continue;
        }

        const impact = (v.vel.x * dx + v.vel.z * dz) / d;
        if (impact < CAR_MIN) {
          continue;
        }

        s.hp -= impact * CAR_DAMAGE;
        s.pos.x += (dx / d) * KNOCK;
        s.pos.z += (dz / d) * KNOCK;
        s.mind.send({ type: 'struck', t: STAGGER });
        return;
      }
    }
  }

  /** Update the rig pose, gait, attack arm, and stagger sway. */
  private pose(s: Skeleton, dt: number): void {
    const r = s.rig;
    r.root.position.copy(s.pos);
    r.root.rotation.y = s.yaw;
    s.gait.update(r, dt, s.speed);

    if (s.swing > 0) {
      // Raise the arm, then complete the downward strike.
      const k = 1 - s.swing / SWING_EVERY;
      r.armR.rotation.x = k < 0.35 ? -2.4 * (k / 0.35) : -2.4 + 2.9 * Math.min(1, (k - 0.35) / 0.2);
    }

    const staggered = s.mind.in('staggered');
    r.body.rotation.z = staggered ? Math.sin(staggered.t * TAU * 2) * 0.25 : 0;
  }

  private crumble(i: number): void {
    const s = this.list[i];
    if (!s) {
      return;
    }

    this.drop(s);
    this.claims?.release(s);
    this.root.remove(s.rig.root);
    this.list.splice(i, 1);
    this.onCrumble?.(s.pos);
  }
}
