import { type Scene, Vector3 } from 'three';

import { type Avoidance, inZones, parkedBlocks, PERSON_RADIUS } from '@/actors/avoidance';
import { driverDoor } from '@/actors/doors';
import type { LootKind } from '@/actors/models/loot';
import { buildPerson, randomOutfit } from '@/actors/models/person';
import type { Vehicle } from '@/actors/vehicle';
import { Walker } from '@/actors/walker';
import { TUNING } from '@/config';
import type { Rng } from '@/engine/core/rng';
import { Polyline } from '@/engine/nav/polyline';
import { bodyOffsets } from '@/engine/physics/vehicle-params';
import type { Visitors } from '@/game/driving/visitors';
import type { Bodies } from '@/game/rules/bodies';
import { NAV, type NavGrid, type NavJob, type NavPlanner, type NavQuery } from '@/world/nav-grid';

import { Casualties } from './casualties';
import type { Prey } from './skeletons';
import { type Town, Townsperson } from './town-mind';

const C = TUNING.crowd;

/** Maximum destination height for street pedestrians, in meters. */
const STREET_LEVEL = 0.6;
/** Minimum interval between pedestrian spawns, in seconds. */
const SPAWN_EVERY = 0.4;
/** Initial escape distance and terrain sampling interval, in meters, while a longer route is planned. */
const DASH = 5;
const DASH_STEP = 0.5;
/** Number of escape destinations sampled before choosing the farthest from the threat. */
const FLEE_TRIES = 6;
/** Lateral and vertical range in meters for vehicle threat checks. */
const IN_THE_WAY = 2;
/** Extra vehicle contact radius and horizontal shove distance, in meters. */
const CLIP = 0.4;
const SHOVE = 1.2;
/** Speed threshold in m/s for registering a pedestrian as moving traffic. */
const MOVING = 0.2;
/** Minimum interval between visitor arrival requests, in seconds. */
const SEND_EVERY = 1.5;
/** Maximum attempts to find a distant spawn for a returning car owner. */
const COME_BACK_TRIES = 6;
/** Obstacle radius for fallen pedestrians, in meters. */
const LYING = 0.8;

export interface CrowdFrame {
  /** View target used for pedestrian population management. */
  near: Vector3;
  day: boolean;
  /** The car Cody is driving, or null. */
  driving: Vehicle | null;
  /** Vehicles considered for pedestrian collision checks. */
  vehicles: readonly Vehicle[];
  /** Dynamic walking avoidance; null disables obstacle steering. */
  avoid: Avoidance | null;
  /** Visitor arrival and departure service; null permits direct pedestrian spawning. */
  visitors: Visitors | null;
}

const _a = new Vector3();
const _b = new Vector3();
/** Health threshold for being knocked down by claws; zero health is fatal. */
const MAULED = 50;
/** Horizontal launch speed from a claw knockdown, in m/s. */
const CLAW_FLING = 3;

/**
 * Manage pedestrian population, visitor drivers, navigation requests, and physical threats. Townsperson state machines
 * in town-mind.ts control individual behavior. Expose living or fallen victims to skeletons and register bodies for
 * steering.
 */
export class Crowd implements Prey, Town {
  private readonly people: Townsperson[] = [];
  private spawnIn = 0;
  /** Notify the game when a pedestrian begins a fresh fright response. */
  onFright: ((at: Vector3) => void) | null = null;
  /** Vehicles from the current frame, used to block walking routes. */
  private vehicles: readonly Vehicle[] = [];
  avoid: Avoidance | null = null;
  visitors: Visitors | null = null;

  constructor(
    private readonly scene: Scene,
    private readonly planner: NavPlanner,
    readonly nav: NavGrid,
    readonly rng: Rng,
    /** Emit a money drop with its kind and threat position. */
    private readonly drop: (at: Vector3, kind: LootKind, from: Vector3) => void,
    /** Optional ragdoll and injury simulation; without it, vehicle contacts only shove pedestrians. */
    readonly casualties: Casualties | null = null,
  ) {}

  get count(): number {
    return this.people.length;
  }

  /** Return the nearest eligible living victim within horizontal reach and vertical tolerance, or null. */
  victimNear(at: Vector3, reach: number, sameLevel: number, may: (v: object) => boolean): object | null {
    let best: Townsperson | null = null;
    let bd = reach * reach;
    for (const p of this.people) {
      const hurt = p.hurt;
      if (hurt?.harm === 'dead' || !may(p)) {
        continue;
      }

      const q = hurt ? hurt.at : p.walker.pos;
      if (Math.abs(q.y - at.y) > sameLevel) {
        continue;
      }

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
    if (!p || hurt?.harm === 'dead') {
      return false;
    }

    out.copy(hurt ? hurt.at : p.walker.pos);
    return true;
  }

  /**
   * Apply a claw attack. Standing victims lose health and may flee or fall; fallen victims escalate one injury level.
   * Return the resulting hit category.
   */
  maul(v: object, from: Vector3, damage: number): 'hit' | 'downed' | 'killed' {
    const p = this.people.find((q) => q === v);
    if (!p) {
      return 'hit';
    }

    const c = this.casualties;
    p.hp -= damage;

    if (!c) {
      p.mind.send({ type: 'frightened', from });
      return 'hit';
    }

    const hurt = p.hurt;
    if (hurt) {
      return c.maul(hurt, from) === 'dead' ? 'killed' : 'downed';
    }

    const w = p.walker;
    c.cut(w.pos, from);

    if (p.hp > MAULED) {
      p.mind.send({ type: 'frightened', from });
      return 'hit';
    }

    _b.set(w.pos.x - from.x, 0, w.pos.z - from.z)
      .normalize()
      .multiplyScalar(CLAW_FLING);

    if (!Number.isFinite(_b.x)) {
      _b.set(CLAW_FLING, 0, 0);
    }

    p.mind.send({ type: 'felled', from, vx: _b.x, vz: _b.z, harm: p.hp <= 0 ? 'dead' : 'injured' });
    return p.hp <= 0 ? 'killed' : 'downed';
  }

  /** Spawn the driver at the driver door and make them flee from `from`. */
  bail(car: Vehicle, from: Vector3): void {
    const door = driverDoor(car, TUNING.valet.doorGap, new Vector3());
    door.y = this.nav.heightAt(door.x, car.pos.y, door.z) ?? car.pos.y;
    this.add(door, car.yaw - Math.PI / 2).mind.send({ type: 'frightened', from });
  }

  /** Spawn a visitor’s pedestrian driver and associate the parked car for a later return. */
  arrive(car: Vehicle): void {
    const door = driverDoor(car, TUNING.valet.doorGap, new Vector3());
    door.y = this.nav.heightAt(door.x, car.pos.y, door.z) ?? car.pos.y;
    const p = this.add(door, car.yaw - Math.PI / 2);
    p.car = car;
    p.stay = this.rng.range(C.stay[0], C.stay[1]);
  }

  /** Return pedestrians without an active casualty for perception processing. */
  living(): readonly Townsperson[] {
    return this.people.filter((p) => !p.hurt);
  }

  /** Deliver a fright event selected by the reaction system. */
  frighten(p: Townsperson, from: Vector3): void {
    p.mind.send({ type: 'frightened', from });
  }

  /** Register upright and fallen pedestrians for steering and braking queries. */
  addBodies(bodies: Bodies): void {
    for (const p of this.people) {
      const w = p.walker;
      const hurt = p.hurt;
      if (hurt) {
        bodies.add({ kind: 'down', pos: hurt.at, r: LYING });
      } else {
        bodies.add({
          kind: 'person',
          pos: w.pos,
          vel: w.vel,
          r: PERSON_RADIUS,
          moving: w.speed > MOVING,
          dodges: w.walking,
          owner: w,
        });
      }
    }
  }

  update(dt: number, f: CrowdFrame): void {
    this.vehicles = f.vehicles;
    this.avoid = f.avoid;
    this.visitors = f.visitors;
    this.maintain(dt, f);

    for (let i = this.people.length - 1; i >= 0; i--) {
      const p = this.people[i];
      if (!p) {
        continue;
      }

      if (!p.hurt) {
        this.threats(p, f);
        p.stay -= dt;

        if (p.car && !f.visitors?.waiting(p.car)) {
          p.car = null;
        }
      }

      p.mind.tick(dt);

      if (p.mind.in('gone')) {
        this.remove(i);
      }
    }
  }

  pause(): number {
    return this.rng.range(C.pause[0], C.pause[1]);
  }

  strollFrom(at: Vector3): NavJob | null {
    const to = this.nav.spotNear(this.rng, at.x, at.z, C.stroll[0], C.stroll[1], NAV.person, STREET_LEVEL, true);
    const q = this.around();
    return to && !inZones(to, q.blocks ?? []) ? this.planner.request(at, to, NAV.person, q) : null;
  }

  walkTo(at: Vector3, car: Vehicle): NavJob {
    return this.planner.request(
      at,
      driverDoor(car, TUNING.valet.doorGap, _a).setY(car.pos.y),
      NAV.person,
      this.around(),
    );
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
      if (g === null) {
        break;
      }

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

  private threats(p: Townsperson, f: CrowdFrame): void {
    const w = p.walker;
    if (this.struck(p, f)) {
      return;
    }

    const v = f.driving;
    if (!v || Math.abs(v.pos.y - w.pos.y) > IN_THE_WAY) {
      return;
    }

    // Only sufficiently fast approaching player vehicles trigger anticipatory fright.
    if (Math.abs(v.speed) < C.carSpeed) {
      return;
    }

    const dir = Math.sign(v.speed);
    const fx = Math.sin(v.yaw) * dir;
    const fz = Math.cos(v.yaw) * dir;
    const dx = w.pos.x - v.pos.x;
    const dz = w.pos.z - v.pos.z;
    const along = dx * fx + dz * fz;
    if (along > 0 && along < C.carReach && Math.abs(dx * fz - dz * fx) < IN_THE_WAY) {
      p.mind.send({ type: 'frightened', from: v.pos });
    }
  }

  /**
   * Test vehicle-circle contacts. Knock the pedestrian down if the impact causes injury; otherwise shove and frighten
   * them. Return whether a contact was handled.
   */
  private struck(p: Townsperson, f: CrowdFrame): boolean {
    const w = p.walker;
    for (const v of f.vehicles) {
      if (v.gone || Math.abs(v.pos.y - w.pos.y) > IN_THE_WAY) {
        continue;
      }

      const moving = v.vel.x * v.vel.x + v.vel.z * v.vel.z > 1;
      if (!moving && v !== f.driving) {
        continue;
      }

      for (const o of bodyOffsets(v.params)) {
        _a.set(v.pos.x + Math.sin(v.yaw) * o, w.pos.y, v.pos.z + Math.cos(v.yaw) * o);
        const ox = w.pos.x - _a.x;
        const oz = w.pos.z - _a.z;
        const d = Math.sqrt(ox * ox + oz * oz);
        if (d >= v.params.radius + CLIP) {
          continue;
        }

        // Measure vehicle velocity toward the pedestrian along the contact normal.
        const impact =
          d > 1e-3 ? (v.vel.x * (w.pos.x - _a.x) + v.vel.z * (w.pos.z - _a.z)) / d : Math.hypot(v.vel.x, v.vel.z);
        const harm = this.casualties ? Casualties.harmFor(impact, v.mass) : null;
        if (harm) {
          p.mind.send({ type: 'felled', from: v.pos, vx: v.vel.x, vz: v.vel.z, harm });
          return true;
        }

        _b.set(w.pos.x - _a.x, 0, w.pos.z - _a.z)
          .normalize()
          .multiplyScalar(SHOVE);

        if (!Number.isFinite(_b.x)) {
          _b.set(Math.cos(v.yaw) * SHOVE, 0, -Math.sin(v.yaw) * SHOVE);
        }

        _a.copy(w.pos).add(_b);
        _a.y = this.nav.heightAt(_a.x, w.pos.y, _a.z) ?? w.pos.y;
        w.nudge(_a);
        p.mind.send({ type: 'frightened', from: v.pos });
        return true;
      }
    }

    return false;
  }

  /** Build a walking query that excludes parked vehicle footprints. */
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

  /** Remove distant pedestrians and replenish toward the day/night target, including pending visitor arrivals. */
  private maintain(dt: number, f: CrowdFrame): void {
    for (let i = this.people.length - 1; i >= 0; i--) {
      const p = this.people[i];
      if (!p || (p.hurt?.at ?? p.walker.pos).distanceTo(f.near) < C.despawn) {
        continue;
      }

      // Mark an associated car for distant removal when its owner despawns.
      if (p.car) {
        f.visitors?.orphan(p.car);
      }

      this.remove(i);
    }

    this.spawnIn -= dt;
    const v = f.visitors;
    if (this.spawnIn > 0 || this.people.length + (v?.incoming ?? 0) >= (f.day ? C.day : C.night)) {
      return;
    }

    // Use vehicle arrivals when parking bays exist; otherwise spawn pedestrians directly.
    if (v?.hasBays) {
      this.spawnIn = SEND_EVERY;

      // If arrival cannot be queued, try returning an owner to an existing parked car.
      if (!v.send(f.near)) {
        this.comeBack(v, f.near);
      }

      return;
    }

    this.spawnIn = SPAWN_EVERY;
    const at = this.nav.spotNear(this.rng, f.near.x, f.near.z, C.spawnMin, C.spawnMax, NAV.person, STREET_LEVEL, true);
    if (at) {
      this.add(at, this.rng.range(0, Math.PI * 2));
    }
  }

  /** Spawn an owner beyond the minimum view distance and associate a parked car for immediate return. */
  private comeBack(v: Visitors, near: Vector3): void {
    const car = v.claim(near);
    if (!car) {
      return;
    }

    for (let t = 0; t < COME_BACK_TRIES; t++) {
      const at = this.nav.spotNear(
        this.rng,
        car.pos.x,
        car.pos.z,
        C.stroll[0],
        C.stroll[1],
        NAV.person,
        STREET_LEVEL,
        true,
      );
      if (!at || at.distanceTo(near) < C.spawnMin) {
        continue;
      }

      // Leave the stay timer at zero so the owner returns immediately.
      this.add(at, this.rng.range(0, Math.PI * 2)).car = car;
      return;
    }

    v.unclaim(car);
  }

  private remove(i: number): void {
    const p = this.people[i];
    if (!p) {
      return;
    }

    const hurt = p.hurt;
    // Exit the active state so pending route requests are cancelled.
    if (!p.mind.in('gone')) {
      p.mind.go({ at: 'gone' });
    }

    if (hurt) {
      this.casualties?.remove(hurt);
    }

    this.scene.remove(p.walker.rig.root);
    this.people.splice(i, 1);
  }
}
