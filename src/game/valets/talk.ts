import type { Vector3 } from 'three';
import type { Vehicle } from '../../actors/vehicle';
import { TUNING } from '../../config';
import type { Focus } from '../../core/input';
import type { Rng } from '../../core/rng';
import type { Hud } from '../../ui/hud';
import { type Garage, spotLabel, type SpotRuntime } from '../deck/garage';
import { type Choice, Conversation } from '../story/conversation';
import type { Valet, ValetService } from './valet';

const DECK_FULL = "SORRY. THE DECK'S FULL.";

/** What a conversation with a valet needs from the game. */
export interface TalkHooks {
  /** Where Cody is: on foot or in his car. */
  me(): Vector3;
  /** Whether the stand's open. */
  onShift(): boolean;
  /** The car a valet would take, if there is one. */
  carToTake(): Vehicle | null;
  /** Cody hands `car` over, getting out first if he's in it. */
  handOff(car: Vehicle): void;
  /** Cody's cash, and paying out of it. */
  cash(): number;
  pay(amount: number): boolean;
}

/** How a car gets handed over: free to the top floor, tipped or bribed to the top floor, or untipped (wherever there's room). */
type Deal = 'top' | 'tipped' | 'bribed' | 'anywhere';

/**
 * Talking to a valet. While it's open he faces Cody (his attention mind)
 * without dropping what he was doing. The first car goes to the top floor
 * free. After that he may name a tip (TUNING.valet.tipChance), bigger each
 * time he asks; paid, the car goes to the top floor, otherwise wherever
 * there's room. A tip he's named stands until a car is handed over, so walking
 * off doesn't make it go away. One caught walking back to the stand takes a car
 * only for a bribe (TUNING.valet.bribe), and then it goes to the top floor.
 */
export class ValetTalk extends Conversation<Valet, Deal> {
  /** Cars handed over so far, and tips asked for. */
  private handed = 0;
  private asked = 0;
  /** This visit's tip: unknown until he's asked (null), then 0 for none. */
  private tip: number | null = null;
  /** The valet this talk's with was on his way back to the stand: only money turns him round. */
  private bribe = false;

  constructor(
    private readonly hud: Hud,
    private readonly garage: Garage,
    private readonly valets: ValetService,
    private readonly rng: Rng,
    focus: Focus,
    private readonly hooks: TalkHooks,
  ) {
    super(focus, { breakAt: TUNING.valet.talkBreak, timeout: TUNING.valet.talkTimeout, lineTime: TUNING.valet.lineTime });
  }

  /** Interact next to a valet: he stops, turns to Cody and asks what he can do. */
  start(valet: Valet): void {
    const V = TUNING.valet;
    valet.send({ type: 'talk', who: () => this.hooks.me() });
    this.bribe = valet.state === 'returning';
    if (!this.bribe && this.tip === null) this.tip = this.handed > 0 && this.rng.chance(V.tipChance) ? V.tipBase * V.tipGrowth ** this.asked++ : 0;
    const line = this.bribe ? `I'M ON A BREAK. $${V.bribe} SAYS I'M NOT.` : this.handed === 0 ? 'WELCOME TO THE FOXY.' : (this.tip ?? 0) > 0 ? `TOP FLOOR? THAT'LL BE $${this.tip}.` : 'WELCOME BACK.';
    this.open(valet, line);
    this.hud.setPrompt(null);
  }

  /** The valet drove it in and parked it: same as parking it yourself. */
  parked(spot: SpotRuntime, valet: Valet): void {
    if (!valet.badged) this.garage.logged++;
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
    if (this.bribe) return [{ action: 'pay', label: `PAY $${V.bribe}: TOP FLOOR`, off: this.hooks.cash() < V.bribe, does: 'bribed' }];
    if (tip > 0) {
      return [
        { action: 'pay', label: `PAY $${tip}: TOP FLOOR`, off: this.hooks.cash() < tip, does: 'tipped' },
        { action: 'interact', label: 'JUST PARK IT', off: false, does: 'anywhere' },
      ];
    }
    return [{ action: 'interact', label: 'PARK IT', off: false, does: 'top' }];
  }

  /** The conversation's over: he stops facing Cody. */
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
    } else if (deal === 'bribed' ? this.hooks.pay(TUNING.valet.bribe) : deal !== 'tipped' || this.hooks.pay(this.tip ?? 0)) {
      this.hooks.handOff(car);
      this.valets.take(valet, car, spot);
      this.handed++;
      // a bribe is between him and Cody: the stand's tip still stands
      if (deal !== 'bribed') this.tip = null;
      this.lastLine(deal === 'anywhere' ? "SURE. I'LL FIND IT A SPOT." : `RIGHT AWAY. LEVEL ${spot.def.level + 1}, TOP OF THE DECK.`);
    }
  }
}
