import { Group, Vector3 } from 'three';
import { TUNING } from '../../config';
import { type Avoidance, PERSON_RADIUS } from '../../actors/avoidance';
import { driverDoor } from '../../actors/doors';
import { buildValet } from '../../actors/models/valet';
import type { Vehicle } from '../../actors/vehicle';
import { Walker } from '../../actors/walker';
import { done, type Result, running } from '../../engine/sim/action';
import type { Claims } from '../../engine/sim/claims';
import { type EventOf, Mind } from '../../engine/sim/mind';
import type { ValetDef, ZoneDef } from '../../world/level-data';
import { NAV, type NavGrid, type NavJob, type NavPlanner } from '../../world/nav-grid';
import { type Garage, type SpotRuntime, spotZone } from '../deck/garage';
import { type DriveAction, DriverJob, DriveTo, type DriveWorld, halt, Park, spotBerth } from '../driving/drive-actions';
import type { ClaimKind } from '../rules/claim-kinds';
import type { Drivers } from '../driving/drivers';
import type { Bodies } from '../rules/bodies';
import { type Attention, type Job, VALET_ATTENTION, VALET_JOB, type ValetEvents } from './valet-mind';

export type ValetState = keyof Job;

/** What the game gives the valets each frame. */
export interface ValetFrame {
  day: boolean;
  /** Everyone and everything a valet on foot steers around, or null to walk routes blind. */
  avoid: Avoidance | null;
  /** The car is in its spot (valet.badged: whether it went through the entry gate on the way). */
  parked: (v: Vehicle, spot: SpotRuntime, valet: Valet) => void;
}

const T = TUNING.valet;
/** A valet walking faster than this (m/s) is under way: traffic and drivers brake for him. */
const MOVING = 0.2;
/** Skin tones across the crew. */
const SKINS = ['#d9a07a', '#8a5a3c', '#f0c8a8', '#c48a64'];
/** Idle at the podium: rocking on his heels (rate, height), and an occasional wave (how often, how much of the time, arm lift, flap rate and size). */
const ROCK_RATE = 2.2;
const ROCK_HEIGHT = 0.03;
const WAVE_RATE = 0.7;
const WAVE_SHARE = 0.75;
const WAVE_LIFT = 2.4;
const WAVE_FLAP = 9;
const WAVE_FLAP_SIZE = 0.25;

const _v = new Vector3();

/** One of Foxy's valets: his body, where his stand is, and his two minds (the job, and whether he's paying someone attention). See valet-mind.ts. */
export class Valet {
  readonly job: Mind<Valet, Job, ValetEvents>;
  readonly attention: Mind<Valet, Attention, ValetEvents>;
  /** The car crossed the entry gate with him at the wheel. */
  badged = false;
  /** His own clock, for the idle rocking and waving. */
  t = Math.random() * 6;

  constructor(
    readonly crew: ValetService,
    readonly walker: Walker,
    readonly home: Vector3,
    readonly homeYaw: number,
  ) {
    this.job = new Mind<Valet, Job, ValetEvents>(VALET_JOB, this, { at: 'idle' });
    this.attention = new Mind<Valet, Attention, ValetEvents>(VALET_ATTENTION, this, { at: 'free' });
  }

  /** What he's doing. */
  get state(): ValetState {
    return this.job.state.at;
  }

  /** The car he's been handed, while he has it. */
  get car(): Vehicle | null {
    const s = this.job.state;
    return s.at === 'toCar' || s.at === 'boarding' || s.at === 'driving' ? s.car : null;
  }

  /** Sends `event` to both his minds. True if either moved. */
  send(event: EventOf<ValetEvents>): boolean {
    const job = this.job.send(event);
    const attention = this.attention.send(event);
    return job || attention;
  }

  /** Rocks on his heels with the odd wave at the street. */
  idleAnim(): void {
    const rig = this.walker.rig;
    rig.body.position.y = Math.max(0, Math.sin(this.t * ROCK_RATE)) * ROCK_HEIGHT;
    const wave = Math.max(0, Math.sin(this.t * WAVE_RATE) - WAVE_SHARE) / (1 - WAVE_SHARE);
    rig.armR.rotation.z = wave * WAVE_LIFT;
    rig.armR.rotation.x = -Math.sin(this.t * WAVE_FLAP) * WAVE_FLAP_SIZE * wave;
  }
}

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
 * stairwell to the podium. What each valet does is his minds' (valet-mind.ts);
 * this is the crew's stand and what their minds call on. Everything moves
 * through the shared planner, the real vehicle physics and the same route
 * followers as everyone else; at the wheel he's one of the game's drivers
 * (ValetDrive).
 */
export class ValetService {
  readonly root = new Group();
  readonly crew: Valet[] = [];
  /** Regions walking routes keep out of (parked cars); the game sets it. */
  walkBlocks: () => ZoneDef[] = () => [];
  private frame: ValetFrame = { day: true, avoid: null, parked: () => {} };

  constructor(
    defs: readonly ValetDef[],
    private readonly planner: NavPlanner,
    readonly nav: NavGrid,
    private readonly garage: Garage,
    private readonly drivers: Drivers,
    /** The spot a valet's taking a car to is booked ('spot') for as long as the job lasts. */
    private readonly claims: Claims<ClaimKind>,
  ) {
    let n = 0;
    for (const def of defs) {
      for (let i = 0; i < (def.crew ?? 2); i++) {
        const walker = new Walker(buildValet(SKINS[n++ % SKINS.length]));
        const home = new Vector3(def.pos[0] - i * T.spacing, def.pos[1], def.pos[2]);
        walker.place(home, def.yaw);
        this.root.add(walker.rig.root);
        this.crew.push(new Valet(this, walker, home, def.yaw));
      }
    }
  }

  /** Whether the stand's open this frame. */
  get day(): boolean {
    return this.frame.day;
  }

  /** Who valets on foot steer round this frame. */
  get avoid(): Avoidance | null {
    return this.frame.avoid;
  }

  /** Nearest valet Cody can talk to within reach of p: by day, at the stand or on his way back to it. */
  talkable(p: Vector3, reach: number, day: boolean): Valet | null {
    let best: Valet | null = null;
    let bd = reach;
    for (const v of this.crew) {
      // waiting at the stand, or on his way back to it (a bribe turns him round)
      if (!day || (!v.job.in('idle') && !v.job.in('returning'))) continue;
      const d = Math.hypot(v.walker.pos.x - p.x, v.walker.pos.z - p.z);
      if (d < bd && Math.abs(v.walker.pos.y - p.y) < 2.5) {
        bd = d;
        best = v;
      }
    }
    return best;
  }

  /** Valets walking around: people for traffic and autopilots to brake for. */
  addBodies(bodies: Bodies): void {
    for (const v of this.crew) {
      const w = v.walker;
      if (w.rig.root.visible) bodies.add({ kind: 'person', pos: w.pos, vel: w.vel, r: PERSON_RADIUS, moving: w.speed > MOVING, dodges: w.walking, owner: w });
    }
  }

  /** The valet who has this car, if one does. */
  driverOf(car: Vehicle): Valet | null {
    return this.crew.find((v) => v.car === car) ?? null;
  }

  /** Hand `car` to `valet` to park in `spot`: booked for the car till he's done. False if he's busy with another, or the spot isn't free. */
  take(valet: Valet, car: Vehicle, spot: SpotRuntime): boolean {
    if (!this.garage.isFree(spot, car) || !valet.send({ type: 'handedCar', car, spot })) return false;
    this.claims.take('spot', car, spot, { owner: valet });
    car.role = 'valet';
    car.vel.set(0, 0, 0);
    car.speed = 0;
    valet.badged = false;
    return true;
  }

  /** Cody stole the car out from under him: the job is off (its booking with it) and he walks back. */
  carjacked(car: Vehicle): Valet | null {
    const v = this.driverOf(car);
    if (!v) return null;
    v.send({ type: 'carjacked' });
    return v;
  }

  /** `v`'s job is over, done or not: the spot he was taking a car to isn't booked any more. */
  jobOver(v: Valet): void {
    this.claims.release(v);
  }

  update(dt: number, f: ValetFrame): void {
    this.frame = f;
    for (const v of this.crew) {
      v.t += dt;
      v.job.tick(dt);
      v.attention.tick(dt);
    }
  }

  /** Where the driver gets in or out: beside the car on its left. */
  doorOf(car: Vehicle, out = new Vector3()): Vector3 {
    driverDoor(car, T.doorGap, out);
    out.y = this.nav.heightAt(out.x, out.y, out.z) ?? car.pos.y;
    return out;
  }

  /** A walking route for `v` from where he is to `to`, round parked cars, by stairs or the lift. */
  walkTo(v: Valet, to: Vector3): NavJob {
    return this.planner.request(v.walker.pos, to, NAV.person, { blocks: this.walkBlocks(), elevators: true });
  }

  /** Puts a valet at the wheel of `car`, to park it in `spot`. Null if he couldn't take the seat. */
  startDrive(car: Vehicle, spot: SpotRuntime): ValetDrive | null {
    const drive = new ValetDrive({ car, spot });
    return this.drivers.start(drive) ? drive : null;
  }

  /** Whether `drive` is still going. */
  driving(drive: ValetDrive): boolean {
    return this.drivers.running(drive);
  }

  /** `v` parked `car` in `spot`: it's a parked car in the deck, in its spot, and the game is told. */
  parked(v: Valet, car: Vehicle, spot: SpotRuntime): void {
    this.garage.occupy(spot, car);
    car.role = 'parked';
    car.insideDeck = true;
    car.markRest();
    this.frame.parked(car, spot, v);
  }

  /** The job's off and the car never got to its spot: if nobody else has it, it's left parked where it is. */
  drop(car: Vehicle): void {
    if (car.role === 'valet') car.role = 'parked';
  }
}
