import type { Vector3 } from 'three';

import type { Npc, Npcs } from '@/actors/npcs/npcs';
import type { Release } from '@/engine/core/disposable';
import type { Focus } from '@/engine/input/input';
import type { Control } from '@/game/controls';
import { type Choice, Conversation } from '@/game/story/conversation';

/**
 * Horizontal conversation range in meters; NPC lookup also checks level
 * separation.
 */
const TALK_REACH = 3;
/**
 * Maximum separation in meters, conversation timeout in seconds, and
 * final-line duration in seconds.
 */
const PACING = { breakAt: 4.5, timeout: 12, lineTime: 2.4 };

/** Inventory and trade operations available to Randy’s conversation. */
export interface RandyTalkHooks {
  /** Return Cody’s tire count. */
  tires(): number;
  /** Perform the shared tire-giving action and report success. */
  give(to: Npc): boolean;
}

/**
 * Offer a tire trade while talking to Randy at his fire. Without tires,
 * display a closing line. The tutorial disables this conversation while using
 * its own scenes.
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

  /**
   * Return a nearby Randy who has a fire, is roasting, and is not controlled
   * by a scene.
   */
  talkable(cody: Vector3): Npc | null {
    if (!this.enabled || this.active) {
      return null;
    }

    const n = this.npcs.talkable(cody, TALK_REACH);
    return n?.fire && !n.held && n.work?.in('idle') ? n : null;
  }

  /** Hold Randy for the conversation and offer a trade when Cody has tires. */
  start(n: Npc): void {
    if (this.hooks.tires() > 0) {
      this.open(n, "THOSE WHEELS, KID? FIRE COULD USE 'EM.");
      return;
    }

    this.open(n, '');
    this.lastLine('WARM YOURSELF, KID. BRING ME WHEELS SOMETIME.');
  }

  protected where(n: Npc): Vector3 {
    return n.pos;
  }

  protected name(n: Npc): string {
    return n.breed.name;
  }

  protected choices(): Choice<'give'>[] {
    const k = this.hooks.tires();
    return k > 0
      ? [
          {
            action: 'interact',
            label: `GIVE ${k} TIRE${k > 1 ? 'S' : ''}`,
            off: false,
            does: 'give',
          },
        ]
      : [];
  }

  protected chose(n: Npc): void {
    this.lastLine(
      this.hooks.give(n) ? 'OHHH. NICE WHEELS.' : "HOLD ON, FIRE'S BUSY.",
    );
  }

  protected attend(n: Npc): Release {
    return n.attention.take({ face: null });
  }
}
