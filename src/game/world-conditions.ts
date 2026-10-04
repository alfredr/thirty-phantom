import type { GameClock } from './game-clock';

export type WorldConditionName = 'deckAwake' | 'valetsOnShift' | 'parking' | 'daylight';

/**
 * What the time of day means, by name. The clock is the only source of time; these readers say
 * what it implies for each rule, so rules ask a question ("is the deck awake?") instead of reading
 * the clock. A script can pin a condition to a value without stopping the clock.
 */
export class WorldConditions {
  private readonly pins = new Map<WorldConditionName, boolean>();

  constructor(private readonly clock: GameClock) {}

  /** The haunted deck is awake at night: cars parked in it can be possessed. */
  readonly deckAwake = (): boolean => this.read('deckAwake', !this.clock.isDay);

  /** The Foxy's valets work by day and go home at night. */
  readonly valetsOnShift = (): boolean => this.read('valetsOnShift', this.clock.isDay);

  /** Cody parks cars by day: free spots light up, PARK HERE shows, and the arrow points to a free spot. */
  readonly parking = (): boolean => this.read('parking', this.clock.isDay);

  /** It's daytime: busier streets, and no skeletons. */
  readonly daylight = (): boolean => this.read('daylight', this.clock.isDay);

  /** Holds a condition at `value` until unpin(), whatever the time. */
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
