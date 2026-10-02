import { Group, Vector3 } from 'three';
import { TUNING } from '../config';
import { smoothstep, wrapAngle } from '../core/math';
import { Autopilot } from '../actors/autopilot';
import type { Avoidance } from '../actors/avoidance';
import { driverDoor } from '../actors/doors';
import { buildValet } from '../actors/models/valet';
import type { Vehicle } from '../actors/vehicle';
import { Walker } from '../actors/walker';
import type { CollisionWorld } from '../world/collision';
import type { ValetDef, ZoneDef } from '../world/level-data';
import { NAV, type NavGrid, type NavJob, type NavPlanner } from '../world/nav-grid';
import type { Garage, SpotRuntime } from './garage';

export type ValetState = 'idle' | 'toCar' | 'boarding' | 'driving' | 'parking' | 'returning' | 'off';

export interface Valet {
  readonly walker: Walker;
  readonly home: Vector3;
  readonly homeYaw: number;
  state: ValetState;
  car: Vehicle | null;
  spot: SpotRuntime | null;
  /** The car crossed the entry gate with him at the wheel. */
  badged: boolean;
  walkJob: NavJob | null;
  driveJob: NavJob | null;
  pilot: Autopilot | null;
  /** Easing the car into its spot. */
  settle: { t: number; from: Vector3; fromYaw: number; toYaw: number } | null;
  /** Held in a conversation: stands still and faces Cody. */
  held: boolean;
  t: number;
  replanned: boolean;
  /** Seconds his car has been crashing, and of that, lying still on its side or roof. */
  wreck: number;
  upended: number;
}

/** What the game gives the valets each frame. */
export interface ValetFrame {
  day: boolean;
  /** Positions to brake for: other vehicles, people. */
  obstacles: readonly Vector3[];
  /** Everyone and everything a valet on foot steers around, or null to walk routes blind. */
  avoid: Avoidance | null;
  /** A car crossed the deck footprint (the badge log); returns true if it logged an entry. */
  track: (v: Vehicle, prev: Vector3) => boolean;
  /** The car is in its spot (valet.badged: whether it went through the entry gate on the way). */
  parked: (v: Vehicle, spot: SpotRuntime, valet: Valet) => void;
}

const T = TUNING.valet;
/** Skin tones across the crew. */
const SKINS = ['#d9a07a', '#8a5a3c', '#f0c8a8', '#c48a64'];
/** Back home once within this of the podium spot. */
const HOME_EPS = 0.5;
/** Parked cars block their spot shrunk by this much (so a neighbour's spot edge stays drivable). */
const SPOT_INSET = 0.3;
/** A spot's region runs from just under its floor to above car height. */
const SPOT_BELOW = 0.3;
const SPOT_ABOVE = 2;
/** Idle at the podium: rocking on his heels (rate, height), and an occasional wave (how often, how much of the time, arm lift, flap rate and size). */
const ROCK_RATE = 2.2;
const ROCK_HEIGHT = 0.03;
const WAVE_RATE = 0.7;
const WAVE_SHARE = 0.75;
const WAVE_LIFT = 2.4;
const WAVE_FLAP = 9;
const WAVE_FLAP_SIZE = 0.25;

const _v = new Vector3();

/**
 * Foxy's valet crew. Hand one your keys and he walks to the car, drives it
 * over to the deck along a planned route (badging in at the entry gate, up the
 * ramps), eases it into the highest free spot, then walks back down the
 * stairwell to the podium. Everything moves through the shared planner, the
 * real vehicle physics and the same route followers as everyone else.
 */
export class ValetService {
  readonly root = new Group();
  readonly crew: Valet[] = [];
  /** Regions walking routes keep out of (parked cars); the game sets it. */
  walkBlocks: () => ZoneDef[] = () => [];

  constructor(
    defs: readonly ValetDef[],
    private readonly planner: NavPlanner,
    private readonly nav: NavGrid,
    private readonly collision: CollisionWorld,
    private readonly garage: Garage,
    /** Exit-lane blocks, so valets badge in through the entry gate. */
    private readonly entryOnly: readonly ZoneDef[],
  ) {
    let n = 0;
    for (const def of defs) {
      for (let i = 0; i < (def.crew ?? 2); i++) {
        const walker = new Walker(buildValet(SKINS[n++ % SKINS.length]));
        const home = new Vector3(def.pos[0] - i * T.spacing, def.pos[1], def.pos[2]);
        walker.place(home, def.yaw);
        this.root.add(walker.rig.root);
        this.crew.push({
          walker,
          home,
          homeYaw: def.yaw,
          state: 'idle',
          car: null,
          spot: null,
          badged: false,
          walkJob: null,
          driveJob: null,
          pilot: null,
          settle: null,
          held: false,
          t: Math.random() * 6,
          replanned: false,
          wreck: 0,
          upended: 0,
        });
      }
    }
  }

  /** Nearest valet Cody can talk to within reach of p (idle at the podium by day). */
  talkable(p: Vector3, reach: number, day: boolean): Valet | null {
    let best: Valet | null = null;
    let bd = reach;
    for (const v of this.crew) {
      // waiting at the stand, or on his way back to it (a bribe turns him round)
      if (!day || (v.state !== 'idle' && v.state !== 'returning')) continue;
      const d = Math.hypot(v.walker.pos.x - p.x, v.walker.pos.z - p.z);
      if (d < bd && Math.abs(v.walker.pos.y - p.y) < 2.5) {
        bd = d;
        best = v;
      }
    }
    return best;
  }

  /** Valets walking around: people for traffic and autopilots to brake for. */
  pedestrians(out: Vector3[]): void {
    for (const v of this.crew) if (v.walker.rig.root.visible && v.walker.speed > 0.2) out.push(v.walker.pos);
  }

  /** The valet driving (or about to drive) this car. */
  driverOf(car: Vehicle): Valet | null {
    return this.crew.find((v) => v.car === car) ?? null;
  }

  /** Hand `car` to `valet` to park in `spot`. */
  take(valet: Valet, car: Vehicle, spot: SpotRuntime): void {
    // bribed on his way back: that walk's off
    valet.walkJob?.cancel();
    this.garage.occupy(spot, car);
    car.role = 'valet';
    car.vel.set(0, 0, 0);
    car.speed = 0;
    valet.car = car;
    valet.spot = spot;
    valet.badged = false;
    valet.held = false;
    valet.replanned = false;
    valet.state = 'toCar';
    valet.walkJob = this.planner.request(valet.walker.pos, this.doorOf(car, _v), NAV.person, { blocks: this.walkBlocks(), elevators: true });
    valet.driveJob = this.planDrive(car, spot);
  }

  /** Cody stole the car out from under him: the job is off and he walks back. */
  carjacked(car: Vehicle): Valet | null {
    const v = this.driverOf(car);
    if (!v) return null;
    this.garage.release(car);
    if (v.state === 'boarding' || v.state === 'driving' || v.state === 'parking') {
      const door = this.doorOf(car, new Vector3());
      v.walker.place(door, car.yaw + Math.PI / 2);
      v.walker.rig.root.visible = true;
    }
    this.goHome(v);
    return v;
  }

  update(dt: number, f: ValetFrame): void {
    for (const v of this.crew) {
      v.t += dt;
      const w = v.walker;
      if (this.wrecked(v, dt)) continue;
      switch (v.state) {
        case 'off':
          if (f.day) {
            w.place(v.home, v.homeYaw);
            w.rig.root.visible = true;
            v.state = 'idle';
          }
          break;
        case 'idle':
          if (!f.day && !v.held) {
            // closing time: the crew goes inside
            w.rig.root.visible = false;
            v.state = 'off';
            break;
          }
          w.update(dt, this.nav);
          if (!v.held) this.idleAnim(v);
          break;
        case 'toCar': {
          const car = v.car as Vehicle;
          if (v.walkJob?.settled) {
            if (v.walkJob.path) w.follow(v.walkJob.path, T.walkPace);
            else w.place(this.doorOf(car, _v), car.yaw);
            v.walkJob = null;
          }
          if (w.update(dt, this.nav, f.avoid) || (!v.walkJob && !w.walking)) {
            w.face(car.pos);
            v.state = 'boarding';
            v.t = 0;
          }
          break;
        }
        case 'boarding': {
          w.update(dt, this.nav);
          if (v.t > T.boardTime) w.rig.root.visible = false;
          if (v.t > T.boardTime && v.driveJob?.settled) {
            const legs = v.driveJob.legs;
            v.driveJob = null;
            if (legs) {
              const car = v.car as Vehicle;
              v.pilot = new Autopilot(legs, { inDeck: (p) => this.garage.inFootprint(p), nav: this.nav, profile: NAV.car }, car.params);
              v.state = 'driving';
            } else {
              this.teleportPark(v, f);
            }
          }
          break;
        }
        case 'driving': {
          const car = v.car as Vehicle;
          const pilot = v.pilot as Autopilot;
          const obstacles = f.obstacles.filter((o) => o !== car.pos);
          const input = pilot.update(dt, car, obstacles);
          const prev = car.pos.clone();
          car.drive(dt, input, this.collision);
          if (f.track(car, prev)) v.badged = true;
          if (pilot.state === 'arrived') {
            const s = v.spot as SpotRuntime;
            const flip = Math.cos(car.yaw - s.def.yaw) < 0;
            v.settle = { t: 0, from: car.pos.clone(), fromYaw: car.yaw, toYaw: s.def.yaw + (flip ? Math.PI : 0) };
            v.state = 'parking';
          } else if (pilot.state === 'stuck') {
            if (!v.replanned) {
              // one fresh route from wherever he wedged himself, then give up gracefully
              v.replanned = true;
              v.driveJob = this.planDrive(car, v.spot as SpotRuntime);
              v.pilot = null;
              v.state = 'boarding';
              v.t = T.boardTime;
            } else {
              this.teleportPark(v, f);
            }
          }
          break;
        }
        case 'parking': {
          const car = v.car as Vehicle;
          const s = v.spot as SpotRuntime;
          const st = v.settle as NonNullable<Valet['settle']>;
          st.t += dt;
          const k = Math.min(1, st.t / T.settleTime);
          const e = smoothstep(0, 1, k);
          const dy = wrapAngle(st.toYaw - st.fromYaw);
          _v.lerpVectors(st.from, s.center, e);
          car.place(_v.x, _v.y, _v.z, st.fromYaw + dy * e, 0, dt, this.collision);
          if (k >= 1) this.finishParking(v, f);
          break;
        }
        case 'returning':
          if (v.walkJob?.settled) {
            if (v.walkJob.path) w.follow(v.walkJob.path, T.jogPace);
            else w.place(v.home, v.homeYaw);
            v.walkJob = null;
          }
          if (v.held) {
            w.stop();
            w.update(dt, this.nav);
            break;
          }
          if (w.update(dt, this.nav, f.avoid) || (!v.walkJob && !w.walking && w.pos.distanceTo(v.home) < HOME_EPS)) {
            w.face(_v.copy(v.home).add(new Vector3(Math.sin(v.homeYaw), 0, Math.cos(v.homeYaw))));
            v.state = 'idle';
          } else if (!v.walkJob && !w.walking) {
            // stopped short (a conversation, a replan): head home again
            v.walkJob = this.planner.request(w.pos, v.home, NAV.person, { blocks: this.walkBlocks(), elevators: true });
          }
          break;
      }
    }
  }

  /**
   * His car got knocked into a crash: hands off while it tumbles (the game
   * steps it), right it if it ends up on its side or roof, then a fresh route
   * from wherever it came to rest. True while that's going on.
   */
  private wrecked(v: Valet, dt: number): boolean {
    const car = v.car;
    if (!car || (v.state !== 'driving' && v.state !== 'parking')) return false;
    if (car.crashing) {
      v.wreck += dt;
      v.settle = null;
      v.upended = car.resting ? v.upended + dt : 0;
      if (v.upended > T.rightAfter) {
        // ends the crash: back on its wheels where it lies
        car.place(car.pos.x, this.nav.heightAt(car.pos.x, car.pos.y, car.pos.z, NAV.car) ?? car.pos.y, car.pos.z, car.yaw, 0, 0, this.collision);
      }
      return true;
    }
    if (v.wreck === 0) return false;
    v.wreck = 0;
    v.upended = 0;
    v.pilot = null;
    v.driveJob?.cancel();
    v.driveJob = this.planDrive(car, v.spot as SpotRuntime);
    v.replanned = false;
    v.state = 'boarding';
    v.t = T.boardTime;
    return true;
  }

  /** Where the driver gets in or out: beside the car on its left. */
  doorOf(car: Vehicle, out: Vector3): Vector3 {
    driverDoor(car, T.doorGap, out);
    out.y = this.nav.heightAt(out.x, out.y, out.z) ?? car.pos.y;
    return out;
  }

  private planDrive(car: Vehicle, spot: SpotRuntime): NavJob {
    // parked cars are in the way, on their own floor; his own spot isn't
    const blocks: ZoneDef[] = car.insideDeck ? [] : [...this.entryOnly];
    for (const s of this.garage.spots) {
      if (s !== spot && s.occupant && s.occupant !== car) blocks.push(spotZone(s, -SPOT_INSET));
    }
    return this.planner.request(car.pos, spot.center, NAV.car, { blocks, allow: spotZone(spot, 0), drive: { yaw: car.yaw, endYaw: spot.def.yaw, eitherWay: true } });
  }

  private finishParking(v: Valet, f: ValetFrame): void {
    const car = v.car as Vehicle;
    const s = v.spot as SpotRuntime;
    car.role = 'parked';
    car.insideDeck = true;
    car.restPos.copy(car.pos);
    car.restYaw = car.yaw;
    f.parked(car, s, v);
    v.walker.place(this.doorOf(car, _v), car.yaw + Math.PI / 2);
    v.walker.rig.root.visible = true;
    this.goHome(v);
  }

  /** No route, or wedged twice: the car turns up in its spot in a puff (the valet "knows a shortcut"). */
  private teleportPark(v: Valet, f: ValetFrame): void {
    const car = v.car as Vehicle;
    const s = v.spot as SpotRuntime;
    car.place(s.center.x, s.center.y, s.center.z, s.def.yaw, 0, 0, null);
    this.finishParking(v, f);
  }

  private goHome(v: Valet): void {
    v.car = null;
    v.spot = null;
    v.pilot = null;
    v.settle = null;
    v.driveJob?.cancel();
    v.driveJob = null;
    v.walkJob?.cancel();
    v.walkJob = this.planner.request(v.walker.pos, v.home, NAV.person, { blocks: this.walkBlocks(), elevators: true });
    v.held = false;
    v.state = 'returning';
  }

  private idleAnim(v: Valet): void {
    // rocks on his heels with the odd wave at the street
    const rig = v.walker.rig;
    rig.body.position.y = Math.max(0, Math.sin(v.t * ROCK_RATE)) * ROCK_HEIGHT;
    const wave = Math.max(0, Math.sin(v.t * WAVE_RATE) - WAVE_SHARE) / (1 - WAVE_SHARE);
    rig.armR.rotation.z = wave * WAVE_LIFT;
    rig.armR.rotation.x = -Math.sin(v.t * WAVE_FLAP) * WAVE_FLAP_SIZE * wave;
  }
}

/** A spot's region: its painted rectangle (grown or shrunk by `pad`) from the floor to car height. */
export function spotZone(s: SpotRuntime, pad: number): ZoneDef {
  const [w, d] = s.def.size;
  const c = s.center;
  return { min: [c.x - w / 2 - pad, c.y - SPOT_BELOW, c.z - d / 2 - pad], max: [c.x + w / 2 + pad, c.y + SPOT_ABOVE, c.z + d / 2 + pad] };
}
