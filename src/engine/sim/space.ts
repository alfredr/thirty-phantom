/** Something the space can find: where it is on the ground plane, and which level of the world it's on. */
export interface Body {
  readonly pos: { readonly x: number; readonly z: number };
  readonly level: number;
}

/** An open slot in a query: `near(cody, _, r)` asks for everything near Cody. */
export const _ = Symbol('any');
export type Any = typeof _;

/** Grid coordinates stay unique within this many cells of the origin in each direction. */
const SPAN = 2048;

/**
 * Where everything is, for one frame. The grid is rebuilt whole at the start of each frame and
 * never patched, so it can't disagree with the bodies: positions change only in the move phase,
 * after every query of the frame has run. Bodies on different levels are never near each other.
 */
export class Space<B extends Body> {
  private readonly cells = new Map<number, B[]>();
  private readonly pairs = new Map<number, readonly (readonly [B, B])[]>();

  constructor(private readonly cell = 8) {}

  /** Indexes every body for this frame, and forgets last frame's answers. */
  rebuild(bodies: Iterable<B>): void {
    this.cells.clear();
    this.pairs.clear();
    for (const body of bodies) {
      const k = this.keyOf(body.level, this.cellOf(body.pos.x), this.cellOf(body.pos.z));
      const list = this.cells.get(k);
      if (list) list.push(body);
      else this.cells.set(k, [body]);
    }
  }

  /** Whether `a` and `b` are within `r` of each other on the same level. */
  near(a: B, b: B, r: number): boolean;
  /** Everything within `r` of `a` on its level. */
  near(a: B, b: Any, r: number): B[];
  /** Every ordered pair within `r` of each other on the same level. */
  near(a: Any, b: Any, r: number): readonly (readonly [B, B])[];
  near(a: B | Any, b: B | Any, r: number): boolean | B[] | readonly (readonly [B, B])[] {
    if (a !== _ && b !== _) return a.level === b.level && distance(a, b) < r;
    if (a !== _) return this.around(a, r);
    if (b !== _) return this.around(b, r);
    return this.allPairs(r);
  }

  /** The nearest body within `r` of `a` that passes `test`, or null. */
  nearest(a: B, r: number, test: (b: B) => boolean = () => true): B | null {
    let best: B | null = null;
    let bestDistance = r;
    for (const b of this.around(a, r)) {
      const d = distance(a, b);
      if (d < bestDistance && test(b)) {
        best = b;
        bestDistance = d;
      }
    }
    return best;
  }

  private around(a: B, r: number): B[] {
    const out: B[] = [];
    const [x0, x1, z0, z1] = [this.cellOf(a.pos.x - r), this.cellOf(a.pos.x + r), this.cellOf(a.pos.z - r), this.cellOf(a.pos.z + r)];
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        for (const b of this.cells.get(this.keyOf(a.level, x, z)) ?? []) if (b !== a && distance(a, b) < r) out.push(b);
      }
    }
    return out;
  }

  private allPairs(r: number): readonly (readonly [B, B])[] {
    const cached = this.pairs.get(r);
    if (cached) return cached;
    const list: (readonly [B, B])[] = [];
    for (const bodies of this.cells.values()) for (const a of bodies) for (const b of this.around(a, r)) list.push([a, b]);
    // The only memo in the space: spatial, and dropped at the next rebuild.
    this.pairs.set(r, list);
    return list;
  }

  private cellOf(v: number): number {
    return Math.floor(v / this.cell);
  }

  private keyOf(level: number, x: number, z: number): number {
    return (level * 2 * SPAN + (x + SPAN)) * 2 * SPAN + (z + SPAN);
  }
}

function distance(a: Body, b: Body): number {
  return Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z);
}
