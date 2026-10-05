import type { Vehicle } from './vehicle';

/** Keys carried by one person. Each entry belongs to one vehicle. */
export class Keyring {
  readonly held = new Set<Ignition>();
}

/** Away means the owner is outside the simulated crowd. Destroyed keys cannot return. */
type KeyOwner = Keyring | 'ignition' | 'away' | 'ground' | 'destroyed';

export type KeyHeat = 'cool' | 'molten' | 'melted';

/** One physical set of keys and an independent hotwire bypass for a vehicle. */
export class Ignition {
  hotwired = false;
  stalled = false;
  heat: KeyHeat = 'cool';

  constructor(
    readonly car: Vehicle,
    private owner: KeyOwner,
  ) {}

  get ready(): boolean {
    return this.hotwired || this.owner === 'ignition';
  }

  heldBy(owner: KeyOwner): boolean {
    return this.owner === owner;
  }

  /** Move the existing keys only if the expected owner still has them. */
  transfer(from: KeyOwner, to: KeyOwner): boolean {
    if (this.owner !== from || from === 'destroyed') {
      return false;
    }

    if (typeof from !== 'string') {
      from.held.delete(this);
    }

    this.owner = to;

    if (typeof to !== 'string') {
      to.held.add(this);
    }

    return true;
  }

  /** Insert matching keys unless heat has ruined them. A hotwire bypass does not count as having the keys. */
  insert(keys: Keyring): boolean {
    return this.heat === 'cool' && this.transfer(keys, 'ignition');
  }

  take(keys: Keyring): void {
    this.transfer('ignition', keys);
  }

  /** Remove keys from their holder when the vehicle leaves the simulation. */
  dispose(): void {
    this.transfer(this.owner, 'destroyed');
  }
}
