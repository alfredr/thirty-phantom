import type { Vector3 } from 'three';
import type { CodyForm } from '../actors/models/character';
import type { Player } from '../actors/player';
import type { Vehicle } from '../actors/vehicle';

/** Abilities available to Cody based on his current form. */
export type CodyAbility = 'steal' | 'possess' | 'truck' | 'summon';

/**
 * Daytime Cody can steal cars. Phantom Cody can possess cars, drive the monster truck,
 * and summon skeletons. Game.possessable restricts possession to cars inside the deck at night.
 */
const ABILITIES: Readonly<Record<CodyForm, readonly CodyAbility[]>> = {
  day: ['steal'],
  night: ['possess', 'truck', 'summon'],
};

/** How NPCs perceive Cody: his form on foot, or the phantom truck while he drives it. */
export type Presence = 'cody' | 'phantom' | 'phantomTruck';

/** Forms of presence that frighten pedestrians and drivers. */
export const FRIGHTENING: ReadonlySet<Presence> = new Set(['phantom', 'phantomTruck']);

/**
 * Determines Cody's abilities and how NPCs perceive him from his current form.
 * The day/night cycle changes his form at moonrise and sunrise. Scripts can hold his form
 * and grant extra abilities. For example, the tutorial keeps him in his daytime form
 * while allowing him to possess cars and drive the monster truck.
 */
export class CodyState {
  /** Whether a script controls Cody's form instead of the normal day/night cycle. */
  holdForm = false;
  private readonly granted = new Set<CodyAbility>();

  constructor(private readonly player: Player) {}

  get form(): CodyForm {
    return this.player.form;
  }

  get phantom(): boolean {
    return this.player.form === 'night';
  }

  can(a: CodyAbility): boolean {
    return this.granted.has(a) || ABILITIES[this.player.form].includes(a);
  }

  /** Hold Cody's current form and grant extra abilities until release() is called. */
  hold(...abilities: CodyAbility[]): void {
    this.holdForm = true;
    for (const a of abilities) this.granted.add(a);
  }

  /** Remove granted abilities and resume normal form changes at moonrise and sunrise. */
  release(): void {
    this.holdForm = false;
    this.granted.clear();
  }

  /**
   * Return Cody's visible presence and position: his current form on foot, or the phantom
   * truck while driving. Return null inside an ordinary car or during a vehicle transformation.
   */
  presence(driving: Vehicle | null, transforming: boolean): { kind: Presence; at: Vector3 } | null {
    if (transforming) return null;
    if (driving) return driving.form === 'truck' ? { kind: 'phantomTruck', at: driving.pos } : null;
    return { kind: this.phantom ? 'phantom' : 'cody', at: this.player.pos };
  }
}
