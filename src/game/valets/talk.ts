import { Vector3 } from 'three';
import type { Vehicle } from '../../actors/vehicle';
import { TUNING } from '../../config';
import type { Action, Focus } from '../../core/input';
import type { Rng } from '../../core/rng';
import type { Bubble, Hud } from '../../ui/hud';
import { type Garage, spotLabel, type SpotRuntime } from '../deck/garage';
import type { Valet, ValetService } from './valet';

/** Speech bubbles hang from this high above a speaker's feet. */
const SPEAKER_HEAD = 2.5;
const _head = new Vector3();
const DECK_FULL = "SORRY. THE DECK'S FULL.";

interface Conversation {
  valet: Valet;
  /** He was on his way back to the stand: only money turns him round. */
  bribe: boolean;
  t: number;
  line: string;
  /** Seconds left on his last line, or -1 while he's still asking. */
  closing: number;
}

/** What a conversation needs from the game. */
export interface TalkHooks {
  /** Where Cody is: on foot or in his car. */
  me(): Vector3;
  /** The car a valet would take, if there is one. */
  carToTake(): Vehicle | null;
  /** Cody hands `car` over, getting out first if he's in it. */
  handOff(car: Vehicle): void;
  /** CSS-pixel screen position of a world point, or null when it's behind the camera. */
  toScreen(p: Vector3): { x: number; y: number } | null;
  /** Cody's cash, and paying out of it. */
  cash(): number;
  pay(amount: number): boolean;
}

/** How a car gets handed over: free to the top floor, tipped or bribed to the top floor, or untipped (wherever there's room). */
type Deal = 'top' | 'tipped' | 'bribed' | 'anywhere';

/** Something Cody can say: its key, its label, whether he can't (can't pay), and the deal it strikes. */
interface Choice {
  action: Action;
  label: string;
  off: boolean;
  deal: Deal;
}

/**
 * Talking to a valet: an encounter between Cody and him, open from when Cody
 * talks to him until one of them walks off, it times out, or he's said his
 * last line. While it's open he faces Cody (his attention mind) without
 * dropping what he was doing, and its choices are a focus layer: their keys
 * go to the talk, not the world. The first car goes to the top floor free.
 * After that he may name a tip (TUNING.valet.tipChance), bigger each time he
 * asks; paid, the car goes to the top floor, otherwise wherever there's room.
 * A tip he's named stands until a car is handed over, so walking off doesn't
 * make it go away. One caught walking back to the stand takes a car only for
 * a bribe (TUNING.valet.bribe), and then it goes to the top floor.
 */
export class ValetTalk {
  private talk: Conversation | null = null;
  /** Takes the choices' layer away again. */
  private unfocus: (() => void) | null = null;
  /** Cars handed over so far, and tips asked for. */
  private handed = 0;
  private asked = 0;
  /** This visit's tip: unknown until he's asked (null), then 0 for none. */
  private tip: number | null = null;

  constructor(
    private readonly hud: Hud,
    private readonly garage: Garage,
    private readonly valets: ValetService,
    private readonly rng: Rng,
    private readonly focus: Focus,
    private readonly hooks: TalkHooks,
  ) {}

  get active(): boolean {
    return this.talk !== null;
  }

  /** Interact next to a valet: he stops, turns to Cody and asks what he can do. */
  start(valet: Valet): void {
    const V = TUNING.valet;
    valet.send({ type: 'talk', who: () => this.hooks.me() });
    const bribe = valet.state === 'returning';
    if (!bribe && this.tip === null) this.tip = this.handed > 0 && this.rng.chance(V.tipChance) ? V.tipBase * V.tipGrowth ** this.asked++ : 0;
    const line = bribe ? `I'M ON A BREAK. $${V.bribe} SAYS I'M NOT.` : this.handed === 0 ? 'WELCOME TO THE FOXY.' : (this.tip ?? 0) > 0 ? `TOP FLOOR? THAT'LL BE $${this.tip}.` : 'WELCOME BACK.';
    this.talk = { valet, bribe, t: 0, line, closing: -1 };
    this.unfocus?.();
    this.unfocus = this.focus.add({
      controls: () => this.choices().filter((c) => !c.off).map((c) => c.action),
      press: (control) => this.choose(control),
    });
    this.hud.setPrompt(null);
  }

  update(dt: number, day: boolean): void {
    const talk = this.talk;
    if (!talk) {
      this.hud.setBubble(null);
      return;
    }
    const w = talk.valet.walker;
    talk.t += dt;
    // walk or drive off, wait too long, or let him finish his line: the conversation ends
    const V = TUNING.valet;
    const gone = w.pos.distanceTo(this.hooks.me()) > V.talkBreak || talk.t > V.talkTimeout || (talk.closing >= 0 && (talk.closing -= dt) < 0) || !day;
    if (gone) {
      this.end(talk);
      return;
    }
    const choices: Bubble['choices'] = this.choices().map(({ action, label, off }) => ({ action, label, off }));
    const at = this.hooks.toScreen(_head.copy(w.pos).setY(w.pos.y + SPEAKER_HEAD));
    this.hud.setBubble(at && { ...at, who: 'FOXY VALET', line: talk.line, choices });
  }

  /** What Cody can say now: nothing once the valet's saying his last line. */
  private choices(): Choice[] {
    const talk = this.talk;
    if (!talk || talk.closing >= 0) return [];
    const V = TUNING.valet;
    const tip = this.tip ?? 0;
    if (talk.bribe) return [{ action: 'pay', label: `PAY $${V.bribe}: TOP FLOOR`, off: this.hooks.cash() < V.bribe, deal: 'bribed' }];
    if (tip > 0) {
      return [
        { action: 'pay', label: `PAY $${tip}: TOP FLOOR`, off: this.hooks.cash() < tip, deal: 'tipped' },
        { action: 'interact', label: 'JUST PARK IT', off: false, deal: 'anywhere' },
      ];
    }
    return [{ action: 'interact', label: 'PARK IT', off: false, deal: 'top' }];
  }

  /** Cody picked the choice on `control`. */
  private choose(control: Action): void {
    const talk = this.talk;
    const choice = this.choices().find((c) => c.action === control && !c.off);
    if (talk && choice) this.handOver(talk, choice.deal);
  }

  /** The conversation's over: he stops facing Cody, and the choices' keys go back to the world. */
  private end(talk: Conversation): void {
    talk.valet.send({ type: 'talkEnded' });
    this.talk = null;
    this.unfocus?.();
    this.unfocus = null;
    this.hud.setBubble(null);
  }

  /** The valet drove it in and parked it: same as parking it yourself. */
  parked(spot: SpotRuntime, valet: Valet): void {
    if (!valet.badged) this.garage.logged++;
    this.hud.toast('VALET PARKED IT', `${spotLabel(spot)} • ENTRY LOGGED`, 'purple', 2.4);
  }

  private handOver(talk: Conversation, deal: Deal): void {
    const car = this.hooks.carToTake();
    const free = this.garage.freeSpots();
    const spot = deal === 'anywhere' ? (free.length ? this.rng.pick(free) : null) : this.garage.topFree();
    if (!car) {
      this.lastLine(talk, 'NO CAR, NO SERVICE.');
    } else if (!spot) {
      this.lastLine(talk, DECK_FULL);
    } else if (deal === 'bribed' ? this.hooks.pay(TUNING.valet.bribe) : deal !== 'tipped' || this.hooks.pay(this.tip ?? 0)) {
      this.hooks.handOff(car);
      this.valets.take(talk.valet, car, spot);
      this.handed++;
      // a bribe is between him and Cody: the stand's tip still stands
      if (deal !== 'bribed') this.tip = null;
      this.lastLine(talk, deal === 'anywhere' ? "SURE. I'LL FIND IT A SPOT." : `RIGHT AWAY. LEVEL ${spot.def.level + 1}, TOP OF THE DECK.`);
    }
  }

  /** He says `line`, then the conversation ends. */
  private lastLine(talk: Conversation, line: string): void {
    talk.line = line;
    talk.closing = TUNING.valet.lineTime;
  }
}
