import type { Npc } from '@/actors/npcs/npcs';
import type { Vehicle } from '@/actors/vehicles/vehicle';
import {
  Action,
  done,
  fail,
  type Fail,
  type Result,
} from '@/engine/sim/action';
import type { Candidate } from '@/engine/sim/offers';
import type { Control } from '@/game/controls';
import type { ItemKind } from '@/game/items/item-breeds';
import type { ItemUse, ItemWorld } from '@/game/items/item-use';
import type { Trade } from '@/game/items/trades';
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
  canEnter(car: Vehicle): boolean;
  canHotwire(car: Vehicle): boolean;
  hotwire(car: Vehicle): boolean;
  enter(car: Vehicle): void;
  exit(): void;
  /** Whether the escape sequence currently prevents leaving the truck. */
  escaping(): boolean;
  locked(): string | null;
  /** Test whether exiting would park the car in an available deck spot. */
  inFreeSpot(car: Vehicle): boolean;
  talkToValet(valet: Valet): void;
  talkToRandy(randy: Npc): void;
  summon(): number;
  readonly items: ItemWorld;
  tradeFor(kind: ItemKind): Trade | null;
  give(to: Npc, kind: ItemKind): boolean;
}

export type CodyAction = Action<Play, Play>;

export type CodyCandidate = Candidate<Control, Play, Play>;

/** Priority among offers sharing a control; higher values win. */
export const RANK = {
  script: 40,
  valet: 30,
  randy: 30,
  elevator: 20,
  vehicle: 10,
  getOut: 10,
} as const;

/** Shared boarding behavior for possession, theft, and ordinary entry. */
abstract class Board extends Action<Play, Play> {
  constructor(readonly p: { car: Vehicle }) {
    super();
  }
  perform(w: Play): Result<CodyAction> {
    if (!w.canEnter(this.p.car)) {
      return fail('');
    }

    w.enter(this.p.car);
    return done;
  }
}

/**
 * Label possession as ordinary entry while the tutorial keeps Cody in daytime
 * form.
 */
class Possess extends Board {
  label({ cody }: Play): string {
    return `${cody.phantom ? 'POSSESS' : 'GET IN'} &nbsp;☾`;
  }
}

class Steal extends Board {
  label(): string {
    return `STEAL · ${this.p.car.plate}`;
  }
}

class GetIn extends Board {
  label(): string {
    return `GET IN · ${this.p.car.plate}`;
  }
}

export class Hotwire extends Action<Play, Play> {
  constructor(readonly p: { car: Vehicle }) {
    super();
  }
  label(): string {
    return 'HOTWIRE';
  }
  resolve(w: Play): CodyAction | Fail {
    return w.canHotwire(this.p.car) ? this : fail('');
  }
  perform(w: Play): Result<CodyAction> {
    return w.hotwire(this.p.car) ? done : fail('');
  }
}

/**
 * Resolve vehicle interaction according to possession eligibility, vehicle
 * form, and Cody’s abilities.
 */
export class InteractWithVehicle extends Action<Play, Play> {
  constructor(readonly p: { car: Vehicle }) {
    super();
  }
  resolve(w: Play): CodyAction | Fail {
    const { car } = this.p;
    const { cody } = w;
    if (!w.canEnter(car)) {
      return fail('');
    }

    if (w.possessable(car)) {
      return new Possess({ car });
    }

    if (car.form === 'truck') {
      return cody.can('truck') ? new GetIn({ car }) : fail('');
    }

    if (!cody.can('steal')) {
      return fail('');
    }

    return car.role === 'traffic' ||
      car.role === 'visitor' ||
      car.role === 'valet'
      ? new Steal({ car })
      : new GetIn({ car });
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

/**
 * Select the next elevator stop in the requested direction. The down label
 * also displays destination information.
 */
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

/**
 * Exit the vehicle, showing PARK HERE when the current parking conditions
 * allow it.
 */
export class GetOut extends Action<Play, Play> {
  constructor(readonly p: { car: Vehicle }) {
    super();
  }
  label(w: Play): string {
    const { car } = this.p;
    return w.conditions.parking() &&
      car.insideDeck &&
      car.form === 'car' &&
      w.inFreeSpot(car)
      ? 'PARK HERE'
      : '';
  }
  resolve(w: Play): CodyAction | Fail {
    const { car } = this.p;
    // Prevent exit during an escape or while the vehicle is airborne and unsettled.
    if (w.escaping() || !(car.grounded || (car.crashing && car.resting))) {
      return fail('');
    }

    const locked = w.locked();
    return locked ? fail(locked) : this;
  }
  perform(w: Play): Result<CodyAction> {
    w.exit();
    return done;
  }
}

/**
 * Label the hop control for a resting overturned vehicle. Driving input
 * performs the recovery; this action only supplies the prompt.
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
    return cody.can('summon')
      ? this
      : fail('ONLY THE PHANTOM CAN RAISE THE DEAD');
  }
  perform(w: Play): Result<CodyAction> {
    return w.summon() > 0 ? done : fail('THE DEAD NEED A MOMENT');
  }
}

/** Bind an item's shared use capability to one inventory selection. */
export class UseItem extends Action<Play, Play> {
  constructor(
    readonly kind: ItemKind,
    readonly use: ItemUse,
  ) {
    super();
  }
  label(): string {
    return this.use.label;
  }
  resolve(w: Play): CodyAction | Fail {
    return this.use.when(w.items) ? this : fail('');
  }
  perform(w: Play): Result<CodyAction> {
    return this.use.use(w.items, this.kind) ? done : fail('');
  }
}

export class GiveItem extends Action<Play, Play> {
  constructor(
    readonly to: Npc,
    readonly kind: ItemKind,
  ) {
    super();
  }
  label(): string {
    return `GIVE TO ${this.to.breed.name}`;
  }
  perform(w: Play): Result<CodyAction> {
    return w.give(this.to, this.kind) ? done : fail('');
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
