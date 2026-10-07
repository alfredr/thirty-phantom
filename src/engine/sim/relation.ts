/** Identity used to release related rows together through end(). */
export type Owner = object;

/** Policy for an insertion that exceeds a key’s capacity. */
export type Conflict = 'refuse' | 'evict' | 'merge';

/**
 * Limit the number of rows sharing these column values. Capacity defaults to
 * one.
 */
export interface Key<R> {
  readonly on: readonly (keyof R)[];
  readonly cap?: number | ((row: R) => number);
}

export interface RelationSpec<R> {
  readonly keys: readonly Key<R>[];
  /** The default conflict rule. An insert can override it. */
  readonly onConflict?: Conflict;
  /** Combines an existing row with an inserted one, for the `merge` rule. */
  readonly merge?: (old: R, next: R) => R;
  /** Accept a proposed row. Returning false rejects the insertion or merge. */
  readonly check?: (row: R) => boolean;
  /**
   * Rows that are deleted as soon as a merge produces them, such as an item
   * count of zero.
   */
  readonly empty?: (row: R) => boolean;
  /**
   * Runs after a row is evicted. It may queue an event, but it must not change
   * any relation.
   */
  readonly evicted?: (row: R) => void;
}

/** Rows with an owner are released by end(owner). */
export interface OwnedRow {
  readonly owner?: Owner;
}

/**
 * Store rows with capacity limits, conflict policies, and optional lifetime
 * owners. Use these methods for mutations so row and owner indexes stay
 * synchronized. Eviction callbacks may queue events but must not mutate
 * relations; process dependent changes after the write, through queued events
 * or lostBy().
 */
export class Relation<R extends OwnedRow> {
  private readonly rows = new Set<R>();
  private readonly index = new Map<string, R[]>();
  private readonly owned = new Map<Owner, Set<R>>();
  private readonly lost = new Set<Owner>();

  constructor(private readonly spec: RelationSpec<R>) {}

  get size(): number {
    return this.rows.size;
  }

  /**
   * Inserts a row, applying the conflict rule when a key is full. Returns the
   * stored row, or null if the insert was refused. A merge that empties the
   * row deletes it and returns the merged row.
   */
  insert(
    row: R,
    conflict: Conflict = this.spec.onConflict ?? 'refuse',
  ): R | null {
    for (const key of this.spec.keys) {
      const clash = this.index.get(keyOf(key.on, row)) ?? [];
      if (clash.length < capOf(key, row)) {
        continue;
      }

      const oldest = clash[0];
      if (!oldest || conflict === 'refuse') {
        return null;
      }

      if (conflict === 'merge') {
        return this.mergeInto(oldest, row);
      }

      this.evict(oldest);
    }

    if (this.spec.check && !this.spec.check(row)) {
      return null;
    }

    this.add(row);
    return row;
  }

  /** Delete this row by identity. Missing rows are ignored. */
  delete(row: R): void {
    if (!this.rows.has(row)) {
      return;
    }

    this.rows.delete(row);

    for (const key of this.spec.keys) {
      const k = keyOf(key.on, row);
      const list = this.index.get(k)?.filter((r) => r !== row) ?? [];
      if (list.length) {
        this.index.set(k, list);
      } else {
        this.index.delete(k);
      }
    }

    if (row.owner) {
      this.owned.get(row.owner)?.delete(row);
    }
  }

  /** Delete all rows belonging to this owner. */
  end(owner: Owner): void {
    for (const row of [...(this.owned.get(owner) ?? [])]) {
      this.delete(row);
    }

    this.owned.delete(owner);
  }

  /** Reinsert matching rows under `to`, preserving them when `from` ends. */
  handOn(
    from: Owner,
    to: Owner,
    test: (row: R) => boolean = () => true,
  ): void {
    for (const row of [...(this.owned.get(from) ?? [])]) {
      if (!test(row)) {
        continue;
      }

      this.delete(row);
      this.add({ ...row, owner: to });
    }
  }

  /** Whether `owner` lost a row to an eviction since the last newFrame(). */
  lostBy(owner: Owner): boolean {
    return this.lost.has(owner);
  }

  /** Clear the eviction records for the next frame. */
  newFrame(): void {
    this.lost.clear();
  }

  /**
   * The rows whose fields equal every field given, oldest first. Uses an index
   * when the fields cover a key.
   */
  where(match: Partial<R>): R[] {
    const key = this.spec.keys.find(({ on }) =>
      on.every((c) => Object.hasOwn(match, c)),
    );
    const candidates = key
      ? (this.index.get(keyOf(key.on, match)) ?? [])
      : this.rows;
    const out: R[] = [];
    for (const row of candidates) {
      if (matches(row, match)) {
        out.push(row);
      }
    }

    return out;
  }

  /** Every row, oldest first. */
  all(): R[] {
    return [...this.rows];
  }

  private add(row: R): void {
    this.rows.add(row);

    for (const key of this.spec.keys) {
      const k = keyOf(key.on, row);
      const list = this.index.get(k);
      if (list) {
        list.push(row);
      } else {
        this.index.set(k, [row]);
      }
    }

    if (row.owner) {
      const set = this.owned.get(row.owner);
      if (set) {
        set.add(row);
      } else {
        this.owned.set(row.owner, new Set([row]));
      }
    }
  }

  private mergeInto(old: R, row: R): R | null {
    if (!this.spec.merge) {
      return null;
    }

    const next = this.spec.merge(old, row);
    if (this.spec.check && !this.spec.check(next)) {
      return null;
    }

    this.delete(old);

    if (!this.spec.empty?.(next)) {
      this.add(next);
    }

    return next;
  }

  private evict(row: R): void {
    this.delete(row);

    if (row.owner) {
      this.lost.add(row.owner);
    }

    this.spec.evicted?.(row);
  }
}

function capOf<R>(key: Key<R>, row: R): number {
  const { cap = 1 } = key;
  return typeof cap === 'function' ? cap(row) : cap;
}

const ids = new WeakMap<object, number>();
let nextId = 1;

/**
 * A stable identity for a column value: objects by reference, everything else
 * by type and value.
 */
function idOf(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    let id = ids.get(value);
    if (id === undefined) {
      ids.set(value, (id = nextId++));
    }

    return `#${id}`;
  }

  return `${typeof value}:${String(value)}`;
}

function keyOf(columns: readonly PropertyKey[], row: object): string {
  return columns.map((c) => idOf(Reflect.get(row, c))).join('|');
}

function matches(row: object, match: object): boolean {
  return Object.entries(match).every(([k, v]) => Reflect.get(row, k) === v);
}
