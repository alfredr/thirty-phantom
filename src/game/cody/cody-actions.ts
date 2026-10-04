import type { Vehicle } from '@/actors/vehicle';
import { Action, done, fail, type Fail, type Result } from '@/engine/sim/action';
import type { Candidate } from '@/engine/sim/offers';
import type { Control } from '@/game/controls';
import type { Npc } from '@/game/randy/npcs';
import type { WorldConditions } from '@/game/rules/world-conditions';
import type { Valet } from '@/game/valets/valet';
import type { Elevator } from '@/world/elevators';

import type { CodyState } from './cody-state';

/** Game state and operations available to Cody’s actions. */
export interface Play {
  readonly cody: CodyState;
  readonly conditions: WorldConditions;
  /** The vehicle Cody is driving, or null. */
  ride(): Vehicle | null;
  /** Test whether entering this car would trigger possession. */
  possessable(car: Vehicle): boolean;
  enter(car: Vehicle): void;
  exit(): void;
  /** Whether the escape sequence currently prevents leaving the truck. */
  escaping(): boolean;
  /** Test whether exiting would park the car in an available deck spot. */
  inFreeSpot(car: Vehicle): boolean;
  talkToValet(valet: Valet): void;
  talkToRandy(randy: Npc): void;
  summon(): number;
  canEat(): boolean;
  eat(): boolean;
  /** Return an available tire recipient, or null. */
  tireTaker(): Npc | null;
  giveTires(to: Npc): boolean;
}

export type CodyAction = Action<Play, Play>;

export type CodyCandidate = Candidate<Control, Play, Play>;

/** Priority among offers sharing a control; higher values win. */
export const RANK = { script: 40, valet: 30, randy: 30, elevator: 20, vehicle: 10, getOut: 10 } as const;

/** Shared boarding behavior for possession, theft, and ordinary entry. */
abstract class Board extends Action<Play, Play> {
  constructor(readonly p: { car: Vehicle }) {
    super();
  }
  perform(w: Play): Result<CodyAction> {
    w.enter(this.p.car);
    return done;
  }
}

/** Label possession as ordinary entry while the tutorial keeps Cody in daytime form. */
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

/** Resolve vehicle interaction according to possession eligibility, vehicle form, and Cody’s abilities. */
export class InteractWithVehicle extends Action<Play, Play> {
  constructor(readonly p: { car: Vehicle }) {
    super();
  }
  resolve(w: Play): CodyAction | Fail {
    const { car } = this.p;
    const { cody } = w;
    if (w.possessable(car)) {
      return new Possess({ car });
    }

    if (car.form === 'truck') {
      return cody.can('truck') ? new GetIn({ car }) : fail('');
    }

    if (!cody.can('steal')) {
      return fail('');
    }

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

export class TalkToRandy extends Action<Play, Play> {
  constructor(readonly p: { randy: Npc }) {
    super();
  }
  label(): string {
    return 'TALK TO RANDY';
  }
  perform(w: Play): Result<CodyAction> {
    w.talkToRandy(this.p.randy);
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

/** Select the next elevator stop in the requested direction. The down label also displays destination information. */
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

/** Exit the vehicle, showing PARK HERE when the current parking conditions allow it. */
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
    // Prevent exit during an escape or while the vehicle is airborne and unsettled.
    if (w.escaping() || !(car.grounded || (car.crashing && car.resting))) {
      return fail('');
    }

    return this;
  }
  perform(w: Play): Result<CodyAction> {
    w.exit();
    return done;
  }
}

/**
 * Label the hop control for a resting overturned vehicle. Driving input performs the recovery; this action only
 * supplies the prompt.
 */
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

/** Expose a script callback as a labeled interaction. */
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
