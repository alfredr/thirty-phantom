import { type Owner, Relation } from './relation';

/** How many holders one target may have for a kind of claim, and how many targets one holder may hold. */
export interface ClaimRule {
  readonly perTarget: number;
  readonly perHolder?: number;
}

export type ClaimTable<K extends string> = Readonly<Record<K, ClaimRule>>;

/** A stored claim: `holder` holds `target` for `kind`, in `slot`, for as long as `owner` lasts. */
export interface Claim<K extends string> {
  readonly kind: K;
  readonly holder: object;
  readonly target: object;
  readonly slot: number;
  readonly owner: Owner;
}

export interface TakeOptions {
  readonly owner: Owner;
  /** Takes the claim from its current holder when it's full. The holder's owner is told through lostBy() and `lost`. */
  readonly preempt?: boolean;
}

/**
 * Claims are a stored relation: `holds(holder, target, kind)`, keyed per kind by target (and by holder where the table
 * says so). Taking a full claim is refused, or evicts the current holder when the taker preempts. Claims end with their
 * owner.
 */
export class Claims<K extends string> {
  readonly rows: Relation<Claim<K>>;

  constructor(
    private readonly table: ClaimTable<K>,
    lost?: (claim: Claim<K>) => void,
  ) {
    this.rows = new Relation<Claim<K>>({
      keys: [
        { on: ['kind', 'target'], cap: ({ kind }) => table[kind].perTarget },
        { on: ['kind', 'holder'], cap: ({ kind }) => table[kind].perHolder ?? Infinity },
      ],
      evicted: lost,
    });
  }

  /** Takes a claim. Returns true if `holder` holds it afterwards, including when it already did. */
  take(kind: K, holder: object, target: object, { owner, preempt = false }: TakeOptions): boolean {
    if (this.rows.where({ kind, holder, target }).length) {
      return true;
    }

    const held = this.rows.where({ kind, target });
    const cap = this.table[kind].perTarget;
    const slot = held.length >= cap ? (held[0]?.slot ?? 0) : firstFreeSlot(held, cap);
    return this.rows.insert({ kind, holder, target, slot, owner }, preempt ? 'evict' : 'refuse') !== null;
  }

  /** The first holder of `target` for `kind`, or null. */
  holder(kind: K, target: object): object | null {
    return this.rows.where({ kind, target })[0]?.holder ?? null;
  }

  /** Every holder of `target` for `kind`. */
  holders(kind: K, target: object): object[] {
    return this.rows.where({ kind, target }).map(({ holder }) => holder);
  }

  /** Every target `holder` holds for `kind`. */
  heldBy(kind: K, holder: object): object[] {
    return this.rows.where({ kind, holder }).map(({ target }) => target);
  }

  /** The slot `holder` has on `target`, or null if it holds none. */
  slotOf(kind: K, holder: object, target: object): number | null {
    return this.rows.where({ kind, holder, target })[0]?.slot ?? null;
  }

  /** Whether another holder could take `target` for `kind` without preempting. */
  free(kind: K, target: object): boolean {
    return this.rows.where({ kind, target }).length < this.table[kind].perTarget;
  }

  /** Ends one claim, whoever owns it. */
  drop(kind: K, holder: object, target: object): void {
    for (const row of this.rows.where({ kind, holder, target })) {
      this.rows.delete(row);
    }
  }

  /** Ends every claim `owner` holds. */
  release(owner: Owner): void {
    this.rows.end(owner);
  }

  /** The claim on `target` for `kind` outlives `from`: `to` owns it now. */
  handOn(from: Owner, to: Owner, kind: K, target: object): void {
    this.rows.handOn(from, to, (c) => c.kind === kind && c.target === target);
  }

  lostBy(owner: Owner): boolean {
    return this.rows.lostBy(owner);
  }

  newFrame(): void {
    this.rows.newFrame();
  }
}

function firstFreeSlot(held: readonly { slot: number }[], cap: number): number {
  for (let s = 0; s < cap; s++) {
    if (!held.some(({ slot }) => slot === s)) {
      return s;
    }
  }

  return 0;
}
