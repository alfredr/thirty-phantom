import type { GameClock } from '@/game/game-clock';

export type WorldConditionName = 'deckAwake' | 'valetsOnShift' | 'parking' | 'daylight';

/**
 * Expose day/night rules with optional script overrides. Pinning a condition changes that rule without changing the
 * clock.
 */
export class WorldConditions {
  private readonly pins = new Map<WorldConditionName, boolean>();

  constructor(private readonly clock: GameClock) {}

  /** Enable deck possession, normally at night. */
  readonly deckAwake = (): boolean => this.read('deckAwake', !this.clock.isDay);

  /** Enable valet shifts, normally by day. */
  readonly valetsOnShift = (): boolean => this.read('valetsOnShift', this.clock.isDay);

  /** Enable parking prompts and guidance, normally by day. */
  readonly parking = (): boolean => this.read('parking', this.clock.isDay);

  /** Enable daytime world behavior unless overridden. */
  readonly daylight = (): boolean => this.read('daylight', this.clock.isDay);

  /** Override a condition until unpin() removes the override. */
  pin(name: WorldConditionName, value: boolean): void {
    this.pins.set(name, value);
  }

  unpin(name: WorldConditionName): void {
    this.pins.delete(name);
  }

  private read(name: WorldConditionName, natural: boolean): boolean {
    return this.pins.get(name) ?? natural;
  }
}
