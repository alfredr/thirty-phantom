import type { Vehicle } from '../actors/vehicle';
import type { Action as Control } from '../core/input';
import { Action, done, fail, type Fail, type Result } from '../engine/sim/action';
import type { Candidate } from '../engine/sim/offers';
import type { Elevator } from '../world/elevators';
import type { CodyState } from './cody-state';
import type { Npc } from './npcs';
import type { Valet } from './valet';
import type { WorldConditions } from './world-conditions';

/**
 * What Cody's actions need from the game. The game provides this narrow view, and actions never
 * reach past it, so each action's dependencies are visible in one place.
 */
export interface Play {
  readonly cody: CodyState;
  readonly conditions: WorldConditions;
  /** The vehicle Cody is driving, or null. */
  ride(): Vehicle | null;
  /** Whether getting into `car` would possess it (a car in the awake deck that Cody can possess). */
  possessable(car: Vehicle): boolean;
  enter(car: Vehicle): void;
  exit(): void;
  /** Whether an escaped truck is still rolling on its own. */
  escaping(): boolean;
  /** Whether Cody's car stands in a free deck spot, where getting out parks it. */
  inFreeSpot(car: Vehicle): boolean;
  talkToValet(valet: Valet): void;
  summon(): number;
  canEat(): boolean;
  eat(): boolean;
  /** Who would take Cody's tires right now, or null. */
  tireTaker(): Npc | null;
  giveTires(to: Npc): boolean;
}

export type CodyAction = Action<Play, Play>;

export type CodyCandidate = Candidate<Control, Play, Play>;

/** How strongly an offer claims its key when several are possible. Higher wins. */
export const RANK = { script: 40, valet: 30, elevator: 20, vehicle: 10, getOut: 10 } as const;

/** Getting into a vehicle: possessing it, stealing it, or simply getting in. */
abstract class Board extends Action<Play, Play> {
  constructor(readonly p: { car: Vehicle }) {
    super();
  }
  perform(w: Play): Result<CodyAction> {
    w.enter(this.p.car);
    return done;
  }
}

/** Possess a car in the awake deck. In the tutorial, the deck does it while Cody is still in his daytime form. */
export class Possess extends Board {
  label({ cody }: Play): string {
    return `${cody.phantom ? 'POSSESS' : 'GET IN'} &nbsp;☾`;
  }
}

export class Steal extends Board {
  label(): string {
    return 'STEAL';
  }
}

export class GetIn extends Board {
  label(): string {
    return 'GET IN';
  }
}

/** Interact with a vehicle: it becomes possessing, stealing or getting in, depending on the car and on Cody. */
export class InteractWithVehicle extends Action<Play, Play> {
  constructor(readonly p: { car: Vehicle }) {
    super();
  }
  resolve(w: Play): CodyAction | Fail {
    const { car } = this.p;
    const { cody } = w;
    if (w.possessable(car)) return new Possess({ car });
    if (car.form === 'truck') return cody.can('truck') ? new GetIn({ car }) : fail('');
    if (!cody.can('steal')) return fail('');
    return car.role === 'traffic' || !car.insideDeck ? new Steal({ car }) : new GetIn({ car });
  }
  perform(): Result<CodyAction> {
    return fail('');
  }
}

export class TalkToValet extends Action<Play, Play> {
  constructor(readonly p: { valet: Valet }) {
    super();
  }
  label(): string {
    return 'TALK TO VALET';
  }
  perform(w: Play): Result<CodyAction> {
    w.talkToValet(this.p.valet);
    return done;
  }
}

export class CallElevator extends Action<Play, Play> {
  constructor(readonly p: { elevator: Elevator; stop: number }) {
    super();
  }
  label(): string {
    const { elevator, stop } = this.p;
    return elevator.requests.has(stop) ? 'ELEVATOR CALLED' : 'CALL ELEVATOR';
  }
  perform(): Result<CodyAction> {
    const { elevator, stop } = this.p;
    elevator.call(stop);
    return done;
  }
}

/** In a cab: pick the next floor up (dir 1) or down (dir -1). The down label also says where the cab is heading. */
export class PickFloor extends Action<Play, Play> {
  constructor(readonly p: { cab: Elevator; dir: 1 | -1 }) {
    super();
  }
  label(): string {
    const { cab, dir } = this.p;
    return dir === 1 ? 'UP' : `DOWN${heading(cab)}`;
  }
  perform(): Result<CodyAction> {
    const { cab, dir } = this.p;
    cab.pick(dir);
    return done;
  }
}

/** Get out of the vehicle. In a free deck spot by day, getting out parks the car, and the prompt says so. */
export class GetOut extends Action<Play, Play> {
  constructor(readonly p: { car: Vehicle }) {
    super();
  }
  label(w: Play): string {
    const { car } = this.p;
    return w.conditions.parking() && car.insideDeck && car.form === 'car' && w.inFreeSpot(car) ? 'PARK HERE' : '';
  }
  resolve(w: Play): CodyAction | Fail {
    const { car } = this.p;
    // An escaped truck rolls on by itself, and nobody gets out of a car in the air.
    if (w.escaping() || !(car.grounded || (car.crashing && car.resting))) return fail('');
    return this;
  }
  perform(w: Play): Result<CodyAction> {
    w.exit();
    return done;
  }
}

/** A car on its side or roof, gone still: the hop key rocks it back over. The hop itself is a driving input; this offer names it. */
export class RockOver extends Action<Play, Play> {
  label(): string {
    return 'ROCK IT OVER';
  }
  perform(): Result<CodyAction> {
    return done;
  }
}

export class Summon extends Action<Play, Play> {
  resolve({ cody }: Play): CodyAction | Fail {
    return cody.can('summon') ? this : fail('ONLY THE PHANTOM CAN RAISE THE DEAD');
  }
  perform(w: Play): Result<CodyAction> {
    return w.summon() > 0 ? done : fail('THE DEAD NEED A MOMENT');
  }
}

export class Eat extends Action<Play, Play> {
  label(): string {
    return 'EAT';
  }
  resolve(w: Play): CodyAction | Fail {
    return w.canEat() ? this : fail('');
  }
  perform(w: Play): Result<CodyAction> {
    return w.eat() ? done : fail('');
  }
}

export class GiveTires extends Action<Play, Play> {
  constructor(readonly p: { to: Npc; name: string }) {
    super();
  }
  label(): string {
    return `GIVE TO ${this.p.name}`;
  }
  perform(w: Play): Result<CodyAction> {
    return w.giveTires(this.p.to) ? done : fail('');
  }
}

/** An offer a script adds for a moment, such as the tutorial's talk with Randy in the basement. */
export class ScriptedOffer extends Action<Play, Play> {
  constructor(readonly p: { label: string; start: () => void }) {
    super();
  }
  label(): string {
    return this.p.label;
  }
  perform(): Result<CodyAction> {
    this.p.start();
    return done;
  }
}

function heading(e: Elevator): string {
  const to = e.picked ?? (e.at === null ? e.target : null);
  if (to !== null) {
    const arrow = e.stopY(to) > e.y ? '&#9650;' : '&#9660;';
    return ` &nbsp;&middot;&nbsp; ${arrow} ${e.label(to)}`;
  }
  return e.at !== null ? ` &nbsp;&middot;&nbsp; ${e.label(e.at)}` : '';
}
