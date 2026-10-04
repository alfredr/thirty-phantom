import type { Vector3 } from 'three';
import type { Focus } from '@/engine/input/input';
import type { Control } from '@/game/controls';
import { type Choice, Conversation } from '@/game/story/conversation';
import { NPC_NAMES, type Npc, type Npcs } from './npcs';

/** Cody on foot this close to Randy (m, on his level) can talk to him. */
const TALK_REACH = 3;
/** The talk ends with Cody this far off (m), after this long (s), or this long after Randy's last line (s). */
const PACING = { breakAt: 4.5, timeout: 12, lineTime: 2.4 };

/** What a talk with Randy needs from the game. */
export interface RandyTalkHooks {
  /** How many tires Cody's carrying. */
  tires(): number;
  /** Cody gives Randy his tires (the same GIVE action as the item menu's). False if he couldn't. */
  give(to: Npc): boolean;
}

/**
 * Talking to Randy at his fire. He turns to Cody, roasting on, and if Cody's
 * carrying tires, Cody can give them to him there and then (he pays a brisket
 * a tire, as ever). With none, he says his piece and that's that. Off while
 * the tutorial runs, which has its own scenes with him.
 */
export class RandyTalk extends Conversation<Npc, 'give'> {
  /** Set false while the tutorial runs. */
  enabled = true;

  constructor(
    focus: Focus<Control>,
    private readonly npcs: Npcs,
    private readonly hooks: RandyTalkHooks,
  ) {
    super(focus, PACING);
  }

  /** Who Cody (on foot at `cody`) could talk to now: Randy at his fire, close by, free (no scene has him, and he's not busy feeding it). */
  talkable(cody: Vector3): Npc | null {
    if (!this.enabled || this.active) return null;
    const n = this.npcs.talkable(cody, TALK_REACH);
    return n?.fire && !n.held && n.work.in('roasting') ? n : null;
  }

  /** Cody talks to him: he turns to Cody, and offers to take the tires if Cody has any. */
  start(n: Npc): void {
    n.send({ type: 'held', face: null });
    if (this.hooks.tires() > 0) {
      this.open(n, "THOSE WHEELS, KID? FIRE COULD USE 'EM.");
      return;
    }
    // nothing to trade: he says his piece and that's that
    this.open(n, '');
    this.lastLine('WARM YOURSELF, KID. BRING ME WHEELS SOMETIME.');
  }

  protected where(n: Npc): Vector3 {
    return n.pos;
  }

  protected name(n: Npc): string {
    return NPC_NAMES[n.def.id];
  }

  protected choices(): Choice<'give'>[] {
    const k = this.hooks.tires();
    return k > 0 ? [{ action: 'interact', label: `GIVE ${k} TIRE${k > 1 ? 'S' : ''}`, off: false, does: 'give' }] : [];
  }

  protected chose(n: Npc): void {
    this.lastLine(this.hooks.give(n) ? 'OHHH. NICE WHEELS.' : "HOLD ON, FIRE'S BUSY.");
  }

  /** Done talking: back to his fire and his pitch. */
  protected ended(n: Npc): void {
    n.send({ type: 'released' });
  }
}
