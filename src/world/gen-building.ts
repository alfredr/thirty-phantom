import { Rng } from '@/engine/core/rng';
import type { MatKey } from '@/render/materials';

import {
  bayCount,
  doorBay,
  doorWidth,
  FACADE,
  storeyCount,
  type Facade,
} from './facade-layout';
import {
  buildingLift,
  INTERIOR,
  placeCore,
  ROOM_WALLS,
} from './interior-layout';
import type {
  BuildingDef,
  BuildingUse,
  DoorDef,
  FacadeDef,
  Facing,
  StreetFront,
  V3,
  WindowStyle,
} from './level-data';
import type { LevelWriter } from './level-writer';

/**
 * Building dimensions in meters and feature-selection probabilities.
 * Decorative parts use existing materials and remain shallow to avoid street
 * lamps. Geometry is appended as level boxes for material/chunk batching.
 */
export const BUILDING = {
  /** Homes over shops: storey height, ground floor height. */
  home: { storey: 3.0, ground: 4.2 },
  /** Offices: taller storeys over a lobby. */
  office: { storey: 3.6, ground: 5.0 },
  /**
   * Height thresholds in meters: buildings at or above `tall` use office
   * styling, and those below `low` use low-rise shop styling.
   */
  tall: 26,
  low: 12,
  /** Bay width each window style aims for. */
  bay: { punched: 2.8, ribbon: 3.6, paired: 3.2, grid: 2.4 } as Readonly<
    Record<WindowStyle, number>
  >,
  /** Cornice projection from the wall and vertical thickness, in meters. */
  cornice: { out: 0.35, height: 0.45 },
  /**
   * Ledge projection and thickness in meters. Keep projection below the shop
   * signs' 0.12-meter offset.
   */
  ledge: { out: 0.1, height: 0.2 },
  /**
   * Awning depth, canvas thickness, valance height, bay-edge inset, and
   * distance below the ground-floor top.
   */
  awning: { depth: 0.8, thick: 0.1, valance: 0.4, inset: 0.1, below: 0.85 },
  /**
   * Canopy depth, thickness, extension beyond the door bay, and distance below
   * the ground-floor top.
   */
  canopy: { depth: 0.8, thick: 0.25, run: 0.6, below: 1.2 },
  /**
   * Door-hood depth, thickness, side extension, and clearance above the
   * doorway.
   */
  hood: { depth: 0.6, thick: 0.15, run: 0.3, above: 0.3 },
  /**
   * Doorway stoop dimensions in meters. The rise lies between vehicle and
   * pedestrian step limits so people can enter while cars stop. Extend the
   * stoop through INTERIOR.wall to the interior.
   */
  stoop: { rise: 0.5, out: 0.6, side: 0.15, paint: '#8a8094' },
  /**
   * Balconies: slab depth and thickness, railing height and bar thickness,
   * inset from the bay's edges.
   */
  balcony: { depth: 0.8, slab: 0.16, rail: 1.0, bar: 0.05, inset: 0.15 },
  /**
   * Fire-escape dimensions in meters. Span `bays` at one end of the facade,
   * connect storeys with `steps` alternating treads, and end the drop ladder
   * `ladder` meters above the base.
   */
  escape: {
    depth: 0.8,
    grate: 0.08,
    rail: 0.95,
    bar: 0.05,
    steps: 8,
    tread: 0.05,
    flight: 0.4,
    bays: 2,
    ladder: 2.4,
  },
  /**
   * Tower setback limits: footprint inset as a fraction of the shorter side,
   * minimum inset, height range, and eligibility thresholds for tower height
   * and side length.
   */
  setback: {
    inset: 0.2,
    min: 2.5,
    height: [6, 12] as const,
    tall: 30,
    side: 16,
  },
  /**
   * Street lamps keep this much room round their poles, up to their caps'
   * height above the street.
   */
  lampClear: { r: 0.8, top: 6.7 },
  /**
   * Selection probabilities for shop fronts, balconies, fire escapes, storey
   * ledges, setbacks, and cornices.
   */
  odds: {
    shop: 0.65,
    officeShop: 0.4,
    balconies: 0.4,
    escape: 0.5,
    ledges: 0.3,
    setback: 0.45,
    cornice: 0.85,
  },
};

/**
 * Wall paints by family (brick, stucco, slate, concrete, and the brighter shop
 * fronts), awning canvas, and the trim tones mixed into a wall's paint.
 */
const PAINTS = {
  brick: ['#5c3a4c', '#6a4050', '#503246'],
  stucco: ['#7a6a80', '#86727f', '#6c6278'],
  slate: ['#3c4a5a', '#44505e', '#36404f'],
  concrete: ['#4a4258', '#3c3550', '#5a5368'],
  shop: ['#4f6a5e', '#7a4a68', '#5a5a7e', '#6a5a3e'],
};
const AWNINGS = ['#8a2b6e', '#2b6e5e', '#6e2b8a', '#4a7a1a', '#8a2b3a'];
const TRIM = { light: '#d8d0e0', dark: '#15101e', share: 0.35 };

/**
 * Facade layout and decorative features selected by buildingLook from
 * dimensions and street-facing sides.
 */
export interface BuildingLook {
  /** The walls (kind 'wall'). */
  facade: FacadeDef;
  /** The sides that face a street. */
  streets: readonly Facing[];
  /** Paint for the cornice, ledges and balcony slabs, and for awnings. */
  trim: string;
  awning: string;
  cornice: boolean;
  ledges: 'ground' | 'every' | null;
  balconies: boolean;
  /** The street face a fire escape climbs, if any. */
  escape: Facing | null;
  /** A narrower block standing on the roof: its footprint and height. */
  setback: {
    x0: number;
    z0: number;
    x1: number;
    z1: number;
    height: number;
  } | null;
}

/**
 * One side of a footprint: its wall plane (`at` on x for x sides, z for z
 * sides), which way is out, and its extent along the wall.
 */
interface Side {
  facing: Facing;
  axis: 0 | 2;
  at: number;
  out: 1 | -1;
  a0: number;
  a1: number;
}

function sides(
  x0: number,
  z0: number,
  x1: number,
  z1: number,
): Record<Facing, Side> {
  return {
    'x+': { facing: 'x+', axis: 2, at: x1, out: 1, a0: z0, a1: z1 },
    'x-': { facing: 'x-', axis: 2, at: x0, out: -1, a0: z0, a1: z1 },
    'z+': { facing: 'z+', axis: 0, at: z1, out: 1, a0: x0, a1: x1 },
    'z-': { facing: 'z-', axis: 0, at: z0, out: -1, a0: x0, a1: x1 },
  };
}

/**
 * Bay k of n across side s, left to right seen from outside (the facade
 * shader's order), as a range along the wall.
 */
function bayAt(s: Side, k: number, n: number): [number, number] {
  const w = (s.a1 - s.a0) / n;
  // z+ and x- run left to right with their axis, z- and x+ against it
  return s.facing === 'z+' || s.facing === 'x-'
    ? [s.a0 + k * w, s.a0 + (k + 1) * w]
    : [s.a1 - (k + 1) * w, s.a1 - k * w];
}

/**
 * A box standing off side s: a0..a1 along it, y0..y1, from d0 to d1 out from
 * the wall.
 */
function off(
  s: Side,
  a0: number,
  a1: number,
  y0: number,
  y1: number,
  d0: number,
  d1: number,
): [V3, V3] {
  const c0 = s.at + s.out * d0;
  const c1 = s.at + s.out * d1;
  const lo = Math.min(c0, c1);
  const hi = Math.max(c0, c1);
  return s.axis === 0
    ? [
        [a0, y0, lo],
        [a1, y1, hi],
      ]
    : [
        [lo, y0, a0],
        [hi, y1, a1],
      ];
}

/** Whether a box keeps clear of every street lamp's pole and cap. */
function clearOfLamps(w: LevelWriter, [min, max]: [V3, V3]): boolean {
  const { r, top } = BUILDING.lampClear;
  const a = w.p(min);
  const b = w.p(max);
  return !w.data.lamps.some(
    (l) =>
      l.kind === 'street' &&
      a[1] < l.pos[1] + top &&
      l.pos[0] > a[0] - r &&
      l.pos[0] < b[0] + r &&
      l.pos[2] > a[2] - r &&
      l.pos[2] < b[2] + r,
  );
}

/** Mix two #rrggbb colors. */
function mixHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  let out = 0;
  for (const shift of [16, 8, 0]) {
    const ca = (pa >> shift) & 255;
    const cb = (pb >> shift) & 255;
    out |= Math.round(ca + (cb - ca) * t) << shift;
  }

  return `#${out.toString(16).padStart(6, '0')}`;
}

/**
 * A seed from a footprint, so a building's look doesn't depend on (or disturb)
 * the city generator's random stream.
 */
function seedOf(x0: number, z0: number, x1: number, z1: number): number {
  let h = 2166136261;
  for (const v of [x0, z0, x1, z1]) {
    h = Math.imul(h ^ Math.round(v * 100), 16777619);
  }

  return h >>> 0;
}

/**
 * Choose a deterministic facade and decorative features from footprint,
 * height, and street-facing sides. The footprint-derived seed does not consume
 * the city generator's random stream.
 */
export function buildingLook(
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  height: number,
  streets: readonly Facing[],
): BuildingLook {
  const B = BUILDING;
  const rng = new Rng(seedOf(x0, z0, x1, z1));
  const office = height >= B.tall;
  const low = height < B.low;
  const windows: WindowStyle = office
    ? rng.pick(['ribbon', 'grid', 'grid', 'paired', 'punched'] as const)
    : rng.pick(['punched', 'punched', 'paired', 'ribbon'] as const);
  const family = rng.pick(
    office
      ? (['slate', 'concrete', 'stucco'] as const)
      : low
        ? (['shop', 'shop', 'brick', 'stucco'] as const)
        : (['brick', 'brick', 'stucco', 'concrete', 'shop'] as const),
  );
  const paint = rng.pick(PAINTS[family]);
  const use = office ? B.office : B.home;
  // Reserve the longest street-facing side for the office lobby.
  const all = sides(x0, z0, x1, z1);
  const front = [...streets].sort(
    (a, b) => all[b].a1 - all[b].a0 - (all[a].a1 - all[a].a0),
  )[0];
  const street: Partial<Record<Facing, StreetFront>> = {};
  for (const f of streets) {
    if (office && f === front) {
      street[f] = 'lobby';
    } else if (low || rng.chance(office ? B.odds.officeShop : B.odds.shop)) {
      street[f] = 'shop';
    }
  }

  // Provide an entry front when no storefront was selected.
  if (front && !Object.keys(street).length) {
    street[front] = 'entry';
  }

  const facade: FacadeDef = {
    kind: 'wall',
    paint,
    storey: use.storey,
    ground: use.ground,
    bay: B.bay[windows],
    windows,
    street,
  };
  const storeys = storeyCount({ ...FACADE, ...facade } as Facade, height);
  const homely =
    !office && (windows === 'punched' || windows === 'paired') && storeys >= 2;
  const balconies = homely && rng.chance(B.odds.balconies);
  const escape =
    homely &&
    !balconies &&
    windows === 'punched' &&
    streets.length > 0 &&
    rng.chance(B.odds.escape)
      ? rng.pick(streets)
      : null;
  const ledges =
    !office && windows === 'punched' && rng.chance(B.odds.ledges)
      ? 'every'
      : Object.keys(street).length
        ? 'ground'
        : null;
  const short = Math.min(x1 - x0, z1 - z0);
  let setback: BuildingLook['setback'] = null;
  if (
    office &&
    height >= B.setback.tall &&
    short >= B.setback.side &&
    rng.chance(B.odds.setback)
  ) {
    const i = Math.max(B.setback.min, short * B.setback.inset);
    setback = {
      x0: x0 + i,
      z0: z0 + i,
      x1: x1 - i,
      z1: z1 - i,
      height: rng.range(B.setback.height[0], B.setback.height[1]),
    };
  }

  return {
    facade,
    streets,
    trim: mixHex(
      paint,
      windows === 'grid' ? TRIM.dark : TRIM.light,
      TRIM.share,
    ),
    awning: rng.pick(AWNINGS),
    cornice: rng.chance(B.odds.cornice),
    ledges,
    balconies,
    escape,
    setback,
  };
}

/**
 * Append four non-solid trim boxes outside the footprint from y0 to y1,
 * leaving the interior unobstructed.
 */
function ring(
  w: LevelWriter,
  mat: MatKey,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  y0: number,
  y1: number,
  out: number,
  paint: string,
): void {
  const extra = { solid: false, facade: { kind: 'trim', paint } as FacadeDef };
  w.box([x0 - out, y0, z0 - out], [x1 + out, y1, z0], mat, extra);
  w.box([x0 - out, y0, z1], [x1 + out, y1, z1 + out], mat, extra);
  w.box([x0 - out, y0, z0], [x0, y1, z1], mat, extra);
  w.box([x1, y0, z0], [x1 + out, y1, z1], mat, extra);
}

function band(
  w: LevelWriter,
  mat: MatKey,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  y0: number,
  y1: number,
  out: number,
  paint: string,
  drip = false,
): void {
  w.box([x0 - out, y0, z0 - out], [x1 + out, y1, z1 + out], mat, {
    solid: false,
    facade: { kind: 'trim', paint },
    drip: drip ? 'top' : undefined,
  });
}

/**
 * Append non-solid striped awnings and valances, continuously or per bay. Skip
 * spans that conflict with street lamps.
 */
function awnings(
  w: LevelWriter,
  mat: MatKey,
  s: Side,
  f: Facade,
  paint: string,
  continuous: boolean,
): void {
  const A = BUILDING.awning;
  const n = bayCount(s.a1 - s.a0, f.bay);
  const top = f.ground - A.below;
  const spans: [number, number][] = continuous
    ? [[s.a0, s.a1]]
    : Array.from({ length: n }, (_, k) => bayAt(s, k, n));
  for (const [a0, a1] of spans) {
    const canvas = off(
      s,
      a0 + A.inset,
      a1 - A.inset,
      top - A.thick,
      top,
      0,
      A.depth,
    );
    const valance = off(
      s,
      a0 + A.inset,
      a1 - A.inset,
      top - A.valance,
      top - A.thick,
      A.depth - A.thick,
      A.depth,
    );
    if (!clearOfLamps(w, canvas)) {
      continue;
    }

    const extra = {
      solid: false,
      facade: { kind: 'awning', paint } as FacadeDef,
    };
    w.box(canvas[0], canvas[1], mat, extra);
    w.box(valance[0], valance[1], mat, extra);
  }
}

/**
 * Append a non-solid lobby canopy or entry hood if its bounds clear street
 * lamps.
 */
function canopy(w: LevelWriter, s: Side, f: Facade, front: StreetFront): void {
  const n = bayCount(s.a1 - s.a0, f.bay);
  const [a0, a1] = bayAt(s, doorBay(n), n);
  let box: [V3, V3];
  if (front === 'lobby') {
    const C = BUILDING.canopy;
    const top = f.ground - C.below;
    box = off(
      s,
      Math.max(s.a0, a0 - C.run),
      Math.min(s.a1, a1 + C.run),
      top - C.thick,
      top,
      0,
      C.depth,
    );
  } else {
    const H = BUILDING.hood;
    const mid = (a0 + a1) / 2;
    const half = FACADE.front.door / 2 + H.run;
    const y = FACADE.front.doorTop + H.above;
    box = off(s, mid - half, mid + half, y, y + H.thick, 0, H.depth);
  }

  if (clearOfLamps(w, box)) {
    w.box(box[0], box[1], 'metal', { solid: false });
  }
}

/**
 * Append non-solid balcony slabs and three-sided railings on alternating bays,
 * staggering bay parity by storey. Skip balconies that conflict with street
 * lamps.
 */
function balconies(
  w: LevelWriter,
  mat: MatKey,
  s: Side,
  f: Facade,
  storeys: number,
  paint: string,
  base: number,
): void {
  const B = BUILDING.balcony;
  const n = bayCount(s.a1 - s.a0, f.bay);
  for (let k = 0; k < storeys; k++) {
    const y = base + f.ground + k * f.storey;
    for (let b = k % 2; b < n; b += 2) {
      const [a0, a1] = bayAt(s, b, n);
      const p0 = a0 + B.inset;
      const p1 = a1 - B.inset;
      const slab = off(s, p0, p1, y - B.slab, y, 0, B.depth);
      if (!clearOfLamps(w, slab)) {
        continue;
      }

      w.box(slab[0], slab[1], mat, {
        solid: false,
        facade: { kind: 'trim', paint },
      });

      for (const [q0, q1, d0, d1] of [
        [p0, p1, B.depth - B.bar, B.depth],
        [p0, p0 + B.bar, 0, B.depth - B.bar],
        [p1 - B.bar, p1, 0, B.depth - B.bar],
      ] as const) {
        const r = off(s, q0, q1, y, y + B.rail, d0, d1);
        w.box(r[0], r[1], 'metal', { solid: false });
      }
    }
  }
}

/**
 * Append a non-solid fire escape with alternating flights and a drop ladder.
 * Require at least two storeys, enough bays, and street-lamp clearance.
 */
function fireEscape(
  w: LevelWriter,
  s: Side,
  f: Facade,
  storeys: number,
  base: number,
): void {
  const E = BUILDING.escape;
  const n = bayCount(s.a1 - s.a0, f.bay);
  if (n < E.bays + 1 || storeys < 2) {
    return;
  }

  const first = bayAt(s, 0, n);
  const last = bayAt(s, E.bays - 1, n);
  const a0 = Math.min(first[0], last[0]);
  const a1 = Math.max(first[1], last[1]);
  const y0 = base + f.ground;
  const yTop = y0 + (storeys - 1) * f.storey;
  if (!clearOfLamps(w, off(s, a0, a1, base, yTop + E.rail, 0, E.depth))) {
    return;
  }

  const metal = (b: [V3, V3]): void => {
    w.box(b[0], b[1], 'metal', { solid: false });
  };

  const run = (a1 - a0) * 0.7;
  for (let k = 0; k < storeys; k++) {
    const y = y0 + k * f.storey;
    // the landing and its rail: a top bar along the front, posts at the ends and the middle
    metal(off(s, a0, a1, y - E.grate, y, 0, E.depth));
    metal(
      off(s, a0, a1, y + E.rail - E.bar, y + E.rail, E.depth - E.bar, E.depth),
    );

    for (const p of [a0, (a0 + a1) / 2 - E.bar / 2, a1 - E.bar]) {
      metal(
        off(s, p, p + E.bar, y, y + E.rail - E.bar, E.depth - E.bar, E.depth),
      );
    }

    if (k === storeys - 1) {
      continue;
    }

    // treads up to the next landing, along the wall's side of the landing, alternating direction
    const rise = f.storey / (E.steps + 1);
    const step = run / E.steps;
    const leftward = k % 2 === 1;
    for (let i = 1; i <= E.steps; i++) {
      const t0 = leftward ? a1 - i * step : a0 + (i - 1) * step;
      const ty = y + i * rise;
      metal(off(s, t0, t0 + step, ty - E.tread, ty, E.bar, E.bar + E.flight));
    }
  }

  // the drop ladder under the first landing: two rails
  const l0 = (a0 + a1) / 2 + run / 2;
  for (const p of [l0 - 0.25, l0 + 0.2]) {
    metal(
      off(
        s,
        p,
        p + E.bar,
        base + E.ladder,
        y0 - E.grate,
        E.depth - 0.3,
        E.depth - 0.3 + E.bar,
      ),
    );
  }
}

/**
 * Append decorative features for an existing facade: ledges, storefront
 * coverings, balconies or a fire escape, cornice, and optional rooftop
 * setback. A requested slime lip is assigned to the cornice.
 */
export function dressBuilding(
  w: LevelWriter,
  mat: MatKey,
  look: BuildingLook,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  base: number,
  top: number,
  drip: boolean,
): void {
  const B = BUILDING;
  const f = { ...FACADE, ...look.facade } as Facade;
  const all = sides(x0, z0, x1, z1);
  const storeys = storeyCount(f, top - base);
  // ledges: over the ground floor, and on some homes at every storey line
  if (look.ledges) {
    const lines = look.ledges === 'every' ? storeys : 1;
    for (let k = 0; k < lines; k++) {
      const y = base + f.ground + k * f.storey;
      ring(
        w,
        mat,
        x0,
        z0,
        x1,
        z1,
        y,
        y + B.ledge.height,
        B.ledge.out,
        look.trim,
      );
    }
  }

  const continuous = (seedOf(x1, z1, x0, z0) & 1) === 0;
  for (const [facing, front] of Object.entries(f.street ?? {}) as [
    Facing,
    StreetFront,
  ][]) {
    if (front === 'shop') {
      awnings(w, mat, all[facing], f, look.awning, continuous);
    } else {
      canopy(w, all[facing], f, front);
    }
  }

  if (look.balconies) {
    for (const facing of look.streets) {
      balconies(w, mat, all[facing], f, storeys, look.trim, base);
    }
  }

  if (look.escape) {
    fireEscape(w, all[look.escape], f, storeys, base);
  }

  if (look.cornice) {
    band(
      w,
      mat,
      x0,
      z0,
      x1,
      z1,
      top - B.cornice.height,
      top,
      B.cornice.out,
      look.trim,
      drip,
    );
  }

  const sb = look.setback;
  if (sb) {
    const sbTop = top + sb.height;
    w.box([sb.x0, top, sb.z0], [sb.x1, sbTop, sb.z1], mat, {
      top: 'roof',
      facade: { ...look.facade, ground: 0, street: {} },
    });
    band(
      w,
      mat,
      sb.x0,
      sb.z0,
      sb.x1,
      sb.z1,
      sbTop - B.cornice.height,
      sbTop,
      B.cornice.out,
      look.trim,
    );
  }
}

/**
 * Return the roof height beneath an sx-by-sz footprint centred at (cx, cz).
 * Use the setback roof only when fully contained; return null for overlap with
 * its walls or cornice clearance.
 */
export function roofAt(
  look: BuildingLook,
  cx: number,
  cz: number,
  sx: number,
  sz: number,
  top: number,
): number | null {
  const sb = look.setback;
  if (!sb) {
    return top;
  }

  const [a0, a1, b0, b1] = [
    cx - sx / 2,
    cx + sx / 2,
    cz - sz / 2,
    cz + sz / 2,
  ];
  const pad = BUILDING.cornice.out;
  if (
    a1 < sb.x0 - pad ||
    a0 > sb.x1 + pad ||
    b1 < sb.z0 - pad ||
    b0 > sb.z1 + pad
  ) {
    return top;
  }

  if (a0 >= sb.x0 && a1 <= sb.x1 && b0 >= sb.z0 && b1 <= sb.z1) {
    return top + sb.height;
  }

  return null;
}

/**
 * Derive a walk-in definition with facade-aligned doors, interior use, core,
 * paint, and deterministic seed. Prioritize a lobby doorway, otherwise the
 * longest street front. Return null without a street front.
 */
export function walkInDef(
  look: BuildingLook,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  base: number,
  top: number,
): BuildingDef | null {
  const f = { ...FACADE, ...look.facade } as Facade;
  const all = sides(x0, z0, x1, z1);
  const fronts = Object.entries(f.street ?? {}) as [Facing, StreetFront][];
  // Order doors so interior layout uses the lobby or longest front as its main entrance.
  fronts.sort(
    ([fa, a], [fb, b]) =>
      Number(b === 'lobby') - Number(a === 'lobby') ||
      all[fb].a1 - all[fb].a0 - (all[fa].a1 - all[fa].a0),
  );
  const doors: DoorDef[] = fronts.map(([facing, front]) => {
    const s = all[facing];
    const n = bayCount(s.a1 - s.a0, f.bay);
    const [a0, a1] = bayAt(s, doorBay(n), n);
    return {
      facing,
      at: (a0 + a1) / 2,
      width: doorWidth(front),
      height: FACADE.front.doorTop - FACADE.front.floor,
    };
  });
  const main = fronts[0];
  if (!main) {
    return null;
  }

  const seed = seedOf(z0, x0, z1, x1);
  const rng = new Rng(seed);
  const kinds = new Set(fronts.map(([, k]) => k));
  let use: BuildingUse = kinds.has('lobby')
    ? 'lobby'
    : kinds.has('shop')
      ? 'shop'
      : 'hall';
  if (use === 'shop' && rng.chance(INTERIOR.diner)) {
    use = 'diner';
  }

  const min: V3 = [x0, base, z0];
  const max: V3 = [x1, top, z1];
  const storeys = storeyCount(f, top - base);
  return {
    min,
    max,
    facade: look.facade,
    storeys,
    use,
    doors,
    core: placeCore(use, min, max, doors, storeys),
    paint: rng.pick(ROOM_WALLS),
    seed,
  };
}

/**
 * Append a walk-in definition, optional elevator, and doorway stoops. Return
 * false without a street front. When true, the caller must disable facade-box
 * collision because the generated interior supplies collision.
 */
export function walkIn(
  w: LevelWriter,
  mat: MatKey,
  look: BuildingLook,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  base: number,
  top: number,
): boolean {
  const def = walkInDef(look, x0, z0, x1, z1, base, top);
  if (!def) {
    return false;
  }

  const placed = w.building(def);
  // Register the elevator using the translated building definition; its shaft geometry comes from the interior.
  const lift = buildingLift(placed);
  if (lift) {
    w.data.elevators.push(lift);
  }

  const S = BUILDING.stoop;
  const all = sides(x0, z0, x1, z1);
  for (const d of def.doors) {
    const b = off(
      all[d.facing],
      d.at - d.width / 2 - S.side,
      d.at + d.width / 2 + S.side,
      base,
      base + FACADE.front.floor + S.rise,
      -INTERIOR.wall,
      S.out,
    );
    w.box(b[0], b[1], mat, { facade: { kind: 'trim', paint: S.paint } });
  }

  return true;
}
