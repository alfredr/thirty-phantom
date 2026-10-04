import { type Scene, Vector3 } from 'three';
import { type Avoidance, inZones, parkedBlocks, PERSON_RADIUS } from '../../actors/avoidance';
import { driverDoor } from '../../actors/doors';
import type { LootKind } from '../../actors/models/loot';
import { buildPerson, randomOutfit } from '../../actors/models/person';
import type { Vehicle } from '../../actors/vehicle';
import { Walker } from '../../actors/walker';
import { TUNING } from '../../config';
import type { Rng } from '../../engine/core/rng';
import { Polyline } from '../../engine/nav/polyline';
import { bodyOffsets } from '../../engine/physics/vehicle-params';
import { NAV, type NavGrid, type NavJob, type NavPlanner, type NavQuery } from '../../world/nav-grid';
import type { Visitors } from '../driving/visitors';
import type { Bodies } from '../rules/bodies';
import { Casualties } from './casualties';
import type { Prey } from './skeletons';
import { type Town, Townsperson } from './town-mind';

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
/** A car Cody drives at someone: they're in its way within this far either side of its line (m). */
const IN_THE_WAY = 2;
/** Clipped by a car's body (closer than its radius plus this, m): shoved this far aside. */
const CLIP = 0.4;
const SHOVE = 1.2;
/** Moving faster than this (m/s) counts as walking about (traffic brakes for them). */
const MOVING = 0.2;
/** Newcomers who drive in: one car sent at most this often (s). */
const SEND_EVERY = 1.5;
/** Places tried for someone coming back to their car to turn up, out of sight. */
const COME_BACK_TRIES = 6;
/** Someone lying in the road: walkers keep this far from where they lie (m). */
const LYING = 0.8;

export interface CrowdFrame {
  /** Where the view is: people come and go around it. */
  near: Vector3;
  day: boolean;
  /** The car Cody is driving, or null. */
  driving: Vehicle | null;
  /** Every vehicle: any of them can run someone down. */
  vehicles: readonly Vehicle[];
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
 * Drivers who abandon their cars join them, running. What each one does is
 * their mind's (town-mind.ts); this is the town they share.
 */
export class Crowd implements Prey, Town {
  private readonly people: Townsperson[] = [];
  private spawnIn = 0;
  /** Someone at `at` took fright and started running (a driver bailing out too). */
  onFright: ((at: Vector3) => void) | null = null;
  /** Every vehicle, as of the last frame (parked ones are what walking routes go round). */
  private vehicles: readonly Vehicle[] = [];
  avoid: Avoidance | null = null;
  visitors: Visitors | null = null;

  constructor(
    private readonly scene: Scene,
    private readonly planner: NavPlanner,
    readonly nav: NavGrid,
    readonly rng: Rng,
    /** Someone at `at` drops money as they run from `from`. */
    private readonly drop: (at: Vector3, kind: LootKind, from: Vector3) => void,
    /** Who's been hit, ragdolls and blood; without it, cars only shove people aside. */
    readonly casualties: Casualties | null = null,
  ) {}

  get count(): number {
    return this.people.length;
  }

  /** Skeletons' prey (skeletons.ts): the nearest person within `reach` of `at`, on its level, not dead yet. */
  victimNear(at: Vector3, reach: number, sameLevel: number): object | null {
    let best: Townsperson | null = null;
    let bd = reach * reach;
    for (const p of this.people) {
      const hurt = p.hurt;
      if (hurt?.harm === 'dead') continue;
      const q = hurt ? hurt.at : p.walker.pos;
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
    const p = this.people.find((q) => q === v);
    const hurt = p?.hurt;
    if (!p || hurt?.harm === 'dead') return false;
    out.copy(hurt ? hurt.at : p.walker.pos);
    return true;
  }

  /**
   * A skeleton's blow from `from`: standing, they bleed and run (down injured under MAULED
   * health, dead at none); lying, every blow makes it worse, until they're dead.
   */
  maul(v: object, from: Vector3, damage: number): 'hit' | 'downed' | 'killed' {
    const p = this.people.find((q) => q === v);
    if (!p) return 'hit';
    const c = this.casualties;
    p.hp -= damage;
    if (!c) {
      p.mind.send({ type: 'frightened', from });
      return 'hit';
    }
    const hurt = p.hurt;
    if (hurt) return c.maul(hurt, from) === 'dead' ? 'killed' : 'downed';
    const w = p.walker;
    c.cut(w.pos, from);
    if (p.hp > MAULED) {
      p.mind.send({ type: 'frightened', from });
      return 'hit';
    }
    _b.set(w.pos.x - from.x, 0, w.pos.z - from.z).normalize().multiplyScalar(CLAW_FLING);
    if (!Number.isFinite(_b.x)) _b.set(CLAW_FLING, 0, 0);
    p.mind.send({ type: 'felled', from, vx: _b.x, vz: _b.z, harm: p.hp <= 0 ? 'dead' : 'injured' });
    return p.hp <= 0 ? 'killed' : 'downed';
  }

  /** The driver of `car` gets out on the street side and runs from `from`. */
  bail(car: Vehicle, from: Vector3): void {
    const door = driverDoor(car, TUNING.valet.doorGap, new Vector3());
    door.y = this.nav.heightAt(door.x, car.pos.y, door.z) ?? car.pos.y;
    this.add(door, car.yaw - Math.PI / 2).mind.send({ type: 'frightened', from });
  }

  /** The driver of `car`, just parked by a visitor trip, gets out and goes about their business, coming back for it later. */
  arrive(car: Vehicle): void {
    const door = driverDoor(car, TUNING.valet.doorGap, new Vector3());
    door.y = this.nav.heightAt(door.x, car.pos.y, door.z) ?? car.pos.y;
    const p = this.add(door, car.yaw - Math.PI / 2);
    p.car = car;
    p.stay = this.rng.range(C.stay[0], C.stay[1]);
  }

  /** The people on their feet, who can see and react to what's around them. */
  living(): readonly Townsperson[] {
    return this.people.filter((p) => !p.hurt);
  }

  /** Someone takes fright at something at `from` (the reactions table decides who and when). */
  frighten(p: Townsperson, from: Vector3): void {
    p.mind.send({ type: 'frightened', from });
  }

  /** People on the move, and people lying in the road, for traffic and autopilots to brake for. */
  addBodies(bodies: Bodies): void {
    for (const p of this.people) {
      const w = p.walker;
      const hurt = p.hurt;
      if (hurt) bodies.add({ kind: 'down', pos: hurt.at, r: LYING });
      else bodies.add({ kind: 'person', pos: w.pos, vel: w.vel, r: PERSON_RADIUS, moving: w.speed > MOVING, dodges: w.walking, owner: w });
    }
  }

  update(dt: number, f: CrowdFrame): void {
    this.vehicles = f.vehicles;
    this.avoid = f.avoid;
    this.visitors = f.visitors;
    this.maintain(dt, f);
    for (let i = this.people.length - 1; i >= 0; i--) {
      const p = this.people[i];
      if (!p) continue;
      if (!p.hurt) {
        this.threats(p, f);
        p.stay -= dt;
        if (p.car && !f.visitors?.waiting(p.car)) p.car = null;
      }
      p.mind.tick(dt);
      if (p.mind.in('gone')) this.remove(i);
    }
  }

  // ---------------------------------------------------------------- the town, as people's minds use it

  pause(): number {
    return this.rng.range(C.pause[0], C.pause[1]);
  }

  strollFrom(at: Vector3): NavJob | null {
    const to = this.nav.spotNear(this.rng, at.x, at.z, C.stroll[0], C.stroll[1], NAV.person, STREET_LEVEL, true);
    const q = this.around();
    return to && !inZones(to, q.blocks ?? []) ? this.planner.request(at, to, NAV.person, q) : null;
  }

  walkTo(at: Vector3, car: Vehicle): NavJob {
    return this.planner.request(at, driverDoor(car, TUNING.valet.doorGap, _a).setY(car.pos.y), NAV.person, this.around());
  }

  dash(at: Vector3, from: Vector3): Polyline | null {
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

  fleeFrom(start: Vector3, from: Vector3): NavJob | null {
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
    return best ? this.planner.request(start, best, NAV.person, q) : null;
  }

  frightAt(at: Vector3): void {
    this.onFright?.(at);
  }

  dropMoney(at: Vector3, from: Vector3): void {
    this.drop(at, this.rng.chance(C.walletShare) ? 'wallet' : 'cash', from);
  }

  // ---------------------------------------------------------------- what happens to them

  private threats(p: Townsperson, f: CrowdFrame): void {
    const w = p.walker;
    if (this.struck(p, f)) return;
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
    if (along > 0 && along < C.carReach && Math.abs(dx * fz - dz * fx) < IN_THE_WAY) p.mind.send({ type: 'frightened', from: v.pos });
  }

  /**
   * Hit by a vehicle's body: hard enough and they go down (a casualty, maybe
   * knocking their money loose), else shoved aside and off they go. True if hit.
   */
  private struck(p: Townsperson, f: CrowdFrame): boolean {
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
        if (harm) {
          p.mind.send({ type: 'felled', from: v.pos, vx: v.vel.x, vz: v.vel.z, harm });
          return true;
        }
        _b.set(w.pos.x - _a.x, 0, w.pos.z - _a.z).normalize().multiplyScalar(SHOVE);
        if (!Number.isFinite(_b.x)) _b.set(Math.cos(v.yaw) * SHOVE, 0, -Math.sin(v.yaw) * SHOVE);
        _a.copy(w.pos).add(_b);
        _a.y = this.nav.heightAt(_a.x, w.pos.y, _a.z) ?? w.pos.y;
        w.place(_a, w.yaw);
        p.mind.send({ type: 'frightened', from: v.pos });
        return true;
      }
    }
    return false;
  }

  /** A walking route's query: round parked cars. */
  private around(): NavQuery {
    return { blocks: parkedBlocks(this.vehicles) };
  }

  private add(at: Vector3, yaw: number): Townsperson {
    const walker = new Walker(buildPerson(randomOutfit(this.rng)));
    walker.place(at, yaw);
    this.scene.add(walker.rig.root);
    const p = new Townsperson(walker, this);
    this.people.push(p);
    return p;
  }

  /** Keep the day or night count around the view: newcomers out at the edge of it, far ones gone. */
  private maintain(dt: number, f: CrowdFrame): void {
    for (let i = this.people.length - 1; i >= 0; i--) {
      const p = this.people[i];
      if (!p || (p.hurt?.at ?? p.walker.pos).distanceTo(f.near) < C.despawn) continue;
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
    const hurt = p.hurt;
    // whatever they were doing ends (a route being planned is called off)
    if (!p.mind.in('gone')) p.mind.go({ at: 'gone' });
    if (hurt) this.casualties?.remove(hurt);
    this.scene.remove(p.walker.rig.root);
    this.people.splice(i, 1);
  }
}
