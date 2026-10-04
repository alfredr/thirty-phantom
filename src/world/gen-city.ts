import { mod } from '../engine/core/math';
import { Rng } from '../engine/core/rng';
import { subtractRects } from '../render/geometry';
import type { MatKey } from '../render/materials';
import { buildingLook, dressBuilding, roofAt, walkIn } from './gen-building';
import { elevatorShaft, stairShaft } from './gen-deck';
import type { Facing, V3 } from './level-data';
import type { LevelWriter } from './level-writer';

/** City grid: road centerlines every PITCH units, 3x3 blocks. */
export const CITY = {
  pitch: 60,
  road: 12,
  blocks: 3,
  sidewalk: 0.2,
  /** The graveyard's ground: a step up from the road. */
  graveyard: 0.25,
};

export type BlockKind = 'deck' | 'graveyard' | 'plaza' | 'shops' | 'towers' | 'midrise' | 'lot' | 'hotel';

export const BLOCK_LAYOUT: BlockKind[][] = [
  // [bx][bz]
  ['towers', 'towers', 'lot'],
  ['towers', 'deck', 'shops'],
  ['hotel', 'plaza', 'graveyard'],
];

export function blockRect(bx: number, bz: number): [number, number, number, number] {
  const { pitch, road } = CITY;
  return [bx * pitch + road / 2, bz * pitch + road / 2, (bx + 1) * pitch - road / 2, (bz + 1) * pitch - road / 2];
}

const FACADES: MatKey[] = ['facadeA', 'facadeB', 'facadeC'];
const NEON = ['neon', 'neonPurple'] as const;
const SHOP_SIGNS = [['OPEN', 'LATE'], ['GHOUL', 'GAS'], ['ROADIE'], ['BONE', 'DRY'], ['SLIME', 'DONUTS'], ['24 HRS']];

/**
 * The Foxy: lobby podium and tower with orange neon, and a canopied drop-off
 * lane off the front street (facing the camera) where the valet takes cars.
 */
function foxyHotel(w: LevelWriter, x0: number, z0: number, x1: number, z1: number): void {
  const SW = CITY.sidewalk;
  const cx = (x0 + x1) / 2;
  const front = z1 - 18;
  // lobby podium, tower
  w.box([x0 + 6, 0, z0 + 4], [x1 - 6, SW + 7, front], 'stone', { top: 'roof', tint: 0.95 });
  w.box([x0 + 10, SW + 7, z0 + 6], [x1 - 10, SW + 34, front - 4], 'facadeB', {
    top: 'roof',
    drip: 'top',
    facade: { kind: 'wall', windows: 'paired', storey: 3.2, ground: 0, bay: 3.2, paint: '#4a3a60' },
  });
  w.sign([cx, SW + 29.5, front - 3.88], [17, 5.2], 'z+', 'foxy', ['FOXY']);
  w.sign([cx, SW + 25.6, front - 3.88], [9, 1.7], 'z+', 'neonPurple', ['HOTEL']);
  w.sign([x1 - 9.88, SW + 19, front - 6], [3, 13], 'x+', 'foxy', ['F', 'O', 'X', 'Y']);
  // lobby front: glass, warm doors, a curb to step out onto
  w.box([cx - 12, SW, front], [cx + 12, SW + 4.2, front + 0.1], 'glass', { solid: false });
  w.box([cx - 2.5, SW + 0.15, front + 0.1], [cx + 2.5, SW + 3.2, front + 0.16], 'lampWarm', { solid: false });
  w.sign([cx, SW + 6.3, front + 0.04], [14, 1.6], 'z+', 'foxy', ['FOXY HOTEL']);
  w.box([x0 + 8, SW, front], [x1 - 8, SW + 0.15, front + 2.5], 'concreteLight');
  // drop-off lane with a driveway to the street at each end
  w.box([x0 + 8, SW, front + 2.5], [x1 - 8, SW + 0.02, front + 10], 'asphalt');
  w.box([x0 + 8, SW, front + 10], [x0 + 16, SW + 0.02, z1], 'asphalt');
  w.box([x1 - 16, SW, front + 10], [x1 - 8, SW + 0.02, z1], 'asphalt');
  // raised planter between the driveways, taller than a car can climb
  w.box([x0 + 16, SW, front + 10.5], [x1 - 16, SW + 0.8, z1 - 1.5], 'stone', { top: 'grass' });
  // shallow cantilevered awning over the curb: deep enough to read as a porte-cochere,
  // shallow enough that the iso camera still sees the valet under it
  w.box([cx - 14, SW + 4.6, front], [cx + 14, SW + 5.2, front + 4], 'metal', { drip: 'bottom' });
  w.sign([cx, SW + 4.9, front + 4.04], [12, 0.55], 'z+', 'neonPurple', ['VALET PARKING']);
  for (const x of [cx - 7, cx + 7]) {
    w.box([x - 1.5, SW + 4.45, front + 1.7], [x + 1.5, SW + 4.6, front + 2.3], 'lampWarm', { solid: false });
    w.lamp([x, SW + 4.6, front + 2], 'warm', 'ceiling');
  }
  // the valet's podium on the curb
  w.block(cx + 6, SW + 0.15, front + 1.6, 0.9, 1.1, 0.6, 'wood');
  w.block(cx + 6, SW + 1.25, front + 1.6, 1.1, 0.08, 0.75, 'metalLight', { solid: false });
  w.sign([cx + 6, SW + 0.85, front + 1.92], [0.8, 0.42], 'z+', 'foxy', ['VALET']);
  w.data.valets.push({ pos: [cx + 4.6, SW + 0.15, front + 1.7], yaw: 0, crew: 2 });
}

/**
 * The sides of a footprint that face a road: a road's centreline within this
 * of the wall (a lot's 2 to 2.5 m setback, the sidewalk and half the road).
 */
const STREET_REACH = 10;

function streetSides(x0: number, z0: number, x1: number, z1: number): Facing[] {
  const { pitch, blocks, road: width } = CITY;
  const span = blocks * pitch;
  const road = (c: number, dir: 1 | -1): boolean => {
    const r = (dir > 0 ? Math.ceil(c / pitch) : Math.floor(c / pitch)) * pitch;
    return Math.abs(r - c) < STREET_REACH && r >= 0 && r <= span;
  };
  // and the road runs along at least half the wall (roads stop at the city's edge)
  const along = (a0: number, a1: number): boolean => Math.min(a1, span + width / 2) - Math.max(a0, -width / 2) > (a1 - a0) / 2;
  const out: Facing[] = [];
  if (road(x1, 1) && along(z0, z1)) out.push('x+');
  if (road(x0, -1) && along(z0, z1)) out.push('x-');
  if (road(z1, 1) && along(x0, x1)) out.push('z+');
  if (road(z0, -1) && along(x0, x1)) out.push('z-');
  return out;
}

function building(w: LevelWriter, rng: Rng, x0: number, z0: number, x1: number, z1: number, h: number): void {
  const base = CITY.sidewalk;
  const mat = rng.pick(FACADES);
  const drip = rng.chance(0.35);
  const tint = rng.range(0.85, 1.1);
  const parapet = rng.chance(0.7);
  const top = base + h;
  // walls laid out by storey and bay, then ledges, shop fronts, balconies, a cornice and maybe a setback (gen-building.ts);
  // the cornice carries the slime, unless a parapet would cover its edge (as it covers a bare wall's)
  const look = buildingLook(x0, z0, x1, z1, top, streetSides(x0, z0, x1, z1));
  // a building with a street front is walk-in: its shell and rooms collide (world/interior-layout.ts), not the facade box
  const walk = walkIn(w, mat, look, x0, z0, x1, z1, 0, top);
  w.box([x0, 0, z0], [x1, top, z1], mat, { top: 'roof', solid: walk ? false : undefined, drip: drip && !look.cornice ? 'top' : undefined, tint, facade: look.facade });
  dressBuilding(w, mat, look, x0, z0, x1, z1, 0, top, drip && !parapet);
  // roof parapet ring
  if (parapet) w.frame(x0, z0, x1, z1, 0.35, top, top + 0.7, 'concreteDark', { solid: false });
  // rooftop clutter (on a setback's roof when wholly on it, and never across its wall)
  const n = rng.int(1, 4);
  for (let i = 0; i < n; i++) {
    const sx = rng.range(1.2, 3);
    const sz = rng.range(1.2, 3);
    const cx = rng.range(x0 + 1 + sx / 2, x1 - 1 - sx / 2);
    const cz = rng.range(z0 + 1 + sz / 2, z1 - 1 - sz / 2);
    const sy = rng.range(0.8, 2);
    const kind = rng.chance(0.5) ? 'metal' : 'metalLight';
    const y = roofAt(look, cx, cz, sx, sz, top);
    if (y !== null) w.block(cx, y, cz, sx, sy, sz, kind, { solid: false });
  }
  if (rng.chance(0.35)) {
    // water tower
    const cx = rng.range(x0 + 3, x1 - 3);
    const cz = rng.range(z0 + 3, z1 - 3);
    const y = roofAt(look, cx, cz, 3, 3, top);
    if (y !== null) {
      for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
        w.block(cx + dx * 1.1, y, cz + dz * 1.1, 0.2, 2.4, 0.2, 'metal', { solid: false });
      }
      w.block(cx, y + 2.4, cz, 3, 2.6, 3, 'wood', { solid: false });
      w.block(cx, y + 5, cz, 2.2, 0.6, 2.2, 'wood', { solid: false });
      w.block(cx, y + 5.6, cz, 1, 0.5, 1, 'wood', { solid: false });
    }
  }
  if (rng.chance(0.3)) {
    const cx = rng.range(x0 + 1, x1 - 1);
    const cz = rng.range(z0 + 1, z1 - 1);
    const ah = rng.range(4, 9);
    const y = roofAt(look, cx, cz, 0.18, 0.18, top);
    if (y !== null) w.block(cx, y, cz, 0.18, ah, 0.18, 'metal', { solid: false });
  }
  // the odd rooftop neon
  if (rng.chance(0.3) && x1 - x0 > 8) {
    const facing: Facing = rng.chance(0.5) ? 'z+' : 'x+';
    const lines = rng.pick(SHOP_SIGNS);
    if (facing === 'z+') {
      w.box([(x0 + x1) / 2 - 3.5, top, z1 - 1.2], [(x0 + x1) / 2 + 3.5, top + 2.4, z1 - 1], 'metal', { solid: false });
      w.sign([(x0 + x1) / 2, top + 1.2, z1 - 0.97], [7, 2.4], 'z+', rng.pick(NEON), lines);
    } else {
      w.box([x1 - 1.2, top, (z0 + z1) / 2 - 3.5], [x1 - 1, top + 2.4, (z0 + z1) / 2 + 3.5], 'metal', { solid: false });
      w.sign([x1 - 0.97, top + 1.2, (z0 + z1) / 2], [7, 2.4], 'x+', rng.pick(NEON), lines);
    }
  }
}

function lots(rng: Rng, x0: number, z0: number, x1: number, z1: number): [number, number, number, number][] {
  const r = rng.next();
  const g = 2;
  if (r < 0.2) return [[x0, z0, x1, z1]];
  if (r < 0.55) {
    if (rng.chance(0.5)) {
      const m = rng.range(x0 + 14, x1 - 14);
      return [
        [x0, z0, m - g / 2, z1],
        [m + g / 2, z0, x1, z1],
      ];
    }
    const m = rng.range(z0 + 14, z1 - 14);
    return [
      [x0, z0, x1, m - g / 2],
      [x0, m + g / 2, x1, z1],
    ];
  }
  const mx = rng.range(x0 + 16, x1 - 16);
  const mz = rng.range(z0 + 16, z1 - 16);
  return [
    [x0, z0, mx - g / 2, mz - g / 2],
    [mx + g / 2, z0, x1, mz - g / 2],
    [x0, mz + g / 2, mx - g / 2, z1],
    [mx + g / 2, mz + g / 2, x1, z1],
  ];
}

function deadTree(w: LevelWriter, rng: Rng, x: number, y: number, z: number): void {
  const h = rng.range(5, 7.5);
  w.block(x, y, z, 0.7, h, 0.7, 'wood');
  const dirs: [number, number][] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  const nb = rng.int(3, 5);
  for (let i = 0; i < nb; i++) {
    const [dx, dz] = rng.pick(dirs);
    const by = y + rng.range(h * 0.45, h * 0.9);
    const len = rng.range(1.2, 2.6);
    const th = rng.range(0.25, 0.4);
    const cx = x + dx * (0.35 + len / 2);
    const cz = z + dz * (0.35 + len / 2);
    w.block(cx, by, cz, dx ? len : th, th, dz ? len : th, 'wood', { solid: false });
    const ex = x + dx * (0.35 + len);
    const ez = z + dz * (0.35 + len);
    w.block(ex - dx * th * 0.5, by, ez - dz * th * 0.5, th, rng.range(0.6, 1.6), th, 'wood', { solid: false });
  }
}

function roundedLoop(x0: number, z0: number, x1: number, z1: number, r: number, reverse: boolean): V3[] {
  const pts: V3[] = [];
  const arcs: [number, number, number][] = [
    [x1 - r, z0 + r, -Math.PI / 2],
    [x1 - r, z1 - r, 0],
    [x0 + r, z1 - r, Math.PI / 2],
    [x0 + r, z0 + r, Math.PI],
  ];
  for (const [cx, cz, a0] of arcs) {
    for (let i = 0; i <= 4; i++) {
      const a = a0 + (i / 4) * (Math.PI / 2);
      pts.push([cx + Math.cos(a) * r, 0, cz + Math.sin(a) * r]);
    }
  }
  return reverse ? pts.reverse() : pts;
}

export function generateCity(w: LevelWriter, seed: number): void {
  const rng = new Rng(seed);
  const { pitch, blocks, sidewalk: SW } = CITY;
  const span = pitch * blocks;

  // ground
  w.box([-90, -1, -90], [span + 90, 0, span + 90], 'asphalt', { solid: false });

  // road center dashes
  for (let i = 0; i <= blocks; i++) {
    const c = i * pitch;
    for (let t = -6; t < span + 6; t += 4) {
      const m = mod(t, pitch);
      if (m < 7 || m > pitch - 9) continue;
      w.box([c - 0.1, 0, t], [c + 0.1, 0.02, t + 2], 'marking', { solid: false });
      w.box([t, 0, c - 0.1], [t + 2, 0.02, c + 0.1], 'marking', { solid: false });
    }
  }

  // outer ring: tall behind (low x/z), low in front so it never hides the action
  const ring = (x0: number, z0: number, x1: number, z1: number, tall: boolean): void => {
    w.box([x0, 0, z0], [x1, SW, z1], 'sidewalk');
    const alongX = x1 - x0 > z1 - z0;
    let t = alongX ? x0 : z0;
    const end = alongX ? x1 : z1;
    while (t < end - 4) {
      const len = Math.min(end - t, rng.range(12, 24));
      const h = tall ? rng.range(18, 46) : rng.range(4, 9);
      const inset = 2;
      if (alongX) building(w, rng, t, z0 + inset, t + len - 1.5, z1 - inset, h);
      else building(w, rng, x0 + inset, t, x1 - inset, t + len - 1.5, h);
      t += len;
    }
  };
  ring(-40, -40, span + 40, -6, true);
  ring(-40, -6, -6, span + 6, true);
  ring(span + 6, -6, span + 40, span + 6, false);
  ring(-40, span + 6, span + 40, span + 40, false);

  for (let bx = 0; bx < blocks; bx++) {
    for (let bz = 0; bz < blocks; bz++) {
      const kind = BLOCK_LAYOUT[bx]?.[bz] ?? 'towers';
      const [x0, z0, x1, z1] = blockRect(bx, bz);
      if (kind === 'deck') {
        // the deck stands behind this 6 m sidewalk (generate-level puts it at z0 + 6); its stair and elevator shafts go down through it
        const holes = [stairShaft([x0, 0, z0 + 6]), elevatorShaft([x0, 0, z0 + 6])].map(([u0, v0, u1, v1]) => ({ u0, u1, v0, v1 }));
        for (const r of subtractRects({ u0: x0, u1: x1, v0: z0, v1: z0 + 6 }, holes)) {
          w.box([r.u0, 0, r.v0], [r.u1, SW, r.v1], 'sidewalk');
        }
        w.box([x0, 0, z1 - 6], [x1, SW, z1], 'sidewalk');
      } else if (kind === 'graveyard') {
        w.box([x0, 0, z0], [x1, CITY.graveyard, z1], 'grass');
      } else {
        w.box([x0, 0, z0], [x1, SW, z1], 'sidewalk');
      }

      // street lamps on block corners and midpoints
      const lampPts: [number, number][] = [
        [x0 + 1, z0 + 1],
        [x1 - 1, z0 + 1],
        [x0 + 1, z1 - 1],
        [x1 - 1, z1 - 1],
        [(x0 + x1) / 2, z0 + 1],
        [(x0 + x1) / 2, z1 - 1],
        [x0 + 1, (z0 + z1) / 2],
        [x1 - 1, (z0 + z1) / 2],
      ];
      lampPts.forEach(([lx, lz], i) => {
        if (kind === 'deck' && i >= 6) return;
        w.lamp([lx, kind === 'graveyard' ? CITY.graveyard : SW, lz], (bx + bz + i) % 2 ? 'purple' : 'green', 'street');
      });

      // traffic loop hugging this block (inner lane of each road)
      w.data.paths.push({ points: roundedLoop(x0 - 3, z0 - 3, x1 + 3, z1 + 3, 4.5, false) });

      const ix0 = x0 + 2;
      const iz0 = z0 + 2;
      const ix1 = x1 - 2;
      const iz1 = z1 - 2;
      switch (kind) {
        case 'towers':
          for (const [a, b, c, d] of lots(rng, ix0, iz0, ix1, iz1)) building(w, rng, a + 0.5, b + 0.5, c - 0.5, d - 0.5, rng.range(24, 50));
          break;
        case 'midrise':
          for (const [a, b, c, d] of lots(rng, ix0, iz0, ix1, iz1)) building(w, rng, a + 0.5, b + 0.5, c - 0.5, d - 0.5, rng.range(12, 24));
          break;
        case 'hotel':
          foxyHotel(w, x0, z0, x1, z1);
          break;
        case 'lot': {
          building(w, rng, ix0, iz0, ix1 - 22, iz1, rng.range(14, 22));
          building(w, rng, ix1 - 20, iz0, ix1, iz0 + 18, rng.range(10, 16));
          w.box([ix1 - 20, SW, iz0 + 20], [ix1, SW + 0.02, iz1], 'asphalt');
          for (let i = 0; i < 3; i++) {
            const cz = iz0 + 24 + i * 6.2;
            w.box([ix1 - 19, SW + 0.02, cz - 3.1], [ix1 - 1, SW + 0.04, cz - 2.95], 'marking', { solid: false });
            w.bay([ix1 - 7, SW + 0.02, cz], Math.PI / 2);
            if (rng.chance(0.8)) w.parked([ix1 - 7, SW + 0.02, cz], Math.PI / 2);
          }
          break;
        }
        case 'shops': {
          // shops along the south edge, fronts facing +z (the camera)
          let x = ix0;
          while (x < ix1 - 8) {
            const wdt = Math.min(ix1 - x, rng.range(9, 14));
            const h = rng.range(6, 10);
            const z0s = iz1 - 14;
            // its street front (shop windows, a door, an awning) comes with the building
            building(w, rng, x, z0s, x + wdt - 1, iz1, h);
            w.sign([x + (wdt - 1) / 2, SW + h - 1.6, iz1 + 0.12], [Math.min(7, wdt - 2), 1.8], 'z+', rng.pick(NEON), rng.pick(SHOP_SIGNS));
            x += wdt;
          }
          // slime fountain
          const fx = (ix0 + ix1) / 2 - 8;
          const fz = iz0 + 12;
          w.frame(fx - 5, fz - 5, fx + 5, fz + 5, 0.6, SW, SW + 0.7, 'stone');
          w.box([fx - 4.4, SW, fz - 4.4], [fx + 4.4, SW + 0.45, fz + 4.4], 'slimePool', { solid: false });
          w.block(fx, SW, fz, 1.2, 3.2, 1.2, 'stone', { drip: 'top' });
          w.block(fx, SW + 3.2, fz, 2.4, 0.4, 2.4, 'stone', { drip: 'bottom' });
          w.block(fx, SW + 3.6, fz, 0.7, 0.9, 0.7, 'slime', { solid: false });
          // kicker toward the deck
          w.ramp([ix1 - 14, SW, iz0 + 4], [ix1 - 8, SW + 1.6, iz0 + 12], 'z', -1, SW, 'concrete', true);
          break;
        }
        case 'plaza': {
          w.box([x0 + 3, SW, z0 + 4], [x1 - 3, SW + 0.02, z0 + 30], 'asphalt');
          for (let i = 0; i <= 6; i++) {
            const lx = x0 + 6 + i * 6;
            w.box([lx - 0.07, SW + 0.02, z0 + 6], [lx + 0.07, SW + 0.04, z0 + 12], 'marking', { solid: false });
            w.box([lx - 0.07, SW + 0.02, z0 + 22], [lx + 0.07, SW + 0.04, z0 + 28], 'marking', { solid: false });
          }
          for (let i = 0; i < 6; i++) {
            const cx = x0 + 9 + i * 6;
            w.bay([cx, SW + 0.02, z0 + 9], 0);
            w.bay([cx, SW + 0.02, z0 + 25], Math.PI);
            if (rng.chance(0.75)) w.parked([cx, SW + 0.02, z0 + 9], 0);
            if (rng.chance(0.6)) w.parked([cx, SW + 0.02, z0 + 25], Math.PI);
          }
          // billboard
          const bxm = (x0 + x1) / 2;
          const bzm = z1 - 8;
          w.box([bxm - 6.4, SW, bzm - 0.3], [bxm - 5.6, SW + 6, bzm + 0.3], 'metal');
          w.box([bxm + 5.6, SW, bzm - 0.3], [bxm + 6.4, SW + 6, bzm + 0.3], 'metal');
          w.box([bxm - 9.4, SW + 5.8, bzm - 0.4], [bxm + 9.4, SW + 13, bzm], 'metal', { solid: false, drip: 'top' });
          w.sign([bxm, SW + 9.4, bzm + 0.03], [18.4, 7], 'z+', 'billboard', ['30', 'PHANTOM CODYS', 'LIFE IS BETTER OFF ROADIE']);
          w.ramp([x1 - 14, SW, z0 + 34], [x1 - 6, SW + 1.8, z0 + 40], 'x', 1, SW, 'concrete', true);
          w.data.playerSpawn = [x0 + 12, SW, z0 + 17];
          break;
        }
        case 'graveyard': {
          const G = CITY.graveyard;
          // iron fence (panels cars knock over), gaps on north and west sides
          const fence = (ax: number, az: number, bxp: number, bzp: number): void => {
            w.data.fences.push({ min: w.p([ax, G, az]), max: w.p([bxp, G + 2, bzp]) });
          };
          const midx = (x0 + x1) / 2;
          const midz = (z0 + z1) / 2;
          fence(x0 + 1, z0 + 1, midx - 4, z0 + 1.2);
          fence(midx + 4, z0 + 1, x1 - 1, z0 + 1.2);
          fence(x0 + 1, z1 - 1.2, x1 - 1, z1 - 1);
          fence(x0 + 1, z0 + 1, x0 + 1.2, midz - 4);
          fence(x0 + 1, midz + 4, x0 + 1.2, z1 - 1);
          fence(x1 - 1.2, z0 + 1, x1 - 1, z1 - 1);
          // mausoleum
          const mx0 = midx - 5;
          const mz0 = midz - 2;
          w.box([mx0 - 0.5, G, mz0 - 0.5], [mx0 + 10.5, G + 0.4, mz0 + 8.5], 'stone');
          w.box([mx0, G + 0.4, mz0], [mx0 + 10, G + 6.4, mz0 + 7], 'stone', { drip: 'top' });
          w.box([mx0 - 0.6, G + 6.4, mz0 - 0.6], [mx0 + 10.6, G + 7, mz0 + 7.6], 'stone', { drip: 'bottom' });
          w.box([mx0 + 1.5, G + 7, mz0 + 0.5], [mx0 + 8.5, G + 7.8, mz0 + 6.5], 'stone');
          w.box([mx0 + 3.7, G + 0.4, mz0 + 7], [mx0 + 6.3, G + 3.8, mz0 + 7.08], 'doorGlow', { solid: false });
          for (const cx of [mx0 + 2.6, mx0 + 7.4]) w.box([cx - 0.4, G + 0.4, mz0 + 7], [cx + 0.4, G + 6.4, mz0 + 7.8], 'stone');
          w.sign([midx, G + 5, mz0 + 7.1], [4.6, 1.3], 'z+', 'neonPurple', ['HERE LIES', 'THE BADGE LOG']);
          // tombstones
          for (let gx = 0; gx < 7; gx++) {
            for (let gz = 0; gz < 6; gz++) {
              const tx = x0 + 6 + gx * 5.8 + rng.range(-0.8, 0.8);
              const tz = z0 + 6 + gz * 6.6 + rng.range(-0.8, 0.8);
              if (tx > mx0 - 3 && tx < mx0 + 13 && tz > mz0 - 3 && tz < mz0 + 11) continue;
              if (rng.chance(0.15)) continue;
              const style = rng.int(0, 3);
              if (style === 0) {
                w.block(tx, G, tz, 1, 1.3, 0.3, 'stone');
                w.block(tx, G + 1.3, tz, 0.7, 0.2, 0.3, 'stone', { solid: false });
              } else if (style === 1) {
                w.block(tx, G, tz, 0.28, 1.8, 0.28, 'stone');
                w.block(tx, G + 1.15, tz, 1, 0.28, 0.28, 'stone', { solid: false });
              } else if (style === 2) {
                w.block(tx, G, tz, 0.9, 0.3, 0.9, 'stone');
                w.block(tx, G + 0.3, tz, 0.5, 2.2, 0.5, 'stone');
                w.block(tx, G + 2.5, tz, 0.3, 0.4, 0.3, 'stone', { solid: false });
              } else {
                w.block(tx, G, tz, 1.4, 0.5, 2.2, 'stone');
                w.block(tx, G + 0.5, tz - 0.9, 1, 1, 0.3, 'stone');
              }
              if (rng.chance(0.25)) w.puddle([tx + rng.range(-1, 1), G + 0.02, tz + 1.2], rng.range(0.5, 1));
            }
          }
          for (let i = 0; i < 5; i++) deadTree(w, rng, rng.range(x0 + 5, x1 - 5), G, rng.range(z0 + 5, z1 - 5));
          // slime pond
          const px = x1 - 12;
          const pz = z1 - 10;
          w.frame(px - 6, pz - 4.5, px + 6, pz + 4.5, 0.5, G, G + 0.4, 'stone');
          w.box([px - 5.5, G, pz - 4], [px + 5.5, G + 0.12, pz + 4], 'slimePool', { solid: false });
          w.data.ghostZones.push({ min: [x0 + 2, 1, z0 + 2], max: [x1 - 2, 9, z1 - 2] });
          break;
        }
        case 'deck':
          break;
      }
    }
  }

  // perimeter loop in the opposite sense gives two-way traffic on outer roads
  w.data.paths.push({ points: roundedLoop(-3, -3, span + 3, span + 3, 4.5, true) });

  for (let i = 0; i < 14; i++) {
    const c = rng.int(0, blocks) * pitch + rng.range(-4, 4);
    const t = rng.range(0, span);
    w.puddle(rng.chance(0.5) ? [c, 0.02, t] : [t, 0.02, c], rng.range(0.8, 2));
  }
}
