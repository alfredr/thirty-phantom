import type { Vector3 } from 'three';

import type { Vehicle } from '@/actors/vehicle';
import { TUNING } from '@/config';
import type { Rng } from '@/engine/core/rng';
import type { Focus } from '@/engine/input/input';
import type { Control } from '@/game/controls';
import { type Garage, spotLabel, type SpotRuntime } from '@/game/deck/garage';
import { type Choice, Conversation } from '@/game/story/conversation';
import type { Hud } from '@/ui/hud';

import type { Valet, ValetService } from './valet';

const DECK_FULL = "SORRY. THE DECK'S FULL.";

/** Game operations available to valet conversations. */
export interface TalkHooks {
  /** Return Cody’s position on foot or in a vehicle. */
  me(): Vector3;
  /** Return whether valet service is open. */
  onShift(): boolean;
  /** Return the vehicle eligible for handover, or null. */
  carToTake(): Vehicle | null;
  /** Release Cody’s vehicle before handing it to the valet. */
  handOff(car: Vehicle): void;
  /** Read and spend Cody’s balance in dollars. */
  cash(): number;
  pay(amount: number): boolean;
}

/**
 * Handover terms: highest available floor for free, a tip, or a bribe; any available spot if a requested tip is
 * declined.
 */
type Deal = 'top' | 'tipped' | 'bribed' | 'anywhere';

/**
 * Negotiate a parking handover while the valet faces Cody. The first car receives top-floor service free; later
 * requests may require an increasing tip. Preserve the quoted tip until a non-bribed handover. Returning valets instead
 * require the configured bribe.
 */
export class ValetTalk extends Conversation<Valet, Deal> {
  /** Completed handover count and number of tip requests. */
  private handed = 0;
  private asked = 0;
  /** Pending tip quote; null means unquoted and zero means no tip required. */
  private tip: number | null = null;
  /** Whether the selected valet requires a bribe to interrupt a return trip. */
  private bribe = false;

  constructor(
    private readonly hud: Hud,
    private readonly garage: Garage,
    private readonly valets: ValetService,
    private readonly rng: Rng,
    focus: Focus<Control>,
    private readonly hooks: TalkHooks,
  ) {
    super(focus, {
      breakAt: TUNING.valet.talkBreak,
      timeout: TUNING.valet.talkTimeout,
      lineTime: TUNING.valet.lineTime,
    });
  }

  /** Start a conversation and choose or reuse the handover terms. */
  start(valet: Valet): void {
    const V = TUNING.valet;
    valet.send({ type: 'talk', who: () => this.hooks.me() });
    this.bribe = valet.state === 'returning';

    if (!this.bribe && this.tip === null) {
      this.tip = this.handed > 0 && this.rng.chance(V.tipChance) ? V.tipBase * V.tipGrowth ** this.asked++ : 0;
    }

    const line = this.bribe
      ? `I'M ON A BREAK. $${V.bribe} SAYS I'M NOT.`
      : this.handed === 0
        ? 'WELCOME TO THE FOXY.'
        : (this.tip ?? 0) > 0
          ? `TOP FLOOR? THAT'LL BE $${this.tip}.`
          : 'WELCOME BACK.';
    this.open(valet, line);
    this.hud.setPrompt(null);
  }

  /** Record an entry if the valet did not cross the gate and announce the parked spot. */
  parked(spot: SpotRuntime, valet: Valet): void {
    if (!valet.badged) {
      this.garage.logged++;
    }

    this.hud.toast('VALET PARKED IT', `${spotLabel(spot)}. ENTRY LOGGED.`, 'purple', 2.4);
  }

  protected where(valet: Valet): Vector3 {
    return valet.walker.pos;
  }

  protected name(): string {
    return 'FOXY VALET';
  }

  protected goingOn(): boolean {
    return this.hooks.onShift();
  }

  protected choices(): Choice<Deal>[] {
    const V = TUNING.valet;
    const tip = this.tip ?? 0;
    if (this.bribe) {
      return [{ action: 'pay', label: `PAY $${V.bribe}: TOP FLOOR`, off: this.hooks.cash() < V.bribe, does: 'bribed' }];
    }

    if (tip > 0) {
      return [
        { action: 'pay', label: `PAY $${tip}: TOP FLOOR`, off: this.hooks.cash() < tip, does: 'tipped' },
        { action: 'interact', label: 'JUST PARK IT', off: false, does: 'anywhere' },
      ];
    }

    return [{ action: 'interact', label: 'PARK IT', off: false, does: 'top' }];
  }

  /** Release the valet’s conversation attention. */
  protected ended(valet: Valet): void {
    valet.send({ type: 'talkEnded' });
  }

  protected chose(valet: Valet, deal: Deal): void {
    const car = this.hooks.carToTake();
    const free = this.garage.freeSpots();
    const spot = deal === 'anywhere' ? (free.length ? this.rng.pick(free) : null) : this.garage.topFree();
    if (!car) {
      this.lastLine('NO CAR, NO SERVICE.');
    } else if (!spot) {
      this.lastLine(DECK_FULL);
    } else if (
      deal === 'bribed' ? this.hooks.pay(TUNING.valet.bribe) : deal !== 'tipped' || this.hooks.pay(this.tip ?? 0)
    ) {
      this.hooks.handOff(car);
      this.valets.take(valet, car, spot);
      this.handed++;

      // A bribe leaves the pending stand tip unchanged.
      if (deal !== 'bribed') {
        this.tip = null;
      }

      this.lastLine(
        deal === 'anywhere'
          ? "SURE. I'LL FIND IT A SPOT."
          : `RIGHT AWAY. LEVEL ${spot.def.level + 1}, TOP OF THE DECK.`,
      );
    }
  }
}
