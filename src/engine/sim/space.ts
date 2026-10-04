/** A body indexed by its world position. */
export interface Body {
  readonly pos: { readonly x: number; readonly y: number; readonly z: number };
}

/** An open slot in a query: `near(cody, _, r)` asks for everything near Cody. */
export const _ = Symbol('any');
export type Any = typeof _;

/** Grid coordinates stay unique within this many cells of the origin in each direction. */
const SPAN = 2048;

/**
 * Index bodies for ground-plane proximity queries with a separate vertical tolerance. Rebuild before querying each
 * frame, and keep body positions fixed until all queries finish: the grid stores body references and pair results are
 * cached. Both radius and vertical tolerance comparisons are strict.
 */
export class Space<B extends Body> {
  private readonly cells = new Map<number, B[]>();
  private readonly pairs = new Map<string, readonly (readonly [B, B])[]>();

  constructor(
    private readonly cell = 8,
    private readonly level = 2,
  ) {}

  /** Rebuild the spatial index and invalidate cached pair queries. */
  rebuild(bodies: Iterable<B>): void {
    this.cells.clear();
    this.pairs.clear();

    for (const body of bodies) {
      const k = this.keyOf(this.cellOf(body.pos.x), this.cellOf(body.pos.z));
      const list = this.cells.get(k);
      if (list) {
        list.push(body);
      } else {
        this.cells.set(k, [body]);
      }
    }
  }

  /** Whether `a` and `b` are within `r` of each other on the same level. */
  near(a: B, b: B, r: number, level?: number): boolean;
  /** Everything within `r` of `a` on its level. */
  near(a: B, b: Any, r: number, level?: number): B[];
  /** Every ordered pair within `r` of each other on the same level. */
  near(a: Any, b: Any, r: number, level?: number): readonly (readonly [B, B])[];
  near(a: B | Any, b: B | Any, r: number, level = this.level): boolean | B[] | readonly (readonly [B, B])[] {
    if (a !== _ && b !== _) {
      return close(a, b, r, level);
    }

    if (a !== _) {
      return this.around(a, r, level);
    }

    if (b !== _) {
      return this.around(b, r, level);
    }

    return this.allPairs(r, level);
  }

  /** The nearest body within `r` of `a` on its level that passes `test`, or null. */
  nearest(a: B, r: number, test: (b: B) => boolean = () => true, level = this.level): B | null {
    let best: B | null = null;
    let bestDistance = r;
    for (const b of this.around(a, r, level)) {
      const d = planDistance(a, b);
      if (d < bestDistance && test(b)) {
        best = b;
        bestDistance = d;
      }
    }

    return best;
  }

  private around(a: B, r: number, level: number): B[] {
    const out: B[] = [];
    const [x0, x1, z0, z1] = [
      this.cellOf(a.pos.x - r),
      this.cellOf(a.pos.x + r),
      this.cellOf(a.pos.z - r),
      this.cellOf(a.pos.z + r),
    ];
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        for (const b of this.cells.get(this.keyOf(x, z)) ?? []) {
          if (b !== a && close(a, b, r, level)) {
            out.push(b);
          }
        }
      }
    }

    return out;
  }

  private allPairs(r: number, level: number): readonly (readonly [B, B])[] {
    const key = `${r}:${level}`;
    const cached = this.pairs.get(key);
    if (cached) {
      return cached;
    }

    const list: (readonly [B, B])[] = [];
    for (const bodies of this.cells.values()) {
      for (const a of bodies) {
        for (const b of this.around(a, r, level)) {
          list.push([a, b]);
        }
      }
    }

    // Pair results remain valid only until the next rebuild.
    this.pairs.set(key, list);
    return list;
  }

  private cellOf(v: number): number {
    return Math.floor(v / this.cell);
  }

  private keyOf(x: number, z: number): number {
    return (x + SPAN) * 2 * SPAN + (z + SPAN);
  }
}

function planDistance(a: Body, b: Body): number {
  return Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z);
}

function close(a: Body, b: Body, r: number, level: number): boolean {
  return Math.abs(a.pos.y - b.pos.y) < level && planDistance(a, b) < r;
}
