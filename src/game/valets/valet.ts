import { Group, Vector3 } from 'three';
import { TUNING } from '../../config';
import type { Avoidance } from '../../actors/avoidance';
import { driverDoor } from '../../actors/doors';
import { buildValet } from '../../actors/models/valet';
import type { Vehicle } from '../../actors/vehicle';
import { Walker } from '../../actors/walker';
import { done, type Result, running } from '../../engine/sim/action';
import type { ValetDef, ZoneDef } from '../../world/level-data';
import { NAV, type NavGrid, type NavJob, type NavPlanner } from '../../world/nav-grid';
import { type Garage, type SpotRuntime, spotZone } from '../deck/garage';
import { type DriveAction, DriverJob, DriveTo, type DriveWorld, halt, Park, spotBerth } from '../driving/drive-actions';
import type { Drivers } from '../driving/drivers';

export type ValetState = 'idle' | 'toCar' | 'boarding' | 'driving' | 'returning' | 'off';

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
  /** At the wheel: the drive to the spot. */
  drive: ValetDrive | null;
  /** Held in a conversation: stands still and faces Cody. */
  held: boolean;
  t: number;
}

/** What the game gives the valets each frame. */
export interface ValetFrame {
  day: boolean;
  /** Everyone and everything a valet on foot steers around, or null to walk routes blind. */
  avoid: Avoidance | null;
  /** The car is in its spot (valet.badged: whether it went through the entry gate on the way). */
  parked: (v: Vehicle, spot: SpotRuntime, valet: Valet) => void;
}

const T = TUNING.valet;
/** Skin tones across the crew. */
const SKINS = ['#d9a07a', '#8a5a3c', '#f0c8a8', '#c48a64'];
/** Back home once within this of the podium spot. */
const HOME_EPS = 0.5;
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
 * A valet at the wheel: drives the car to its spot in the deck, in through the entry gate, and
 * eases it in. Spooked by phantom Cody, he steers clear of him like anyone. Knocked into a crash,
 * he waits it out, rights the car if it lands on its side or roof, and sets off again from
 * wherever it came to rest. No route, or wedged twice, and the car turns up in its spot in a
 * puff: he "knows a shortcut".
 */
export class ValetDrive extends DriverJob {
  /** The car's in its spot. */
  parked = false;
  /** It went through the entry gate on the way. */
  badged = false;
  /** Seconds the car has been crashing, and of that, lying still on its side or roof. */
  private wreck = 0;
  private upended = 0;

  constructor(readonly p: { car: Vehicle; spot: SpotRuntime }) {
    super(p.car, 'valet');
    this.next(this.toSpot());
  }

  protected drive(w: DriveWorld, dt: number, seen: Vector3 | null): Result<DriveAction> {
    const { car, spot } = this.p;
    if (this.wreck > 0) {
      // the crash is over: a fresh route from wherever it came to rest
      this.wreck = 0;
      this.upended = 0;
      this.next(this.toSpot());
    }
    if (seen) this.steerClear(seen);
    const stage = this.stage;
    if (!stage) return done;
    const result = stage.perform(w, dt);
    if (stage instanceof DriveTo && stage.badged) this.badged = true;
    if ('fail' in result) {
      // the shortcut
      w.place(car, spot.center, spot.def.yaw, 0);
      halt(car);
      this.parked = true;
      return done;
    }
    if (!('done' in result)) return running;
    if (stage instanceof DriveTo) {
      this.next(new Park({ car, berth: spotBerth(spot) }));
      return running;
    }
    this.parked = true;
    return done;
  }

  /** Hands off while it tumbles (the game steps it); righted if it ends up on its side or roof. */
  protected crashed(w: DriveWorld, dt: number): Result<DriveAction> {
    const { car } = this.p;
    this.wreck += dt;
    this.upended = car.resting ? this.upended + dt : 0;
    if (this.upended > T.rightAfter) {
      // ends the crash: back on its wheels where it lies
      w.place(car, _v.set(car.pos.x, w.nav.heightAt(car.pos.x, car.pos.y, car.pos.z, NAV.car) ?? car.pos.y, car.pos.z), car.yaw, 0);
    }
    return running;
  }

  private toSpot(): DriveTo {
    const { car, spot } = this.p;
    return new DriveTo({ car, to: spot.center, yaw: spot.def.yaw, eitherWay: true, allow: spotZone(spot, 0), badgeIn: true });
  }
}

/**
 * Foxy's valet crew. Hand one your keys and he walks to the car, drives it
 * over to the deck along a planned route (badging in at the entry gate, up the
 * ramps), eases it into the highest free spot, then walks back down the
 * stairwell to the podium. Everything moves through the shared planner, the
 * real vehicle physics and the same route followers as everyone else; at the
 * wheel he's one of the game's drivers (ValetDrive).
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
    private readonly garage: Garage,
    private readonly drivers: Drivers,
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
          drive: null,
          held: false,
          t: Math.random() * 6,
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
    valet.state = 'toCar';
    valet.walkJob = this.planner.request(valet.walker.pos, this.doorOf(car, _v), NAV.person, { blocks: this.walkBlocks(), elevators: true });
  }

  /** Cody stole the car out from under him: the job is off and he walks back. */
  carjacked(car: Vehicle): Valet | null {
    const v = this.driverOf(car);
    if (!v) return null;
    this.garage.release(car);
    if (v.state === 'boarding' || v.state === 'driving') {
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
          if (v.t <= T.boardTime) break;
          w.rig.root.visible = false;
          const car = v.car as Vehicle;
          const spot = v.spot as SpotRuntime;
          v.drive = new ValetDrive({ car, spot });
          v.state = 'driving';
          if (!this.drivers.start(v.drive)) this.carjacked(car);
          break;
        }
        case 'driving': {
          const job = v.drive;
          if (!job || this.drivers.running(job)) break;
          // over: in its spot, or the car's gone from under him
          v.badged = job.badged;
          if (job.parked) this.finishParking(v, f);
          else this.carjacked(job.car);
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

  /** Where the driver gets in or out: beside the car on its left. */
  doorOf(car: Vehicle, out: Vector3): Vector3 {
    driverDoor(car, T.doorGap, out);
    out.y = this.nav.heightAt(out.x, out.y, out.z) ?? car.pos.y;
    return out;
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

  private goHome(v: Valet): void {
    v.car = null;
    v.spot = null;
    v.drive = null;
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

