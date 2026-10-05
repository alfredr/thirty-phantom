import { subtractRects } from '@/engine/core/geometry';
import { clamp, TAU } from '@/engine/core/math';
import { Rng } from '@/engine/core/rng';
import type { MatKey } from '@/render/materials';

import {
  BENCH,
  DECOR,
  type DecorKind,
  FOUNTAIN,
  GAZEBO,
  hitOf,
  type LocalBox,
  SHELTER,
  worldBox,
} from './decor-models';
import { BLOCK_LAYOUT, type BlockKind, blockRect, CITY, GRAVES } from './gen-city';
import type { BoxDef, DecorDef, LevelData, V3 } from './level-data';
import type { LevelWriter } from './level-writer';
import { guardrailHeight, lampHeight, railingHeight } from './prop-models';

/** A footprint: x0, z0, x1, z1. */
type Rect = [number, number, number, number];

/** Reserved horizontal footprint and vertical interval. */
interface Room {
  r: Rect;
  y0: number;
  y1: number;
}

/** Landscaping tuning (meters unless noted). */
const LAND = {
  /** Minimum decor clearance from traffic-lane centrelines. */
  lane: 2.6,
  /** Clearance behind a kicker for approach, beyond its launch edge, and to either side of both. */
  kicker: { runup: 14, launch: 10, side: 3 },
  /** Ground-level door and window clearance depth, with the materials used to identify them. */
  doorstep: 1.6,
  doors: ['glass', 'doorGlow', 'lampWarm'] as readonly MatKey[],
  /** A door or window counts as street level when its bottom is within this of the ground. */
  doorLow: 1,
  /** Clearance in front of signs across their full height. */
  signFront: 2.5,
  /** Kept round a parked car (half its length and width, padded). */
  stall: [3.2, 1.6] as [number, number],
  /** Valet clearance along the crew's -X line and in other horizontal directions. */
  valet: [4.5, 1.6] as [number, number],
  /** Reservation depth below fixture bases and vertical clearance on each side of ceiling-lamp heads. */
  under: 1,
  lampHead: 0.5,
  /** Height of ground-clearance probes for lawns and tree grates. */
  knee: 0.5,
  /** Round a lamp post, a fence or railing, an elevator shaft (its landings), the player's spawn. */
  lamp: 0.45,
  fence: 0.3,
  elevator: 2.5,
  spawn: 3,
  /**
   * Street-tree placement: curb inset, candidate fractions along a block side, descending scale choices, and pedestrian
   * clearance width and height behind trunks.
   */
  street: { inset: 1.2, at: [0.125, 0.3125, 0.6875, 0.875], scales: [1, 0.85, 0.72], walk: 0.95, head: 2 },
  /** The iron grate round a street tree's foot (its side); ground decals are this thick. */
  grate: 1.3,
  decal: 0.02,
  /**
   * Garden dimensions and placement limits: paved borders, centrepiece rings, path width, minimum lawn size, tree
   * spacing and jitter, candidate tree scales, and corner-shrub offsets and scale range.
   */
  park: {
    border: 1.5,
    ring: 2,
    pocketRing: 1.5,
    path: 3,
    lawn: 2.5,
    treeGap: 5.5,
    treeEdge: 1.8,
    jitter: 0.6,
    scales: [1.05, 0.9, 0.75],
    bushCorner: 1.2,
    bushes: [0.85, 1.15] as [number, number],
  },
  /** Minimum pocket-garden dimensions and rear-corner shrub inset. */
  pocket: { min: 4, bush: 1 },
  /** Spacing, flower-pair offset, and shrub scale for the Foxy's raised planter. */
  foxy: { step: 1.6, pair: 1, bush: 0.9 },
  /** Minimum street-edge lawn length for hedges, with hedge inset and end gaps. */
  hedge: { min: 4, inset: 0.55, end: 0.6 },
  /** Flower-row inset and spacing, color-run length, and outward probe distance used to find lawn edges beside pavement. */
  beds: { inset: 0.8, step: 1.4, run: 3, probe: 0.3 },
  /** Bench inset from the centrepiece ring's outer edge and clearance beside each path. */
  bench: { back: 0.55, gap: 0.3 },
  /**
   * Deck-front planter size, height, curb offset, candidate side fractions, reservation margin, shrub scale, flower end
   * inset, and bench separation.
   */
  planter: {
    size: [3.6, 1.1] as [number, number],
    h: 0.6,
    gap: 0.9,
    at: [0.25, 0.75],
    room: 0.6,
    bush: 0.6,
    end: 0.6,
    bench: 1.6,
  },
  /**
   * Graveyard placement limits: perimeter inset and spacing, maximum cypress and flower counts, gate clearance,
   * grave-flower offset, and plant scales.
   */
  graveyard: {
    inset: 2.4,
    step: 5,
    cypresses: 9,
    flowers: 12,
    gate: 6,
    grave: 0.7,
    sizes: [0.85, 1.1] as [number, number],
    posy: 0.8,
  },
  /** A lot or driveway this near the curb opens onto the street: the strip between them stays clear for cars. */
  lotReach: 4.5,
  /** Bus shelters stand this far back from the curb (to their front). */
  shelter: 0.9,
  /** Spots along a sidewalk are tried this far apart. */
  scan: 1,
};

/** Overlaps smaller than this don't count: touching isn't overlapping. */
const EPS = 1e-3;
const overlaps = (a: Rect, b: Rect): boolean =>
  a[0] < b[2] - EPS && b[0] < a[2] - EPS && a[1] < b[3] - EPS && b[1] < a[3] - EPS;
const grow = (r: Rect, d: number): Rect => [r[0] - d, r[1] - d, r[2] + d, r[3] + d];
const width = (r: Rect): number => r[2] - r[0];
const depth = (r: Rect): number => r[3] - r[1];
const boxRect = (b: { min: V3; max: V3 }): Rect => [b.min[0], b.min[2], b.max[0], b.max[2]];
const inside = (r: Rect, x: number, z: number): boolean => x >= r[0] && x <= r[2] && z >= r[1] && z <= r[3];

function spaceOf(d: DecorDef): LocalBox[] {
  const turn = DECOR[d.kind].round ? 0 : d.yaw;
  return DECOR[d.kind].space.map((b) => worldBox(b, d.pos, turn, d.scale ?? 1, d.stretch ?? 1));
}

function footprint(d: DecorDef): Rect {
  return spaceOf(d).reduce<Rect>(
    (r, [min, max]) => [Math.min(r[0], min[0]), Math.min(r[1], min[2]), Math.max(r[2], max[0]), Math.max(r[3], max[2])],
    [Infinity, Infinity, -Infinity, -Infinity],
  );
}

/** A shuffled copy of `a`. */
function shuffled<T>(rng: Rng, a: readonly T[]): T[] {
  const out = [...a];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }

  return out;
}

/** Offsets from the middle outward: 0, 1, -1, 2, -2 ... up to `half`. */
function outward(half: number): number[] {
  const out = [0];
  for (let d = 1; d <= half; d++) {
    out.push(d, -d);
  }

  return out;
}

/** Positions are kept to the centimeter in the level file, yaws and sizes to three places. */
const cm = (v: number): number => Math.round(v * 100) / 100;
const milli = (v: number): number => Math.round(v * 1000) / 1000;

/** Distance from (px, pz) to the segment a-b. */
function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? clamp(((px - ax) * dx + (pz - az) * dz) / l2, 0, 1) : 0;
  return Math.hypot(px - ax - dx * t, pz - az - dz * t);
}

/**
 * Estimate rectangle-to-segment distance using rectangle corners and segment endpoints. Return zero when either segment
 * endpoint lies inside the rectangle.
 */
function rectSegDist(r: Rect, ax: number, az: number, bx: number, bz: number): number {
  if (inside(r, ax, az) || inside(r, bx, bz)) {
    return 0;
  }

  const corners: [number, number][] = [
    [r[0], r[1]],
    [r[2], r[1]],
    [r[2], r[3]],
    [r[0], r[3]],
  ];
  let d = Infinity;
  for (let i = 0; i < 4; i++) {
    const [cx, cz] = corners[i] as [number, number];
    const [ex, ez] = corners[(i + 1) % 4] as [number, number];
    d = Math.min(d, segDist(cx, cz, ax, az, bx, bz), segDist(ax, az, cx, cz, ex, ez), segDist(bx, bz, cx, cz, ex, ez));
  }

  return d;
}

/** Spatial hash cell for rooms. */
const CELL = 8;

/**
 * Track reserved volumes and traffic lanes for decor placement. Seed reservations from existing geometry and gameplay
 * access areas, then reserve each newly placed item so later decor avoids it.
 */
class Site {
  private readonly cells = new Map<number, Room[]>();
  private readonly lanes: [number, number, number, number][] = [];
  private stamp = 0;
  private readonly seen = new Map<Room, number>();

  constructor(level: LevelData) {
    // Reserve vehicle access areas across the full vertical range.
    const ALL = Infinity;
    const { under, lampHead } = LAND;
    for (const b of level.boxes) {
      // Exclude the common ground slab from placement obstacles.
      if (b.max[1] <= 0) {
        continue;
      }

      // Reserve asphalt and parking paint regardless of the proposed decor height.
      const drive = (b.mat === 'asphalt' || b.mat === 'marking') && b.min[1] > -EPS;
      const door = LAND.doors.includes(b.mat) && b.min[1] < CITY.sidewalk + LAND.doorLow;
      this.take(grow(boxRect(b), door ? LAND.doorstep : 0), drive ? -ALL : b.min[1], drive ? ALL : b.max[1]);
    }

    for (const r of level.ramps) {
      const { runup, launch, side } = LAND.kicker;
      const [x0, z0, x1, z1] = boxRect(r);
      this.take([x0, z0, x1, z1], -ALL, ALL);

      if (!r.kicker) {
        continue;
      }

      // Reserve approach space behind the low end and landing space beyond the launch edge.
      const lowAtMin = r.dir === 1;
      if (r.axis === 'x') {
        this.take(
          lowAtMin ? [x0 - runup, z0 - side, x0, z1 + side] : [x1, z0 - side, x1 + runup, z1 + side],
          -ALL,
          ALL,
        );
        this.take(
          lowAtMin ? [x1, z0 - side, x1 + launch, z1 + side] : [x0 - launch, z0 - side, x0, z1 + side],
          -ALL,
          ALL,
        );
      } else {
        this.take(
          lowAtMin ? [x0 - side, z0 - runup, x1 + side, z0] : [x0 - side, z1, x1 + side, z1 + runup],
          -ALL,
          ALL,
        );
        this.take(
          lowAtMin ? [x0 - side, z1, x1 + side, z1 + launch] : [x0 - side, z0 - launch, x1 + side, z0],
          -ALL,
          ALL,
        );
      }
    }

    for (const l of level.lamps) {
      const [x, y, z] = l.pos;
      const street = l.kind === 'street';
      this.take(grow([x, z, x, z], LAND.lamp), y - (street ? under : lampHead), y + (street ? lampHeight() : lampHead));
    }

    for (const p of [...level.bays, ...level.parked]) {
      const [x, , z] = p.pos;
      const [a, c] = LAND.stall;
      const hx = Math.abs(Math.sin(p.yaw)) * a + Math.abs(Math.cos(p.yaw)) * c;
      const hz = Math.abs(Math.cos(p.yaw)) * a + Math.abs(Math.sin(p.yaw)) * c;
      this.take([x - hx, z - hz, x + hx, z + hz], -ALL, ALL);
    }

    for (const g of level.gates) {
      this.take(boxRect(g), -ALL, ALL);
    }

    for (const v of level.valets) {
      const [x, , z] = v.pos;
      const [back, round] = LAND.valet;
      this.take([x - back, z - round, x + round, z + round], -ALL, ALL);
    }

    for (const f of level.fences) {
      this.take(grow(boxRect(f), LAND.fence), f.min[1] - under, f.max[1]);
    }

    for (const r of level.rails) {
      const rect: Rect = [
        Math.min(r.a[0], r.b[0]),
        Math.min(r.a[2], r.b[2]),
        Math.max(r.a[0], r.b[0]),
        Math.max(r.a[2], r.b[2]),
      ];
      const tall = r.style === 'guardrail' ? guardrailHeight() : railingHeight();
      this.take(grow(rect, LAND.fence), Math.min(r.a[1], r.b[1]) - under, Math.max(r.a[1], r.b[1]) + tall);
    }

    for (const e of level.elevators) {
      this.take(grow(boxRect(e), LAND.elevator), -ALL, ALL);
    }

    for (const p of level.pits) {
      this.take(boxRect(p), -ALL, ALL);
    }

    const [sx, , sz] = level.playerSpawn;
    this.take(grow([sx, sz, sx, sz], LAND.spawn), -ALL, ALL);

    for (const d of level.decor) {
      for (const [min, max] of spaceOf(d)) {
        this.take([min[0], min[2], max[0], max[2]], min[1], max[1]);
      }
    }

    for (const s of level.signs) {
      const [x, y, z] = s.pos;
      const [w, h] = s.size;
      const d = LAND.signFront;
      const front: Rect =
        s.facing === 'z+'
          ? [x - w / 2, z, x + w / 2, z + d]
          : s.facing === 'z-'
            ? [x - w / 2, z - d, x + w / 2, z]
            : s.facing === 'x+'
              ? [x, z - w / 2, x + d, z + w / 2]
              : [x - d, z - w / 2, x, z + w / 2];
      this.take(front, y - h / 2, y + h / 2);
    }

    for (const p of level.paths) {
      for (let i = 0; i < p.points.length; i++) {
        const a = p.points[i] as V3;
        const b = p.points[(i + 1) % p.points.length] as V3;
        this.lanes.push([a[0], a[2], b[0], b[2]]);
      }
    }
  }

  private key(ix: number, iz: number): number {
    return (ix + 2048) * 4096 + (iz + 2048);
  }

  /** Keep `r` clear between heights y0 and y1 from now on. */
  take(r: Rect, y0: number, y1: number): void {
    const room: Room = { r, y0, y1 };
    for (let ix = Math.floor(r[0] / CELL); ix <= Math.floor(r[2] / CELL); ix++) {
      for (let iz = Math.floor(r[1] / CELL); iz <= Math.floor(r[3] / CELL); iz++) {
        const k = this.key(ix, iz);
        const list = this.cells.get(k);
        if (list) {
          list.push(room);
        } else {
          this.cells.set(k, [room]);
        }
      }
    }
  }

  /** Nothing over `r` between heights y0 and y1, and no traffic lane near it. */
  free(r: Rect, y0: number, y1: number): boolean {
    const st = ++this.stamp;
    for (let ix = Math.floor(r[0] / CELL); ix <= Math.floor(r[2] / CELL); ix++) {
      for (let iz = Math.floor(r[1] / CELL); iz <= Math.floor(r[3] / CELL); iz++) {
        for (const room of this.cells.get(this.key(ix, iz)) ?? []) {
          if (this.seen.get(room) === st) {
            continue;
          }

          this.seen.set(room, st);

          if (room.y1 > y0 + EPS && room.y0 < y1 - EPS && overlaps(room.r, r)) {
            return false;
          }
        }
      }
    }

    const d = LAND.lane;
    return this.lanes.every(([ax, az, bx, bz]) => {
      // Skip exact lane-distance checks when the bounding boxes are already separated.
      if (
        Math.min(ax, bx) > r[2] + d ||
        Math.max(ax, bx) < r[0] - d ||
        Math.min(az, bz) > r[3] + d ||
        Math.max(az, bz) < r[1] - d
      ) {
        return true;
      }

      return rectSegDist(r, ax, az, bx, bz) >= d;
    });
  }
}

/** Append decor and static collision while reserving space for later placements. */
class Planter {
  constructor(
    readonly w: LevelWriter,
    readonly site: Site,
    readonly rng: Rng,
  ) {}

  /** Return whether all transformed reservation boxes for this decor fit the site. */
  fits(kind: DecorKind, pos: V3, yaw = 0, s = 1, stretch = 1): boolean {
    const turn = DECOR[kind].round ? 0 : yaw;
    return DECOR[kind].space.every((b) => {
      const [min, max] = worldBox(b, pos, turn, s, stretch);
      return this.site.free([min[0], min[2], max[0], max[2]], min[1], max[1]);
    });
  }

  /**
   * Append decor without checking fit, round stored placement values, and reserve its transformed space. Append
   * collision only for static decor; breakable collision is built at runtime.
   */
  put(kind: DecorKind, pos: V3, yaw = 0, s = 1, stretch = 1): void {
    const p: V3 = [cm(pos[0]), cm(pos[1]), cm(pos[2])];
    const y = milli(yaw);
    this.w.decor(kind, p, y, {
      ...(s !== 1 ? { scale: milli(s) } : {}),
      ...(stretch !== 1 ? { stretch: milli(stretch) } : {}),
    });
    const turn = DECOR[kind].round ? 0 : y;
    for (const b of hitOf(kind, milli(s)) ? [] : DECOR[kind].solids) {
      const [min, max] = worldBox(b, p, turn, s, stretch);
      this.w.box(min, max, 'invisible');
    }

    for (const b of DECOR[kind].space) {
      const [min, max] = worldBox(b, p, turn, s, stretch);
      this.site.take([min[0], min[2], max[0], max[2]], min[1], max[1]);
    }
  }

  /** Append and reserve the decor only if fits() succeeds. Return whether it was placed. */
  tryPut(kind: DecorKind, pos: V3, yaw = 0, s = 1, stretch = 1): boolean {
    if (!this.fits(kind, pos, yaw, s, stretch)) {
      return false;
    }

    this.put(kind, pos, yaw, s, stretch);
    return true;
  }

  /** Append and reserve a thin ground decal at height y if its volume is free. Return whether it was placed. */
  decal(r: Rect, y: number, mat: MatKey): boolean {
    if (!this.site.free(r, y, y + LAND.decal)) {
      return false;
    }

    this.w.box([r[0], y, r[1]], [r[2], y + LAND.decal, r[3]], mat, { solid: false });
    this.site.take(r, y, y + LAND.decal);
    return true;
  }

  /** Return a uniformly random yaw in radians for visually varied placement. */
  spin(): number {
    return this.rng.range(0, TAU);
  }
}

/**
 * Divide an axis-aligned hedge run into evenly stretched modules and try each placement independently. Skip obstructed
 * modules.
 */
function hedgeRun(p: Planter, a: [number, number], b: [number, number], y: number): void {
  const alongX = Math.abs(b[0] - a[0]) > Math.abs(b[1] - a[1]);
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const mod = DECOR.hedge.space[0] as LocalBox;
  const unit = mod[1][0] - mod[0][0];
  const n = Math.max(1, Math.round(len / unit));
  const stretch = len / n / unit;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    p.tryPut('hedge', [a[0] + (b[0] - a[0]) * t, y, a[1] + (b[1] - a[1]) * t], alongX ? 0 : Math.PI / 2, 1, stretch);
  }
}

/** A row of flower clumps from a to b, colors alternating in runs. */
function flowerRow(p: Planter, a: [number, number], b: [number, number], y: number): void {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const n = Math.floor(len / LAND.beds.step) + 1;
  const first = p.rng.chance(0.5);
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const purple = Math.floor(i / LAND.beds.run) % 2 === 0 ? first : !first;
    p.tryPut(
      purple ? 'flowersPurple' : 'flowersSlime',
      [a[0] + (b[0] - a[0]) * t, y, a[1] + (b[1] - a[1]) * t],
      p.spin(),
    );
  }
}

/** Try trees on a jittered lawn grid, reducing scale until each candidate fits or all scales fail. */
function lawnTrees(p: Planter, lawn: Rect, y: number, kinds: readonly DecorKind[]): void {
  const { treeGap, treeEdge, jitter, scales } = LAND.park;
  // Collapse undersized inset dimensions to the lawn centre before placing trees.
  const g = grow(lawn, -treeEdge);
  const r: Rect = [
    Math.min(g[0], (lawn[0] + lawn[2]) / 2),
    Math.min(g[1], (lawn[1] + lawn[3]) / 2),
    Math.max(g[2], (lawn[0] + lawn[2]) / 2),
    Math.max(g[3], (lawn[1] + lawn[3]) / 2),
  ];
  const nx = Math.max(1, Math.round(width(r) / treeGap) + 1);
  const nz = Math.max(1, Math.round(depth(r) / treeGap) + 1);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const x = nx === 1 ? (r[0] + r[2]) / 2 : r[0] + (width(r) * i) / (nx - 1);
      const z = nz === 1 ? (r[1] + r[3]) / 2 : r[1] + (depth(r) * j) / (nz - 1);
      const kind = p.rng.pick(kinds);
      const pos: V3 = [x + p.rng.range(-jitter, jitter), y, z + p.rng.range(-jitter, jitter)];
      const yaw = p.spin();
      for (const s of scales) {
        if (p.tryPut(kind, pos, yaw, s)) {
          break;
        }
      }
    }
  }
}

/**
 * Merge lawn spans touching the specified area edge. Return (start, end, edgeCoordinate) triples, excluding runs
 * shorter than LAND.hedge.min.
 */
function edgeRuns(lawns: readonly Rect[], area: Rect, side: 'x0' | 'x1' | 'z0' | 'z1'): [number, number, number][] {
  const i = { x0: 0, z0: 1, x1: 2, z1: 3 }[side];
  const alongX = side === 'z0' || side === 'z1';
  const edge = area[i] as number;
  const spans = lawns
    .filter((l) => Math.abs((l[i] as number) - edge) < EPS)
    .map((l) => (alongX ? [l[0], l[2]] : [l[1], l[3]]) as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const out: [number, number, number][] = [];
  for (const [a, b] of spans) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + EPS) {
      last[1] = Math.max(last[1], b);
    } else {
      out.push([a, b, edge]);
    }
  }

  return out.filter(([a, b]) => b - a >= LAND.hedge.min);
}

/**
 * Try gazebo placements ordered by sampled lawn clearance, breaking ties by distance from (cx, cz). Place the first
 * fitting candidate; leave the site unchanged if none fits.
 */
function gazeboSpot(p: Planter, lawns: readonly Rect[], cx: number, cz: number, y: number): void {
  const onLawn = (x: number, z: number): boolean => lawns.some((l) => inside(l, x, z));
  // Expand radial clearance in STEP increments, checking ROUND sample points per ring.
  const ROUND = 16;
  const STEP = 0.25;
  const room = (x: number, z: number): number => {
    let r = 0;
    for (;;) {
      const next = r + STEP;
      for (let k = 0; k < ROUND; k++) {
        const a = (k / ROUND) * TAU;
        if (!onLawn(x + Math.sin(a) * next, z + Math.cos(a) * next)) {
          return r;
        }
      }

      r = next;
    }
  };

  const spots: [number, number, number, number][] = [];
  for (const l of lawns) {
    for (let x = l[0]; x <= l[2]; x += LAND.scan) {
      for (let z = l[1]; z <= l[3]; z += LAND.scan) {
        const r = room(x, z);
        if (r >= GAZEBO.floor.r) {
          spots.push([x, z, r, Math.hypot(x - cx, z - cz)]);
        }
      }
    }
  }

  spots.sort((a, b) => b[2] - a[2] || b[3] - a[3]);

  for (const [x, z] of spots) {
    if (p.tryPut('gazebo', [x, y, z], 0)) {
      return;
    }
  }
}

/**
 * Plant around a centrepiece with half-size `core` at (cx, cz), preserving a paved ring and paths to each side of
 * `area`. Add lawns, hedges, trees, flowers, and inward-facing benches where space permits; optionally place a gazebo
 * first.
 */
function garden(
  p: Planter,
  area: Rect,
  cx: number,
  cz: number,
  core: number,
  opts: { gazebo?: boolean; ring?: number; trees: readonly DecorKind[] },
): void {
  const SW = CITY.sidewalk;
  const { path, lawn: minLawn } = LAND.park;
  const ring = opts.ring ?? LAND.park.ring;
  const inner: Rect = [cx - core, cz - core, cx + core, cz + core];
  const paved = grow(inner, ring);
  const h = path / 2;
  const paths: Rect[] = [
    [cx - h, area[1], cx + h, paved[1]],
    [cx - h, paved[3], cx + h, area[3]],
    [area[0], cz - h, paved[0], cz + h],
    [paved[2], cz - h, area[2], cz + h],
  ];
  const holes = [paved, ...paths].map(([u0, v0, u1, v1]) => ({ u0, v0, u1, v1 }));
  let lawns: Rect[] = subtractRects({ u0: area[0], v0: area[1], u1: area[2], v1: area[3] }, holes).map(
    (f) => [f.u0, f.v0, f.u1, f.v1] as Rect,
  );
  // Carve lawn footprints around existing reservations before planting.
  lawns = lawns.flatMap((l) => carve(p, l, SW));
  lawns = lawns.filter((l) => width(l) >= minLawn && depth(l) >= minLawn);
  const y = SW + LAND.decal;
  for (const l of lawns) {
    p.decal(l, SW, 'grass');
  }

  // Place the gazebo before smaller decor because it requires the most contiguous lawn space.
  if (opts.gazebo) {
    gazeboSpot(p, lawns, cx, cz, y);
  }

  // Place hedge runs only on lawns that reach the street-facing area edges.
  const { inset, end } = LAND.hedge;
  for (const [lo, hi, edge] of edgeRuns(lawns, area, 'z0')) {
    hedgeRun(p, [lo + end, edge + inset], [hi - end, edge + inset], y);
  }

  for (const [lo, hi, edge] of edgeRuns(lawns, area, 'z1')) {
    hedgeRun(p, [lo + end, edge - inset], [hi - end, edge - inset], y);
  }

  for (const [lo, hi, edge] of edgeRuns(lawns, area, 'x0')) {
    hedgeRun(p, [edge + inset, lo + end], [edge + inset, hi - end], y);
  }

  for (const [lo, hi, edge] of edgeRuns(lawns, area, 'x1')) {
    hedgeRun(p, [edge - inset, lo + end], [edge - inset, hi - end], y);
  }

  for (const l of lawns) {
    lawnTrees(p, l, y, opts.trees);
  }

  // Place flower beds along paved lawn edges, excluding boundaries shared by two lawns.
  const { inset: bi, step, probe } = LAND.beds;
  const onLawn = (x: number, z: number): boolean => lawns.some((l) => inside(l, x, z));
  for (const l of lawns) {
    const edges: { a: [number, number]; b: [number, number]; out: [number, number] }[] = [
      { a: [l[0], l[1]], b: [l[2], l[1]], out: [0, -1] },
      { a: [l[0], l[3]], b: [l[2], l[3]], out: [0, 1] },
      { a: [l[0], l[1]], b: [l[0], l[3]], out: [-1, 0] },
      { a: [l[2], l[1]], b: [l[2], l[3]], out: [1, 0] },
    ];
    for (const { a, b, out } of edges) {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.floor((len - 2 * bi) / step);
      if (n < 1) {
        continue;
      }

      const first = p.rng.chance(0.5);
      for (let i = 0; i <= n; i++) {
        const t = (bi + ((len - 2 * bi) * i) / n) / len;
        const ex = a[0] + (b[0] - a[0]) * t;
        const ez = a[1] + (b[1] - a[1]) * t;
        // Require the outside edge sample to lie on pavement within the area.
        const ox = ex + out[0] * probe;
        const oz = ez + out[1] * probe;
        if (!inside(area, ox, oz) || onLawn(ox, oz)) {
          continue;
        }

        const purple = Math.floor(i / LAND.beds.run) % 2 === 0 ? first : !first;
        p.tryPut(purple ? 'flowersPurple' : 'flowersSlime', [ex - out[0] * bi, y, ez - out[1] * bi], p.spin());
      }
    }
  }

  // Try shrubs at lawn corners left clear by earlier placements.
  const { bushCorner: bc, bushes } = LAND.park;
  for (const l of lawns) {
    for (const [x, z] of [
      [l[0] + bc, l[1] + bc],
      [l[2] - bc, l[3] - bc],
    ] as const) {
      p.tryPut('bush', [x, y, z], p.spin(), p.rng.range(...bushes));
    }
  }

  // Face benches toward the centerpiece and leave each path entrance clear.
  const { back, gap } = LAND.bench;
  const d = core + ring - back;
  const off = h + BENCH.len / 2 + gap;
  for (const side of [-1, 1]) {
    p.tryPut('bench', [cx + side * off, SW, cz - d], 0);
    p.tryPut('bench', [cx + side * off, SW, cz + d], Math.PI);
    p.tryPut('bench', [cx - d, SW, cz + side * off], Math.PI / 2);
    p.tryPut('bench', [cx + d, SW, cz + side * off], -Math.PI / 2);
  }
}

/** Target grid-cell size in meters when carving lawn around reservations. */
const CARVE = 0.5;

/**
 * Sample the requested footprint for ground-level clearance, then merge clear cells into non-overlapping rectangles.
 * Return an empty list when the footprint cannot hold a grid cell.
 */
function carve(p: Planter, r: Rect, y: number): Rect[] {
  // Mark unreserved cells at approximately CARVE spacing before assembling lawn rectangles.
  const nx = Math.round(width(r) / CARVE);
  const nz = Math.round(depth(r) / CARVE);
  if (nx < 1 || nz < 1) {
    return [];
  }

  const sx = width(r) / nx;
  const sz = depth(r) / nz;
  const ok: boolean[] = [];
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = r[0] + i * sx;
      const z = r[1] + j * sz;
      ok.push(p.site.free([x, z, x + sx, z + sz], y, y + LAND.knee));
    }
  }

  if (ok.every(Boolean)) {
    return [r];
  }

  // Extend each clear horizontal run downward while its full width remains unused and clear.
  const out: Rect[] = [];
  const used = new Uint8Array(ok.length);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      if (used[j * nx + i] || !ok[j * nx + i]) {
        continue;
      }

      let i1 = i;
      while (i1 + 1 < nx && ok[j * nx + i1 + 1] && !used[j * nx + i1 + 1]) {
        i1++;
      }

      let j1 = j;
      const rowOk = (jj: number): boolean => {
        for (let ii = i; ii <= i1; ii++) {
          if (!ok[jj * nx + ii] || used[jj * nx + ii]) {
            return false;
          }
        }

        return true;
      };

      while (j1 + 1 < nz && rowOk(j1 + 1)) {
        j1++;
      }

      for (let jj = j; jj <= j1; jj++) {
        for (let ii = i; ii <= i1; ii++) {
          used[jj * nx + ii] = 1;
        }
      }

      out.push([r[0] + i * sx, r[1] + j * sz, r[0] + (i1 + 1) * sx, r[1] + (j1 + 1) * sz]);
    }
  }

  return out;
}

/** Boxes in the block whose footprint is at least this wide and which stand this tall: buildings, not furniture. */
const BUILDING = { wide: 6, tall: 3 };

/** Return boxes whose footprints overlap r and satisfy pick. */
function boxesIn(level: LevelData, r: Rect, pick: (b: BoxDef) => boolean): BoxDef[] {
  return level.boxes.filter((b) => overlaps(boxRect(b), r) && pick(b));
}

/** Plant a park around the existing slime fountain in the open area north of the shops, subject to reserved access. */
function squarePark(p: Planter, block: Rect): void {
  const L = p.w.data;
  const pool = boxesIn(L, block, (b) => b.mat === 'slimePool')[0];
  const shops = boxesIn(
    L,
    block,
    (b) => b.solid !== false && b.max[0] - b.min[0] >= BUILDING.wide && b.max[1] - b.min[1] >= BUILDING.tall,
  );
  const open = Math.min(block[3], ...shops.map((b) => b.min[2]));
  const area = grow([block[0], block[1], block[2], open], -LAND.park.border);
  if (!pool || width(area) < 10 || depth(area) < 10) {
    return;
  }

  // the fountain: the pool and the stone rim round it
  const pr = boxRect(pool);
  const rim = boxesIn(L, grow(pr, 1), (b) => b.mat === 'stone').map(boxRect);
  const [x0, z0, x1, z1] = rim.reduce(
    (u, r) => [Math.min(u[0], r[0]), Math.min(u[1], r[1]), Math.max(u[2], r[2]), Math.max(u[3], r[3])],
    pr,
  );
  garden(p, area, (x0 + x1) / 2, (z0 + z1) / 2, Math.max(x1 - x0, z1 - z0) / 2, {
    gazebo: true,
    trees: ['tree', 'tree', 'pine'],
  });
}

/** Plant a fountain garden between the plaza lot and nearby structures, then try a street-facing bus shelter beside it. */
function plazaGarden(p: Planter, block: Rect): void {
  const L = p.w.data;
  const SW = CITY.sidewalk;
  const lot = boxesIn(L, block, (b) => b.mat === 'asphalt' && b.min[1] > EPS).sort(
    (a, b) => width(boxRect(b)) - width(boxRect(a)),
  )[0];
  if (!lot) {
    return;
  }

  const south = lot.max[2];
  // Limit the garden at the nearest tall obstruction east of the plaza boundary.
  const tall = boxesIn(
    L,
    [block[0], south, block[2], block[3]],
    (b) => b.solid !== false && b.max[1] - b.min[1] >= BUILDING.tall,
  );
  const east = Math.min(block[2], ...tall.map((b) => b.min[0]));
  const area = grow([block[0], south, east, block[3]], -LAND.park.border);
  if (width(area) < 10 || depth(area) < 10) {
    return;
  }

  const cx = (area[0] + area[2]) / 2;
  const cz = (area[1] + area[3]) / 2;
  p.tryPut('fountain', [cx, SW, cz]);
  garden(p, area, cx, cz, FOUNTAIN.basin.r + 0.2, { ring: LAND.park.pocketRing, trees: ['tree'] });
  // a bus shelter facing the street, east of the garden
  const z = block[3] - LAND.shelter - SHELTER.d / 2;
  for (let x = area[2] + SHELTER.w; x < block[2] - SHELTER.w; x += LAND.scan) {
    if (p.tryPut('shelter', [x, SW, z], 0)) {
      break;
    }
  }
}

/**
 * Plant low shrubs and flowers on the Foxy's raised planter to preserve valet visibility. Add corner gardens,
 * podium-side hedges, and a side-street shelter where space permits.
 */
function hotelGrounds(p: Planter, block: Rect): void {
  const L = p.w.data;
  const SW = CITY.sidewalk;
  const planter = boxesIn(L, block, (b) => b.top === 'grass')[0];
  if (planter) {
    const [x0, z0, x1, z1] = boxRect(planter);
    const y = planter.max[1];
    const zc = (z0 + z1) / 2;
    const { step, pair, bush } = LAND.foxy;
    // Alternate shrubs and flower pairs, leaving half a spacing interval at each end.
    const run = x1 - x0 - step;
    const n = Math.floor(run / step);
    for (let i = 0; i <= n; i++) {
      const x = x0 + step / 2 + (run * i) / Math.max(1, n);
      if (i % 2) {
        p.tryPut(i % 4 === 1 ? 'flowersPurple' : 'flowersSlime', [x, y, zc - pair], p.spin());
        p.tryPut(i % 4 === 1 ? 'flowersSlime' : 'flowersPurple', [x, y, zc + pair], p.spin());
      } else {
        p.tryPut('bush', [x, y, zc], p.spin(), bush);
      }
    }
  }

  // Use the widest hotel box as the podium footprint.
  const podium = boxesIn(L, block, (b) => b.solid !== false && b.max[1] - b.min[1] >= BUILDING.tall).sort(
    (a, b) => width(boxRect(b)) - width(boxRect(a)),
  )[0];
  const lanes = boxesIn(L, block, (b) => b.mat === 'asphalt' && b.min[1] > EPS);
  if (!podium || !lanes.length) {
    return;
  }

  const [px0, pz0, px1, pz1] = boxRect(podium);
  const y = SW;
  const { inset, end } = LAND.hedge;
  for (const x of [px0 - inset, px1 + inset]) {
    hedgeRun(p, [x, pz0 + end], [x, pz1 - end], y);
  }

  // Fit front gardens between the driveways and block boundaries.
  const laneX0 = Math.min(...lanes.map((b) => b.min[0]));
  const laneX1 = Math.max(...lanes.map((b) => b.max[0]));
  const B = LAND.park.border;
  const front = pz1 + B;
  for (const r of [
    [block[0] + B, front, laneX0 - B, block[3] - B],
    [laneX1 + B, front, block[2] - B, block[3] - B],
  ] as Rect[]) {
    pocket(p, r);
  }

  // a bus shelter on the west side street, facing it
  const x = block[0] + LAND.shelter + SHELTER.d / 2;
  const mid = (pz0 + pz1) / 2;
  for (const d of outward(Math.floor((pz1 - pz0) / 2 - SHELTER.w))) {
    if (p.tryPut('shelter', [x, SW, mid + d * LAND.scan], -Math.PI / 2)) {
      break;
    }
  }
}

/** A small garden on open pavement: lawn with trees down it, bushes at the back corners and flowers along the front. */
function pocket(p: Planter, r: Rect): void {
  const SW = CITY.sidewalk;
  const { min, bush } = LAND.pocket;
  if (width(r) < min || depth(r) < min) {
    return;
  }

  const lawns = carve(p, r, SW).filter((l) => width(l) >= LAND.park.lawn && depth(l) >= LAND.park.lawn);
  const y = SW + LAND.decal;
  for (const l of lawns) {
    if (!p.decal(l, SW, 'grass')) {
      continue;
    }

    lawnTrees(p, l, y, ['tree']);
    const bi = LAND.beds.inset;
    flowerRow(p, [l[0] + bi, l[3] - bi], [l[2] - bi, l[3] - bi], y);
    p.tryPut('bush', [l[0] + bush, y, l[1] + bush], p.spin());
    p.tryPut('bush', [l[2] - bush, y, l[1] + bush], p.spin());
  }
}

/**
 * Add low deck-front planters with shrubs and flowers, plus street-facing benches, while preserving clear views of the
 * deck.
 */
function deckFront(p: Planter, block: Rect): void {
  const SW = CITY.sidewalk;
  const { size, h, gap, at } = LAND.planter;
  const [len, wid] = size;
  const z = block[3] - gap - wid / 2;
  for (const f of at) {
    const x = block[0] + (block[2] - block[0]) * f;
    const r: Rect = [x - len / 2, z - wid / 2, x + len / 2, z + wid / 2];
    if (!p.site.free(grow(r, LAND.planter.room), SW, SW + h + 1)) {
      continue;
    }

    p.w.box([r[0], SW, r[1]], [r[2], SW + h, r[3]], 'stone', { top: 'grass' });
    p.site.take(r, SW, SW + h);
    const y = SW + h;
    p.tryPut('bush', [x, y, z], p.spin(), LAND.planter.bush);
    p.tryPut('flowersPurple', [x - len / 2 + LAND.planter.end, y, z], p.spin());
    p.tryPut('flowersSlime', [x + len / 2 - LAND.planter.end, y, z], p.spin());

    for (const side of [-1, 1]) {
      p.tryPut('bench', [x + side * (len / 2 + LAND.planter.bench), SW, z], 0);
    }
  }
}

/** The graveyard: dark cypresses inside its fence, and purple flowers left on some of the graves. */
function graveyardPlanting(p: Planter, block: Rect): void {
  const G = CITY.graveyard;
  const { inset, step, cypresses, flowers, gate, grave, sizes, posy } = LAND.graveyard;
  const ring: [number, number][] = [];
  const r = grow(block, -inset);
  for (let x = r[0]; x <= r[2]; x += step) {
    ring.push([x, r[1]], [x, r[3]]);
  }

  for (let z = r[1] + step; z < r[3]; z += step) {
    ring.push([r[0], z], [r[2], z]);
  }

  const mx = (block[0] + block[2]) / 2;
  const mz = (block[1] + block[3]) / 2;
  let n = 0;
  for (const [x, z] of shuffled(p.rng, ring)) {
    if (n >= cypresses) {
      break;
    }

    if (Math.abs(x - mx) < gate || Math.abs(z - mz) < gate) {
      continue;
    }

    if (p.tryPut('cypress', [x, G, z], p.spin(), p.rng.range(...sizes))) {
      n++;
    }
  }

  const graves = p.w.data.decor
    .filter((d) => GRAVES.includes(d.kind))
    .map(footprint)
    .filter((r) => overlaps(r, block));
  let k = 0;
  for (const r of shuffled(p.rng, graves)) {
    if (k >= flowers) {
      break;
    }

    if (p.tryPut('flowersPurple', [(r[0] + r[2]) / 2, G, r[3] + grave], p.spin(), posy)) {
      k++;
    }
  }
}

/** Street trees along a block's sidewalks wherever they fit (with a walkway left behind them), each in an iron grate. */
function streetTrees(p: Planter, block: Rect): void {
  const SW = CITY.sidewalk;
  const [x0, z0, x1, z1] = block;
  const { inset, at, scales, walk, head } = LAND.street;
  const sides: { a: [number, number]; d: [number, number]; n: [number, number]; len: number }[] = [
    { a: [x0, z0], d: [1, 0], n: [0, 1], len: x1 - x0 },
    { a: [x0, z1], d: [1, 0], n: [0, -1], len: x1 - x0 },
    { a: [x0, z0], d: [0, 1], n: [1, 0], len: z1 - z0 },
    { a: [x1, z0], d: [0, 1], n: [-1, 0], len: z1 - z0 },
  ];
  // Use the full-size trunk radius for pedestrian walkway clearance.
  const trunk = (DECOR.tree.solids[0] as LocalBox)[1][0];
  const g = LAND.grate / 2;
  for (const { a, d, n, len } of sides) {
    for (const f of at) {
      const t = len * f;
      const x = a[0] + d[0] * t + n[0] * inset;
      const z = a[1] + d[1] * t + n[1] * inset;
      const grate: Rect = [x - g, z - g, x + g, z + g];
      if (!p.site.free(grate, SW, SW + LAND.knee)) {
        continue;
      }

      // Reserve pedestrian passage between each trunk and the buildings.
      const bx = x + n[0] * (trunk + walk / 2);
      const bz = z + n[1] * (trunk + walk / 2);
      const hw = walk / 2;
      if (!p.site.free([bx - hw, bz - hw, bx + hw, bz + hw], SW, SW + head)) {
        continue;
      }

      const yaw = p.spin();
      const s = scales.find((sc) => p.fits('tree', [x, SW, z], yaw, sc));
      if (s === undefined) {
        continue;
      }

      p.decal(grate, SW, 'metal');
      p.put('tree', [x, SW + LAND.decal, z], yaw, s);
    }
  }
}

/** Keep clear the sidewalk between the block's curb and any lot or driveway near it, where cars cross to get in. */
function lotMouths(p: Planter, block: Rect): void {
  const lots = boxesIn(p.w.data, block, (b) => b.mat === 'asphalt' && b.min[1] > EPS);
  const reach = LAND.lotReach;
  for (const b of lots) {
    const [x0, z0, x1, z1] = boxRect(b);
    if (x0 - block[0] <= reach) {
      p.site.take([block[0], z0, x0, z1], -Infinity, Infinity);
    }

    if (block[2] - x1 <= reach) {
      p.site.take([x1, z0, block[2], z1], -Infinity, Infinity);
    }

    if (z0 - block[1] <= reach) {
      p.site.take([x0, block[1], x1, z0], -Infinity, Infinity);
    }

    if (block[3] - z1 <= reach) {
      p.site.take([x0, z1, x1, block[3]], -Infinity, Infinity);
    }
  }
}

/** Reserve a connection from each kicker's approach area to the nearer block edge so vehicles can enter from the street. */
function kickerApproach(p: Planter, block: Rect): void {
  const { runup, side } = LAND.kicker;
  for (const r of p.w.data.ramps) {
    if (!r.kicker || !overlaps(boxRect(r), block)) {
      continue;
    }

    const [x0, z0, x1, z1] = boxRect(r);
    if (r.axis === 'z') {
      const lo = r.dir === 1 ? z0 - runup : z1;
      const hi = r.dir === 1 ? z0 : z1 + runup;
      const east = block[2] - (x1 + side) < x0 - side - block[0];
      p.site.take(east ? [x1 + side, lo, block[2], hi] : [block[0], lo, x0 - side, hi], -Infinity, Infinity);
    } else {
      const lo = r.dir === 1 ? x0 - runup : x1;
      const hi = r.dir === 1 ? x0 : x1 + runup;
      const south = block[3] - (z1 + side) < z0 - side - block[1];
      p.site.take(south ? [lo, z1 + side, hi, block[3]] : [lo, block[1], hi, z0 - side], -Infinity, Infinity);
    }
  }
}

/** Blocks that get street trees: the ones with sidewalks and nothing of their own planted on every side. */
const STREET_TREES: readonly BlockKind[] = ['towers', 'midrise', 'lot', 'shops', 'plaza', 'hotel'];

/**
 * Append seeded landscaping after city and deck generation. Reserve lot entrances and kicker approaches first, then
 * plant each block by use and add street trees. Placement checks account for existing geometry, traffic lanes, and
 * previously added decor.
 */
export function generateLandscape(w: LevelWriter, seed: number): void {
  const p = new Planter(w, new Site(w.data), new Rng(seed));
  const blocks: { kind: BlockKind; rect: Rect }[] = [];
  for (let bx = 0; bx < CITY.blocks; bx++) {
    for (let bz = 0; bz < CITY.blocks; bz++) {
      blocks.push({ kind: BLOCK_LAYOUT[bx]?.[bz] ?? 'towers', rect: blockRect(bx, bz) });
    }
  }

  for (const { rect } of blocks) {
    lotMouths(p, rect);
    kickerApproach(p, rect);
  }

  for (const { kind, rect } of blocks) {
    if (kind === 'shops') {
      squarePark(p, rect);
    } else if (kind === 'plaza') {
      plazaGarden(p, rect);
    } else if (kind === 'hotel') {
      hotelGrounds(p, rect);
    } else if (kind === 'deck') {
      deckFront(p, rect);
    } else if (kind === 'graveyard') {
      graveyardPlanting(p, rect);
    }
  }

  for (const { kind, rect } of blocks) {
    if (STREET_TREES.includes(kind)) {
      streetTrees(p, rect);
    }
  }
}
