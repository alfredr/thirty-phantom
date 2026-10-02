import { type Scene, Vector3 } from 'three';
import { type Avoidance, inZones, parkedBlocks } from '../actors/avoidance';
import { driverDoor } from '../actors/doors';
import type { LootKind } from '../actors/models/loot';
import { buildPerson, randomOutfit } from '../actors/models/person';
import { bodyOffsets, TUNING } from '../config';
import type { Rng } from '../core/rng';
import type { Vehicle } from '../actors/vehicle';
import { Walker } from '../actors/walker';
import { NAV, type NavGrid, type NavJob, type NavPlanner, type NavQuery } from '../world/nav-grid';
import { Polyline } from '../world/polyline';
import { Casualties, type Casualty, type Harm } from './casualties';
import type { Prey } from './skeletons';
import type { Visitors } from './visitors';

const C = TUNING.crowd;

/** Townsfolk keep to street level: spots no higher than this (m). */
const STREET_LEVEL = 0.6;
/** One newcomer at most this often (s). */
const SPAWN_EVERY = 0.4;
/** A scared runner bolts straight away from the threat this far (m, checked every DASH_STEP) while a route is planned. */
const DASH = 5;
const DASH_STEP = 0.5;
/** Places to run to tried; the one furthest from the threat wins. */
const FLEE_TRIES = 6;
/** Still this close to the threat (in ghost reaches) when a run ends: keep running. */
const STILL_CLOSE = 1.5;
/** A car Cody drives at someone: they're in its way within this far either side of its line (m). */
const IN_THE_WAY = 2;
/** Clipped by a car's body (closer than its radius plus this, m): shoved this far aside. */
const CLIP = 0.4;
const SHOVE = 1.2;
/** An injured person back on their feet runs at this share of their pace. */
const LIMP = 0.55;
/** Moving faster than this (m/s) counts as walking about (traffic brakes for them). */
const MOVING = 0.2;
/** Newcomers who drive in: one car sent at most this often (s). */
const SEND_EVERY = 1.5;
/** Places tried for someone coming back to their car to turn up, out of sight. */
const COME_BACK_TRIES = 6;
/** Someone lying in the road: walkers keep this far from where they lie (m). */
const LYING = 0.8;

/** Pausing, strolling somewhere, running from something, or walking back to their car to drive off. */
type Mood = 'pause' | 'stroll' | 'flee' | 'leave';

interface Person {
  walker: Walker;
  mood: Mood;
  job: NavJob | null;
  /** Seconds left of a pause, or of running before calming down. */
  timer: number;
  /** What they're running from. */
  threat: Vector3;
  /** Dropped their money already (once each). */
  dropped: boolean;
  /** A runner's planned route, taken up when the dash ends. */
  next: Polyline | null;
  pace: number;
  /** Knocked down by a vehicle (a ragdoll until they get up), or null. */
  hurt: Casualty | null;
  /** Running pace scale: an injured person limps. */
  limp: number;
  /** The car they drove in and left parked, while it's still where they left it. */
  car: Vehicle | null;
  /** Seconds before they head back to it and drive off. */
  stay: number;
  /** Out of 100: skeletons' claws take it down (see maul). */
  hp: number;
}

export interface CrowdFrame {
  /** Where the view is: people come and go around it. */
  near: Vector3;
  day: boolean;
  /** Ghost Cody on foot, whom everyone runs from, or null. */
  ghost: Vector3 | null;
  /** The car Cody is driving, or null. */
  driving: Vehicle | null;
  /** Every vehicle: any of them can run someone down. */
  vehicles: readonly Vehicle[];
  /** Skeletons and the like: people run from them the way they run from ghost Cody. */
  threats?: readonly Vector3[];
  /** Everyone and everything people on foot steer around, or null to walk routes blind. */
  avoid: Avoidance | null;
  /** Townsfolk driving in to park and out again; null: newcomers just turn up on the sidewalk. */
  visitors: Visitors | null;
}

const _a = new Vector3();
const _b = new Vector3();
/** Clawed below this much health (of 100), a person goes down injured; at none, dead. */
const MAULED = 50;
/** Clawed off their feet, they're flung this fast (m/s) away from the blow. */
const CLAW_FLING = 3;

/**
 * Townsfolk: they drive in near the view, park in a lot and get out (see
 * Visitors), stroll between random spots (routes from the planner, like the
 * valets'), giving way to each other and to traffic, and after a while walk
 * back to their car and drive off. They run when ghost Cody comes close or
 * Cody drives at them, sometimes dropping cash or a wallet as they go.
 * Drivers who abandon their cars join them, running.
 */
export class Crowd implements Prey {
  private readonly people: Person[] = [];
  private spawnIn = 0;
  /** Someone at `at` took fright and started running (a driver bailing out too). */
  onFright: ((at: Vector3) => void) | null = null;
  /** Every vehicle, as of the last frame (parked ones are what walking routes go round). */
  private vehicles: readonly Vehicle[] = [];

  constructor(
    private readonly scene: Scene,
    private readonly planner: NavPlanner,
    private readonly nav: NavGrid,
    private readonly rng: Rng,
    /** Someone at `at` drops money as they run from `from`. */
    private readonly drop: (at: Vector3, kind: LootKind, from: Vector3) => void,
    /** Who's been hit, ragdolls and blood; without it, cars only shove people aside. */
    private readonly casualties: Casualties | null = null,
  ) {}

  get count(): number {
    return this.people.length;
  }

  /** Skeletons' prey (skeletons.ts): the nearest person within `reach` of `at`, on its level, not dead yet. */
  victimNear(at: Vector3, reach: number, sameLevel: number): object | null {
    let best: Person | null = null;
    let bd = reach * reach;
    for (const p of this.people) {
      if (p.hurt?.harm === 'dead') continue;
      const q = p.hurt ? p.hurt.at : p.walker.pos;
      if (Math.abs(q.y - at.y) > sameLevel) continue;
      const dx = q.x - at.x;
      const dz = q.z - at.z;
      const d = dx * dx + dz * dz;
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best;
  }

  victimAt(v: object, out: Vector3): boolean {
    const p = v as Person;
    if (!this.people.includes(p) || p.hurt?.harm === 'dead') return false;
    out.copy(p.hurt ? p.hurt.at : p.walker.pos);
    return true;
  }

  /**
   * A skeleton's blow from `from`: standing, they bleed and run (down injured under MAULED
   * health, dead at none); lying, every blow makes it worse, until they're dead.
   */
  maul(v: object, from: Vector3, damage: number): 'hit' | 'downed' | 'killed' {
    const p = v as Person;
    const c = this.casualties;
    p.hp -= damage;
    if (!c) {
      this.scare(p, from);
      return 'hit';
    }
    if (p.hurt) return c.maul(p.hurt, from) === 'dead' ? 'killed' : 'downed';
    const w = p.walker;
    c.cut(w.pos, from);
    if (p.hp > MAULED) {
      this.scare(p, from);
      return 'hit';
    }
    _b.set(w.pos.x - from.x, 0, w.pos.z - from.z).normalize().multiplyScalar(CLAW_FLING);
    if (!Number.isFinite(_b.x)) _b.set(CLAW_FLING, 0, 0);
    this.fell(p, from, _b.x, _b.z, p.hp <= 0 ? 'dead' : 'injured');
    return p.hp <= 0 ? 'killed' : 'downed';
  }

  /** The driver of `car` gets out on the street side and runs from `from`. */
  bail(car: Vehicle, from: Vector3): void {
    const door = driverDoor(car, TUNING.valet.doorGap, new Vector3());
    door.y = this.nav.heightAt(door.x, car.pos.y, door.z) ?? car.pos.y;
    this.run(this.add(door, car.yaw - Math.PI / 2), from);
  }

  /** The driver of `car`, just parked by a visitor trip, gets out and goes about their business, coming back for it later. */
  arrive(car: Vehicle): void {
    const door = driverDoor(car, TUNING.valet.doorGap, new Vector3());
    door.y = this.nav.heightAt(door.x, car.pos.y, door.z) ?? car.pos.y;
    const p = this.add(door, car.yaw - Math.PI / 2);
    p.car = car;
    p.stay = this.rng.range(C.stay[0], C.stay[1]);
  }

  /** People on the move, and people lying in the road, for traffic and autopilots to brake for. */
  obstacles(out: Vector3[]): void {
    for (const p of this.people) {
      if (p.hurt) out.push(p.hurt.at);
      else if (p.walker.speed > MOVING) out.push(p.walker.pos);
    }
  }

  /** Everyone for walkers to steer around: people on their feet, and where the fallen lie. */
  addTo(avoid: Avoidance): void {
    for (const p of this.people) {
      if (p.hurt) avoid.still(p.hurt.at, LYING);
      else avoid.person(p.walker.pos, p.walker.vel, p.walker.walking, p.walker);
    }
  }

  update(dt: number, f: CrowdFrame): void {
    this.vehicles = f.vehicles;
    this.maintain(dt, f);
    for (let i = this.people.length - 1; i >= 0; i--) {
      const p = this.people[i];
      if (!p) continue;
      // down: the ragdoll has them (no walking, no gait) until they can get up
      if (p.hurt) {
        this.lying(p);
        continue;
      }
      this.threats(p, f);
      const w = p.walker;
      p.stay -= dt;
      if (p.car && !f.visitors?.waiting(p.car)) p.car = null;
      if (p.mood === 'pause' && p.car && p.stay <= 0 && !p.job) {
        // time to go: back to the car
        p.job = this.planner.request(w.pos, driverDoor(p.car, TUNING.valet.doorGap, _a).setY(p.car.pos.y), NAV.person, this.around());
        p.mood = 'leave';
      }
      if (p.mood === 'leave') {
        if (p.job?.settled) {
          const path = p.job.path;
          p.job = null;
          if (path) w.follow(path, this.rng.range(C.walkPace[0], C.walkPace[1]));
          else p.car = null;
        }
        if (!p.car) {
          // no way back to it, or it's gone (stolen, towed): stay a pedestrian
          p.job?.cancel();
          p.job = null;
          p.mood = w.walking ? 'stroll' : 'pause';
          p.timer = this.pause();
        } else if (w.blocked && !p.job) {
          // something's parked in the way since: a fresh route round it
          p.job = this.planner.request(w.pos, driverDoor(p.car, TUNING.valet.doorGap, _a).setY(p.car.pos.y), NAV.person, this.around());
        } else if (w.update(dt, this.nav, f.avoid)) {
          if (f.visitors?.leave(p.car)) {
            this.remove(i);
            continue;
          }
          p.car = null;
          p.mood = 'pause';
          p.timer = this.pause();
        }
        continue;
      }
      if (p.mood === 'pause') {
        p.timer -= dt;
        if (p.job?.settled) {
          const path = p.job.path;
          p.job = null;
          if (path) {
            w.follow(path, this.rng.range(C.walkPace[0], C.walkPace[1]));
            p.mood = 'stroll';
          } else {
            p.timer = this.pause();
          }
        } else if (!p.job && p.timer <= 0) {
          const to = this.nav.spotNear(this.rng, w.pos.x, w.pos.z, C.stroll[0], C.stroll[1], NAV.person, STREET_LEVEL, true);
          const q = this.around();
          if (to && !inZones(to, q.blocks ?? [])) p.job = this.planner.request(w.pos, to, NAV.person, q);
          else p.timer = this.pause();
        }
      } else if (p.mood === 'flee') {
        p.timer -= dt;
        if (p.job?.settled) {
          p.next = p.job.path;
          p.job = null;
        }
        if (!w.walking && p.next) {
          w.follow(p.next, p.pace);
          p.next = null;
        }
        const close = w.pos.distanceTo(p.threat) < C.ghostReach * STILL_CLOSE;
        if (!w.walking && !p.job && !p.next) {
          // the run ended: further if the threat's still about, else catch their breath
          if (close) this.run(p, p.threat);
          else this.calm(p);
        } else if (p.timer <= 0 && !close) {
          this.calm(p);
        }
      }
      if (p.mood === 'stroll' && w.blocked) {
        // held up too long: give it up and pick somewhere else
        w.stop();
        p.mood = 'pause';
        p.timer = 0;
      } else if (p.mood === 'flee' && w.blocked) {
        w.stop();
      }
      if (w.update(dt, this.nav, f.avoid) && p.mood === 'stroll') {
        p.mood = 'pause';
        p.timer = this.pause();
      }
    }
  }

  private threats(p: Person, f: CrowdFrame): void {
    const w = p.walker;
    if (this.struck(p, f)) return;
    if (f.ghost && w.pos.distanceTo(f.ghost) < C.ghostReach && Math.abs(f.ghost.y - w.pos.y) < C.ghostReach) {
      this.scare(p, f.ghost);
      return;
    }
    if (f.threats) {
      for (const t of f.threats) {
        if (w.pos.distanceTo(t) < C.ghostReach && Math.abs(t.y - w.pos.y) < C.ghostReach) {
          this.scare(p, t);
          return;
        }
      }
    }
    const v = f.driving;
    if (!v || Math.abs(v.pos.y - w.pos.y) > IN_THE_WAY) return;
    // a car coming at them fast
    if (Math.abs(v.speed) < C.carSpeed) return;
    const dir = Math.sign(v.speed);
    const fx = Math.sin(v.yaw) * dir;
    const fz = Math.cos(v.yaw) * dir;
    const dx = w.pos.x - v.pos.x;
    const dz = w.pos.z - v.pos.z;
    const along = dx * fx + dz * fz;
    if (along > 0 && along < C.carReach && Math.abs(dx * fz - dz * fx) < IN_THE_WAY) this.scare(p, v.pos);
  }

  /**
   * Hit by a vehicle's body: hard enough and they go down (a casualty, maybe
   * knocking their money loose), else shoved aside and off they go. True if hit.
   */
  private struck(p: Person, f: CrowdFrame): boolean {
    const w = p.walker;
    for (const v of f.vehicles) {
      if (v.gone || Math.abs(v.pos.y - w.pos.y) > IN_THE_WAY) continue;
      const moving = v.vel.x * v.vel.x + v.vel.z * v.vel.z > 1;
      if (!moving && v !== f.driving) continue;
      for (const o of bodyOffsets(v.params)) {
        _a.set(v.pos.x + Math.sin(v.yaw) * o, w.pos.y, v.pos.z + Math.cos(v.yaw) * o);
        const ox = w.pos.x - _a.x;
        const oz = w.pos.z - _a.z;
        const d = Math.sqrt(ox * ox + oz * oz);
        if (d >= v.params.radius + CLIP) continue;
        // how hard: the body's speed toward them
        const impact = d > 1e-3 ? (v.vel.x * (w.pos.x - _a.x) + v.vel.z * (w.pos.z - _a.z)) / d : Math.hypot(v.vel.x, v.vel.z);
        const harm = this.casualties ? Casualties.harmFor(impact, v.mass) : null;
        if (harm && this.casualties) {
          this.fell(p, v.pos, v.vel.x, v.vel.z, harm);
          return true;
        }
        _b.set(w.pos.x - _a.x, 0, w.pos.z - _a.z).normalize().multiplyScalar(SHOVE);
        if (!Number.isFinite(_b.x)) _b.set(Math.cos(v.yaw) * SHOVE, 0, -Math.sin(v.yaw) * SHOVE);
        _a.copy(w.pos).add(_b);
        _a.y = this.nav.heightAt(_a.x, w.pos.y, _a.z) ?? w.pos.y;
        w.place(_a, w.yaw);
        this.scare(p, v.pos);
        return true;
      }
    }
    return false;
  }

  /** Knocked down (run over, or clawed off their feet) moving (vx, vz): their casualty takes over, money flying. */
  private fell(p: Person, from: Vector3, vx: number, vz: number, harm: Harm): void {
    const w = p.walker;
    p.job?.cancel();
    p.job = null;
    p.next = null;
    w.stop();
    p.mood = 'flee';
    p.threat.copy(from);
    if (!p.dropped) {
      p.dropped = true;
      this.drop(w.pos, this.rng.chance(C.walletShare) ? 'wallet' : 'cash', from);
    }
    p.hurt = (this.casualties as Casualties).strike(w.rig, vx, vz, harm);
  }

  /** Down after a hit: get back up once able (an injured one limps off), running from what hit them. */
  private lying(p: Person): void {
    const c = p.hurt;
    if (!c || !this.casualties || !this.casualties.ready(c)) return;
    p.limp = c.harm === 'injured' ? LIMP : 1;
    const yaw = this.casualties.recover(c, _a);
    p.hurt = null;
    p.walker.place(_a, yaw);
    p.mood = 'pause';
    this.run(p, p.threat);
  }

  /** Frightened by something at `from`: run (again, if already running) and maybe drop money. */
  private scare(p: Person, from: Vector3): void {
    p.threat.copy(from);
    p.timer = C.calm;
    if (p.mood !== 'flee') this.run(p, from);
  }

  /** Bolt away from `from` at once, with a proper route to a spot well away planned meanwhile. */
  private run(p: Person, from: Vector3): void {
    const w = p.walker;
    const fresh = p.mood !== 'flee';
    p.mood = 'flee';
    p.threat.copy(from);
    p.timer = C.calm;
    if (fresh) {
      p.pace = this.rng.range(C.runPace[0], C.runPace[1]) * p.limp;
      this.onFright?.(w.pos);
    }
    if (!p.dropped && this.rng.chance(C.dropChance)) {
      p.dropped = true;
      this.drop(w.pos, this.rng.chance(C.walletShare) ? 'wallet' : 'cash', from);
    }
    p.job?.cancel();
    p.job = null;
    p.next = null;
    const dash = this.dash(w.pos, from);
    if (dash) w.follow(dash, p.pace);
    else w.stop();
    const start = dash ? dash.end : w.pos;
    const q = this.around();
    let best: Vector3 | null = null;
    let bd = -Infinity;
    for (let t = 0; t < FLEE_TRIES; t++) {
      const s = this.nav.spotNear(this.rng, start.x, start.z, C.flee[0], C.flee[1], NAV.person, STREET_LEVEL, false);
      if (s && s.distanceTo(from) > bd && !inZones(s, q.blocks ?? [])) {
        bd = s.distanceTo(from);
        best = s;
      }
    }
    if (best) p.job = this.planner.request(start, best, NAV.person, q);
  }

  /** A straight line away from `from`, as far as the ground allows (up to DASH), or null if they can't get going that way. */
  private dash(at: Vector3, from: Vector3): Polyline | null {
    let ux = at.x - from.x;
    let uz = at.z - from.z;
    const len = Math.hypot(ux, uz);
    if (len < 1e-3) {
      const a = this.rng.range(0, Math.PI * 2);
      ux = Math.sin(a);
      uz = Math.cos(a);
    } else {
      ux /= len;
      uz /= len;
    }
    const pts = [at.clone()];
    let y = at.y;
    for (let d = DASH_STEP; d <= DASH; d += DASH_STEP) {
      const g = this.nav.standable(at.x + ux * d, y, at.z + uz * d, NAV.person);
      if (g === null) break;
      y = g;
      pts[1] = new Vector3(at.x + ux * d, g, at.z + uz * d);
    }
    return pts.length > 1 ? new Polyline(pts) : null;
  }

  /** A walking route's query: round parked cars. */
  private around(): NavQuery {
    return { blocks: parkedBlocks(this.vehicles) };
  }

  private calm(p: Person): void {
    p.walker.stop();
    p.job?.cancel();
    p.job = null;
    p.next = null;
    p.mood = 'pause';
    p.timer = this.pause();
  }

  private pause(): number {
    return this.rng.range(C.pause[0], C.pause[1]);
  }

  private add(at: Vector3, yaw: number): Person {
    const walker = new Walker(buildPerson(randomOutfit(this.rng)));
    walker.place(at, yaw);
    this.scene.add(walker.rig.root);
    const p: Person = { walker, mood: 'pause', job: null, timer: this.pause(), threat: new Vector3(), dropped: false, next: null, pace: 0, hurt: null, limp: 1, car: null, stay: 0, hp: 100 };
    this.people.push(p);
    return p;
  }

  /** Keep the day or night count around the view: newcomers out at the edge of it, far ones gone. */
  private maintain(dt: number, f: CrowdFrame): void {
    for (let i = this.people.length - 1; i >= 0; i--) {
      const p = this.people[i];
      if (!p || (p.hurt ? p.hurt.at : p.walker.pos).distanceTo(f.near) < C.despawn) continue;
      // gone for good: their car goes too, once nobody's looking
      if (p.car) f.visitors?.orphan(p.car);
      this.remove(i);
    }
    this.spawnIn -= dt;
    const v = f.visitors;
    if (this.spawnIn > 0 || this.people.length + (v?.incoming ?? 0) >= (f.day ? C.day : C.night)) return;
    // newcomers drive in and park; only a level without lots has them turn up on foot
    if (v?.hasBays) {
      this.spawnIn = SEND_EVERY;
      // no stall free: someone who parked earlier comes back for their car, freeing one
      if (!v.send(f.near)) this.comeBack(v, f.near);
      return;
    }
    this.spawnIn = SPAWN_EVERY;
    const at = this.nav.spotNear(this.rng, f.near.x, f.near.z, C.spawnMin, C.spawnMax, NAV.person, STREET_LEVEL, true);
    if (at) this.add(at, this.rng.range(0, Math.PI * 2));
  }

  /** Someone who parked before the view got here turns up out of sight and heads back to their car, to drive off in it. */
  private comeBack(v: Visitors, near: Vector3): void {
    const car = v.claim(near);
    if (!car) return;
    for (let t = 0; t < COME_BACK_TRIES; t++) {
      const at = this.nav.spotNear(this.rng, car.pos.x, car.pos.z, C.stroll[0], C.stroll[1], NAV.person, STREET_LEVEL, true);
      if (!at || at.distanceTo(near) < C.spawnMin) continue;
      // no stay: straight back to it
      this.add(at, this.rng.range(0, Math.PI * 2)).car = car;
      return;
    }
    v.unclaim(car);
  }

  private remove(i: number): void {
    const p = this.people[i];
    if (!p) return;
    p.job?.cancel();
    if (p.hurt) this.casualties?.remove(p.hurt);
    this.scene.remove(p.walker.rig.root);
    this.people.splice(i, 1);
  }
}
