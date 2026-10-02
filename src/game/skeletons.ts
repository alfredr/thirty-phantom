import { Group, Vector3 } from 'three';
import { Gait } from '../actors/models/person';
import type { CharacterRig } from '../actors/models/rig';
import { buildSkeleton } from '../actors/models/skeleton';
import { clamp, damp, dampAngle, TAU } from '../core/math';
import type { V3 } from '../render/geometry';
import type { CollisionWorld } from '../world/collision';
import { NAV, type NavGrid, type NavJob, type NavPlanner } from '../world/nav-grid';
import { RouteCursor } from '../world/polyline';

/**
 * Whom skeletons hunt: the crowd's people, through opaque handles. A handle
 * stays valid until victimAt() says they're gone.
 */
export interface Prey {
  /** The nearest person within `reach` (m) of `at` and within `sameLevel` (m) of its height, not dead yet; or null. */
  victimNear(at: Vector3, reach: number, sameLevel: number): object | null;
  /** Where `v` is now (standing, or lying), into `out`; false once they're dead or gone. */
  victimAt(v: object, out: Vector3): boolean;
  /** A skeleton's blow from `from`: they run off hurt, go down, or die. */
  maul(v: object, from: Vector3, damage: number): 'hit' | 'downed' | 'killed';
}

/** A vehicle that can run a skeleton down, by its three body circles. */
export interface SkeletonCrusher {
  readonly pos: Vector3;
  readonly vel: Vector3;
  readonly yaw: number;
  readonly params: { readonly radius: number; readonly length: number; readonly height: number };
  readonly gone: boolean;
}

/** Most up at once; how many rise per summon, and how often (s). */
const MAX = 9;
const PER_SUMMON = 3;
const SUMMON_EVERY = 4;
/** They come up within this ring around the summoner (m), and take this long to climb out (s). */
const RING: readonly [number, number] = [1.6, 3.4];
const RISE = 1.3;
const BURIED = 1.9;
/** Hunting: they look this far for someone (m), on their level, and pick again this often (s). */
const HUNT = 26;
const SAME_LEVEL = 2.5;
const RETARGET = 0.6;
/**
 * A shambling run (m/s). With nobody to hunt they keep near the summoner:
 * further off than HEEL[1] (m) they come back, until within HEEL[0].
 */
const PACE = 4.3;
const HEEL: readonly [number, number] = [4, 7];
/** Body for collisions: radius, height, step up (m). */
const RADIUS = 0.35;
const HEIGHT = 1.8;
const STEP = 0.5;
/** Clawing: within this reach (m), a blow this often (s) for this much (of a person's 100). */
const REACH = 1.05;
const SWING_EVERY = 0.8;
const DAMAGE: readonly [number, number] = [22, 34];
/** Their own health; a car at speed takes this much per m/s of impact. */
const HEALTH = 100;
const CAR_DAMAGE = 9;
const CAR_MIN = 3;
/** Knocked back this far (m) and staggered this long (s) by a car that didn't finish them. */
const KNOCK = 1.4;
const STAGGER = 0.6;
/** Left this far behind the summoner (m), they crumble. */
const STRAY = 95;
/** Re-plan a route around walls this often (s). */
const REPLAN = 1.5;
/**
 * Spacing: within SPREAD (m) of each other they bear away, gently (at its
 * strongest the push counts APART times their heading); after the same quarry,
 * only within CROWD, so they can gang up. With nothing to do, one too close to
 * another ambles off at up to AMBLE (m/s). Bodies never overlap.
 */
const SPREAD = 3.5;
const CROWD = 1.1;
const APART = 1.2;
const AMBLE = 1.1;
/** Pushes weaker than this are left alone (so they settle rather than fidget). */
const SETTLED = 0.02;

type State = 'rising' | 'hunting' | 'staggered';

interface Skeleton {
  rig: CharacterRig;
  gait: Gait;
  pos: Vector3;
  yaw: number;
  speed: number;
  hp: number;
  state: State;
  /** Seconds into rising, or left staggered. */
  t: number;
  target: object | null;
  retarget: number;
  swing: number;
  /** Coming back to the summoner (see HEEL). */
  heeling: boolean;
  /** A planned way around walls to whatever it's after, and when to plan again. */
  job: NavJob | null;
  route: RouteCursor | null;
  replan: number;
}

const _goal = new Vector3();
const _step = new Vector3();
/** The spacing push for the skeleton being moved (see spacing()). */
const _sep = new Vector3();
const _p: V3 = [0, 0, 0];
const _a: V3 = [0, 0, 0];
const _b: V3 = [0, 0, 0];

/**
 * Phantom Cody's skeletons. Summoned at night, a few climb out of the ground
 * around him, then hunt the nearest townsfolk: straight at them when nothing's
 * in the way, round walls by a planned route when something is. In reach they
 * claw (the crowd decides what that does: hurt, down, dead); a kill is
 * reported so a ghost can rise from the body. With nobody about they keep near
 * Cody. Cars knock them back and smash them; out of health, or at sunrise,
 * they crumble into bones.
 */
export class Skeletons {
  readonly root = new Group();
  /** Where each one is, for the crowd to run from (refilled every update). */
  readonly threats: Vector3[] = [];
  /** One climbed out of the ground here (dirt). */
  onRise: ((at: Vector3) => void) | null = null;
  /** One fell apart here (bones). */
  onCrumble: ((at: Vector3) => void) | null = null;
  /** One killed someone lying (or falling) here: a ghost rises from them. */
  onKill: ((at: Vector3) => void) | null = null;

  private readonly list: Skeleton[] = [];
  private cooldown = 0;

  constructor(
    private readonly world: CollisionWorld,
    private readonly nav: NavGrid,
    private readonly planner: NavPlanner,
    private readonly prey: Prey | null,
  ) {}

  get count(): number {
    return this.list.length;
  }

  /** Call some up around `at` (facing `yaw`): how many rose (0 while the last summons is cooling down or at the cap). */
  summon(at: Vector3, yaw: number): number {
    if (this.cooldown > 0 || this.list.length >= MAX) return 0;
    this.cooldown = SUMMON_EVERY;
    let n = 0;
    for (let k = 0; k < PER_SUMMON && this.list.length < MAX; k++) {
      // spread round in front of him first
      for (let tries = 0; tries < 6; tries++) {
        const a = yaw + (k - (PER_SUMMON - 1) / 2) * 0.9 + (Math.random() - 0.5) * 0.6 + (tries > 2 ? Math.PI : 0);
        const r = RING[0] + Math.random() * (RING[1] - RING[0]);
        const x = at.x + Math.sin(a) * r;
        const z = at.z + Math.cos(a) * r;
        const y = this.nav.standable(x, at.y, z, NAV.person);
        if (y === null || this.crowded(x, y, z)) continue;
        this.add(new Vector3(x, y, z), a);
        n++;
        break;
      }
    }
    return n;
  }

  /** Sunrise: every one of them falls apart. */
  crumbleAll(): void {
    for (let i = this.list.length - 1; i >= 0; i--) this.crumble(i);
  }

  /**
   * @param master phantom Cody, whom they keep near with nobody to hunt (null: they just stand about)
   * @param cars vehicles that can run them down
   */
  update(dt: number, master: Vector3 | null, cars: readonly SkeletonCrusher[]): void {
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.threats.length = 0;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const s = this.list[i] as Skeleton;
      if (master && s.pos.distanceTo(master) > STRAY) {
        this.crumble(i);
        continue;
      }
      if (s.state === 'rising') {
        this.rise(s, dt);
        this.threats.push(s.pos);
        continue;
      }
      this.runOver(s, cars);
      if (s.hp <= 0) {
        this.crumble(i);
        continue;
      }
      if (s.state === 'staggered') {
        s.t -= dt;
        s.speed = damp(s.speed, 0, 6, dt);
        if (s.t <= 0) s.state = 'hunting';
      } else this.hunt(s, dt, master);
      this.threats.push(s.pos);
    }
    this.unstack();
    for (const s of this.list) if (s.state !== 'rising') this.pose(s, dt);
  }

  private add(pos: Vector3, yaw: number): void {
    const rig = buildSkeleton();
    rig.root.position.set(pos.x, pos.y - BURIED, pos.z);
    rig.root.rotation.y = yaw;
    this.root.add(rig.root);
    this.list.push({
      rig,
      gait: new Gait(),
      pos,
      yaw,
      speed: 0,
      hp: HEALTH,
      state: 'rising',
      t: -Math.random() * 0.35,
      target: null,
      retarget: 0,
      swing: 0,
      heeling: false,
      job: null,
      route: null,
      replan: 0,
    });
  }

  /** Is (x, y, z) too close to one already up (or coming up) to rise there? */
  private crowded(x: number, y: number, z: number): boolean {
    for (const o of this.list) {
      const dx = o.pos.x - x;
      const dz = o.pos.z - z;
      if (Math.abs(o.pos.y - y) < SAME_LEVEL && dx * dx + dz * dz < CROWD * CROWD) return true;
    }
    return false;
  }

  /** Climbing out: up through the ground, shaking, dirt flying as it breaks the surface. */
  private rise(s: Skeleton, dt: number): void {
    const was = s.t;
    s.t += dt;
    if (was < 0 && s.t >= 0) this.onRise?.(s.pos);
    const k = clamp(s.t / RISE, 0, 1);
    const ease = 1 - (1 - k) * (1 - k);
    const r = s.rig;
    r.root.position.set(s.pos.x + Math.sin(s.t * 40) * 0.03 * (1 - k), s.pos.y - BURIED * (1 - ease), s.pos.z);
    r.root.rotation.y = s.yaw;
    // clawing its way up
    r.armL.rotation.x = -2.6 + Math.sin(s.t * 12) * 0.5 * (1 - k);
    r.armR.rotation.x = -2.6 + Math.cos(s.t * 12) * 0.5 * (1 - k);
    if (k >= 1) {
      s.state = 'hunting';
      r.armL.rotation.x = 0;
      r.armR.rotation.x = 0;
    }
  }

  /** After the nearest prey (or back toward the master), and clawing at them once in reach. */
  private hunt(s: Skeleton, dt: number, master: Vector3 | null): void {
    s.retarget -= dt;
    s.swing = Math.max(0, s.swing - dt);
    if (this.prey && (s.retarget <= 0 || !s.target)) {
      s.retarget = RETARGET;
      const v = this.prey.victimNear(s.pos, HUNT, SAME_LEVEL);
      if (v !== s.target) this.drop(s);
      s.target = v;
    }
    let goal: Vector3 | null = null;
    if (s.target && this.prey?.victimAt(s.target, _goal)) goal = _goal;
    else if (s.target) {
      this.drop(s);
      s.target = null;
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
            s.target = null;
            this.drop(s);
          }
        }
        return;
      }
    } else if (master) {
      // nobody to hunt: keep near Cody
      const d = Math.hypot(master.x - s.pos.x, master.z - s.pos.z);
      if (d > HEEL[1]) s.heeling = true;
      else if (d < HEEL[0]) s.heeling = false;
      if (s.heeling) goal = master;
    }
    if (!goal) {
      // nothing to do: drift off from any too close
      const push = this.spacing(s);
      if (push > SETTLED) this.walk(s, _sep.x, _sep.z, AMBLE * Math.min(1, push * 2), dt);
      else s.speed = damp(s.speed, 0, 6, dt);
      return;
    }
    this.go(s, goal, dt);
  }

  /** Toward `goal`: straight there if nothing's in the way, else along a planned route. */
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
    } else if (s.route || s.job) this.drop(s);
    const dx = to.x - s.pos.x;
    const dz = to.z - s.pos.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < 1e-3) return;
    this.spacing(s);
    this.walk(s, dx / d + _sep.x * APART, dz / d + _sep.z * APART, PACE, dt);
  }

  /** Turn toward (dx, dz) and walk at up to `pace` the way it's facing, so it turns rather than sidesteps. */
  private walk(s: Skeleton, dx: number, dz: number, pace: number, dt: number): void {
    if (dx * dx + dz * dz > 1e-8) s.yaw = dampAngle(s.yaw, Math.atan2(dx, dz), 8, dt);
    s.speed = damp(s.speed, pace, 4, dt);
    _p[0] = s.pos.x + Math.sin(s.yaw) * s.speed * dt;
    _p[1] = s.pos.y;
    _p[2] = s.pos.z + Math.cos(s.yaw) * s.speed * dt;
    this.world.resolveCircle(_p, RADIUS, HEIGHT, STEP);
    const y = this.nav.heightAt(_p[0], s.pos.y, _p[2]) ?? this.world.groundAt(_p[0], _p[2], s.pos.y, STEP);
    s.pos.set(_p[0], Math.abs(y - s.pos.y) > 0.6 ? y : damp(s.pos.y, y, 20, dt), _p[2]);
  }

  /**
   * The push (into _sep) away from the others near `s` on its level, each
   * falling off with distance: out to SPREAD, or only CROWD from one after the
   * same quarry. Returns how strong it is.
   */
  private spacing(s: Skeleton): number {
    let x = 0;
    let z = 0;
    for (let j = 0; j < this.list.length; j++) {
      const o = this.list[j] as Skeleton;
      if (o === s || Math.abs(o.pos.y - s.pos.y) > SAME_LEVEL) continue;
      const r = s.target && o.target === s.target ? CROWD : SPREAD;
      const dx = s.pos.x - o.pos.x;
      const dz = s.pos.z - o.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      const d = Math.sqrt(d2);
      const w = (1 - d / r) * (1 - d / r);
      if (d > 1e-4) {
        x += (dx / d) * w;
        z += (dz / d) * w;
      } else {
        // right on top of each other: part by their order
        x += j < this.list.indexOf(s) ? w : -w;
      }
    }
    _sep.set(x, 0, z);
    return Math.sqrt(x * x + z * z);
  }

  /** No two bodies in the same space: overlapping pairs pushed apart (a rising one stays put, the other gives way). */
  private unstack(): void {
    const n = this.list.length;
    for (let i = 0; i < n; i++) {
      const a = this.list[i] as Skeleton;
      for (let j = i + 1; j < n; j++) {
        const b = this.list[j] as Skeleton;
        if (Math.abs(a.pos.y - b.pos.y) > SAME_LEVEL) continue;
        const dx = b.pos.x - a.pos.x;
        const dz = b.pos.z - a.pos.z;
        const d2 = dx * dx + dz * dz;
        const r = RADIUS * 2;
        if (d2 >= r * r) continue;
        const d = Math.sqrt(d2);
        const nx = d > 1e-4 ? dx / d : 1;
        const nz = d > 1e-4 ? dz / d : 0;
        const fixedA = a.state === 'rising';
        const fixedB = b.state === 'rising';
        if (fixedA && fixedB) continue;
        const gap = r - d;
        const ka = fixedA ? 0 : fixedB ? 1 : 0.5;
        if (ka > 0) this.nudge(a, -nx * gap * ka, -nz * gap * ka);
        if (ka < 1) this.nudge(b, nx * gap * (1 - ka), nz * gap * (1 - ka));
      }
    }
  }

  /** Shift `s` by (dx, dz), keeping it out of walls. */
  private nudge(s: Skeleton, dx: number, dz: number): void {
    _p[0] = s.pos.x + dx;
    _p[1] = s.pos.y;
    _p[2] = s.pos.z + dz;
    this.world.resolveCircle(_p, RADIUS, HEIGHT, STEP);
    s.pos.x = _p[0];
    s.pos.z = _p[2];
  }

  /** Forget a planned route. */
  private drop(s: Skeleton): void {
    s.job?.cancel();
    s.job = null;
    s.route = null;
  }

  /** Cars plough into them: knocked back and staggered, or smashed. */
  private runOver(s: Skeleton, cars: readonly SkeletonCrusher[]): void {
    for (const v of cars) {
      if (v.gone || Math.abs(v.pos.y - s.pos.y) > 2) continue;
      const P = v.params;
      const half = P.length / 2 - P.radius;
      const fx = Math.sin(v.yaw);
      const fz = Math.cos(v.yaw);
      for (let c = -1; c <= 1; c++) {
        const dx = s.pos.x - (v.pos.x + fx * half * c);
        const dz = s.pos.z - (v.pos.z + fz * half * c);
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d >= P.radius + RADIUS || d < 1e-4) continue;
        const impact = (v.vel.x * dx + v.vel.z * dz) / d;
        if (impact < CAR_MIN) continue;
        s.hp -= impact * CAR_DAMAGE;
        s.pos.x += (dx / d) * KNOCK;
        s.pos.z += (dz / d) * KNOCK;
        s.state = 'staggered';
        s.t = STAGGER;
        return;
      }
    }
  }

  /** Rig follows: root at the feet, the shambling gait, and a claw swipe while one's coming. */
  private pose(s: Skeleton, dt: number): void {
    const r = s.rig;
    r.root.position.copy(s.pos);
    r.root.rotation.y = s.yaw;
    s.gait.update(r, dt, s.speed);
    if (s.swing > 0) {
      // arm up then raking down across the swing
      const k = 1 - s.swing / SWING_EVERY;
      r.armR.rotation.x = k < 0.35 ? -2.4 * (k / 0.35) : -2.4 + 2.9 * Math.min(1, (k - 0.35) / 0.2);
    }
    if (s.state === 'staggered') r.body.rotation.z = Math.sin(s.t * TAU * 2) * 0.25;
    else r.body.rotation.z = 0;
  }

  private crumble(i: number): void {
    const s = this.list[i] as Skeleton;
    this.drop(s);
    this.root.remove(s.rig.root);
    this.list.splice(i, 1);
    this.onCrumble?.(s.pos);
  }
}
