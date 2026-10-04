import { Rng } from '@/engine/core/rng';
import { LIFT, writeElevator } from './elevator-shaft';
import type { ElevatorStop, Facing, RailDef, V3 } from './level-data';
import type { LevelWriter } from './level-writer';

/** Deck dimensions in local (deck) coordinates. */
export const DECK = {
  W: 48,
  D: 36,
  /** Floor heights: the ground floor, then each upper level (the last is the roof). */
  floors: [0.2, 5, 10, 15, 20] as const,
  slab: 0.6,
  /** Ramp lanes: A along +z edge, B along -z edge. */
  laneA: [29, 36] as const,
  laneB: [0, 7] as const,
  rampX: [14, 34] as const,
  parapet: 1.2,
};

/**
 * Ground floor parking: a row along the north wall, one spot in each bay
 * between its columns (x centers), west of the stair and elevator doors, so
 * the lanes from the gates to the ramp stay clear. Spots start this far in
 * from the wall's face (clear of the columns), this wide and deep.
 */
const GROUND_SPOTS = { xs: [4.3, 12, 20, 28], z: 1.3, width: 4.8, depth: 6.6 };

/** How many cars are already parked in the deck when the game starts (a range). */
const START_CARS: [number, number] = [5, 9];

/** Roof furniture stands this far above the roof: the corner banner towers' tops, and the clock tower's shaft (its head sits on that). */
const ROOF = { banner: 6, clock: 9 };

const BANNERS = [
  ['HAUNTED', 'PARKING', 'DECK'],
  ['SAME', 'TRUCKS', 'DIFFERENT', 'DIMENSION'],
  ['GOOD', 'ROADIES', 'HAUNT', 'BETTER', 'TOGETHER'],
  ['MORE', 'GHOSTS', 'MORE', 'ROADIES'],
  ['LIFE', 'IS BETTER', 'OFF', 'ROADIE'],
];

/**
 * Pedestrian stair tower against the north face, between the columns at x 32
 * and 40: switchback flights in two lanes split by a wall, a floor landing at
 * the east end of every level with a door through the parapet (too narrow for
 * a car), and doors at the bottom into the ground floor and out to the
 * sidewalk. Valets come down this way; so can Cody.
 */
const STAIR = {
  x0: 32.6,
  x1: 39.4,
  /** North extent (the tower sits outside the deck, z < 0). */
  z0: -3.8,
  wall: 0.3,
  /** Door gap along x, shared by every level. */
  door: [37.5, 39.1] as [number, number],
  tread: 0.3,
  /** Steps per flight; the landing is the last rise. */
  steps: 9,
  /** Divider between the north (up-going) and south lanes. */
  divider: [-1.8, -1.7] as [number, number],
  /** Its walls rise this far above each floor (to the roof slab's top when that floor is the top), the roof slab this thick. */
  above: 2.5,
  roof: 0.3,
};

/**
 * The basement under the deck's north side: a concrete store room the
 * stairwell's last flight comes down to, through a door in its north wall
 * that lines up with the stair door. Randy Rolsen hangs about in here.
 */
const BASEMENT = {
  /** Top of its floor slab (a storey below the ground floor). */
  floor: -4.8,
  slab: 0.6,
  /** Inside the walls: x0, z0, x1, z1. The north wall (z 0..wall) sits inside the deck's footprint. */
  room: [24, 0, 44, 12] as [number, number, number, number],
  wall: 0.4,
  /** Its ceiling slab runs up to the ground floor, the city ground's thickness. */
  ceiling: -1,
  /** Door height; where Randy stands (by the stair door) and which way he faces (yaw). */
  doorTop: 2.4,
  randy: [36.6, 2.0] as [number, number],
  randyYaw: 2.6,
  /**
   * His burning trash can, in his own frame (x to his left, z ahead): an arm
   * and a roasting stick's length out in front, under the stick's end.
   */
  fire: [0.36, 1.42] as [number, number],
  /** Its lamp hangs this far over the floor. */
  fireLight: 1.5,
};

/** The stair tower's inside, world x0, z0, x1, z1, for a deck at `origin`: the city leaves its sidewalk out here (the shaft goes down). */
export function stairShaft(origin: V3): [number, number, number, number] {
  return [origin[0] + STAIR.x0 + STAIR.wall, origin[2] + STAIR.z0 + STAIR.wall, origin[0] + STAIR.x1 - STAIR.wall, origin[2]];
}

/**
 * The elevator, east of the stair tower on the north face (past the ramp
 * lanes, so every level has floor in front of its door): a shaft just outside
 * the deck from a pit under the basement to above the top level, with a door
 * into the basement, the ground floor and each upper level.
 */
const ELEV = {
  /** The shaft's inside (the cab's footprint): x0, z0, x1, z1. Its wall on the deck side stands just outside the deck (z -0.3..0). */
  shaft: [41.7, -2.6, 44.1, -0.3] as [number, number, number, number],
  door: 1.4,
};

/** Where the deck's walls stop either side of the elevator: the shaft's width, walls and all (its face is the wall there). */
const ELEV_GAP: [number, number] = [ELEV.shaft[0] - LIFT.wall, ELEV.shaft[2] + LIFT.wall];

/** The elevator shaft's inside, world x0, z0, x1, z1, for a deck at `origin`: no sidewalk here either. */
export function elevatorShaft(origin: V3): [number, number, number, number] {
  const [x0, z0, x1, z1] = ELEV.shaft;
  return [origin[0] + x0, origin[2] + z0, origin[0] + x1, origin[2] + z1];
}

/** The elevator: stops at the basement, the ground floor and every upper level, roofed over the top one. */
function elevator(w: LevelWriter, F: readonly number[]): void {
  const [x0, z0, x1, z1] = ELEV.shaft;
  const stops: ElevatorStop[] = [{ y: BASEMENT.floor, facing: 'z+', label: 'BASEMENT' }];
  F.forEach((y, k) => stops.push({ y, facing: 'z+', label: `LEVEL ${k + 1}` }));
  const top = (F[F.length - 1] ?? 0) + LIFT.head;
  writeElevator(w, {
    min: [x0, BASEMENT.floor - LIFT.pit, z0],
    max: [x1, top, z1],
    door: ELEV.door,
    stops,
  });
}

/** The stair tower: from the basement up to every floor, a roof slab over the top one. */
function stairwell(w: LevelWriter, F: readonly number[]): void {
  const S = STAIR;
  const B = BASEMENT;
  const ix0 = S.x0 + S.wall;
  const ix1 = S.x1 - S.wall;
  const iz0 = S.z0 + S.wall;
  const base = B.floor - B.slab;
  const runEnd = S.door[0];
  const runStart = runEnd - S.tread * S.steps;
  /** The tower's walls and divider between y0 and y1 (the street door only at the bottom). */
  const shell = (y0: number, y1: number, street: boolean): void => {
    w.box([S.x0, y0, S.z0], [ix0, y1, 0], 'concreteDark');
    w.box([ix1, y0, S.z0], [S.x1, y1, 0], 'concreteDark');
    if (street) {
      w.box([S.x0, y0, S.z0], [S.door[0] + 0.1, y1, iz0], 'concreteDark');
      w.box([S.door[1] - 0.1, y0, S.z0], [S.x1, y1, iz0], 'concreteDark');
      w.box([S.door[0] + 0.1, y0, S.z0], [S.door[1] - 0.1, 0, iz0], 'concreteDark');
      w.box([S.door[0] + 0.1, 2.4, S.z0], [S.door[1] - 0.1, y1, iz0], 'concreteDark');
    } else {
      w.box([S.x0, y0, S.z0], [S.x1, y1, iz0], 'concreteDark');
    }
    w.box([runStart, Math.max(y0, B.floor), S.divider[0]], [runEnd, y1, S.divider[1]], 'concreteDark');
  };
  /** Up from floor `lo` to floor `hi`: two switchback flights, a half landing, and this floor's landing and light. */
  const flights = (lo: number, hi: number): void => {
    const rise = (hi - lo) / (2 * (S.steps + 1));
    const mid = lo + (hi - lo) / 2;
    // up the north lane, heading west
    for (let i = 1; i <= S.steps; i++) {
      const x1 = runEnd - S.tread * (i - 1);
      const y = lo + rise * i;
      w.box([x1 - S.tread, y - 0.3, iz0], [x1, y, S.divider[0]], 'concrete');
    }
    // half landing at the west end
    w.box([ix0, mid - 0.3, iz0], [runStart, mid, 0], 'concrete');
    // up the south lane, heading east, to this floor's landing (at street level, the tower's own: the sidewalk stops at its walls)
    for (let i = 1; i <= S.steps; i++) {
      const x0 = runStart + S.tread * (i - 1);
      const y = mid + rise * i;
      w.box([x0, y - 0.3, S.divider[1]], [x0 + S.tread, y, 0], 'concrete');
    }
    w.box([runEnd, hi - 0.3, iz0], [ix1, hi, 0], 'concrete');
    w.lamp([(runEnd + ix1) / 2, hi + 2.4, iz0 / 2], 'green', 'ceiling');
  };
  // basement to street
  shell(base, (F[0] as number) + S.above, true);
  w.sign([S.x1 + 0.03, 2.6, S.z0 / 2], [2.6, 0.8], 'x+', 'neonPurple', ['STAIRS']);
  w.box([ix0, base, iz0], [ix1, B.floor, 0], 'concrete');
  flights(B.floor, F[0] as number);
  w.lamp([(runEnd + ix1) / 2, B.floor + 2.4, iz0 / 2], 'green', 'ceiling');
  // below street level there's no ground plane in here
  w.data.pits.push({ min: w.p([ix0, base, iz0]), max: w.p([ix1, 0, 0]) });
  // each upper level's flights and walls
  for (let k = 1; k < F.length; k++) {
    const lo = F[k - 1] as number;
    const hi = F[k] as number;
    shell(lo + S.above, hi + S.above, false);
    flights(lo, hi);
  }
  // the roof over the tower
  const roof = (F[F.length - 1] as number) + S.above;
  w.box([S.x0, roof - S.roof, S.z0], [S.x1, roof, 0], 'roof');
  w.box([S.door[0] - 0.1, roof, S.z0 + 0.6], [S.door[1] + 0.1, roof + 0.15, S.z0 + 1.2], 'lampGreen', { solid: false });
}

/** The store room under the deck: walls, floor, a ceiling slab under the ground floor, a few columns and crates, Randy. */
function basement(w: LevelWriter): void {
  const B = BASEMENT;
  const [x0, z0, x1, z1] = B.room;
  const t = B.wall;
  const base = B.floor - B.slab;
  const [d0, d1] = STAIR.door;
  w.box([x0, base, z0], [x1, B.floor, z1], 'concreteDark');
  w.box([x0, B.ceiling, z0], [x1, 0, z1], 'concrete');
  w.box([x0 - t, base, z0], [x0, 0, z1 + t], 'concrete');
  w.box([x1, base, z0], [x1 + t, 0, z1 + t], 'concrete');
  w.box([x0 - t, base, z1], [x1 + t, 0, z1 + t], 'concrete');
  // north wall, with the door to the stair shaft; the elevator shaft's face is the wall at its end
  w.box([x0, B.floor, z0], [d0, B.ceiling, z0 + t], 'concrete');
  w.box([d1, B.floor, z0], [Math.min(x1, ELEV_GAP[0]), B.ceiling, z0 + t], 'concrete');
  w.box([d0, B.floor + B.doorTop, z0], [d1, B.ceiling, z0 + t], 'concrete');
  w.sign([(d0 + d1) / 2, B.floor + B.doorTop + 0.45, z0 + t + 0.03], [1.9, 0.55], 'z+', 'neonPurple', ['BASEMENT']);
  // columns under the ground floor
  for (const [cx, cz] of [
    [30, 6],
    [38, 6],
  ] as const) {
    w.box([cx - 0.4, B.floor, cz - 0.4], [cx + 0.4, B.ceiling, cz + 0.4], 'concreteLight');
  }
  // stock: crates along the west wall, a pallet stack in the corner
  w.box([x0 + 0.3, B.floor, 8.6], [x0 + 1.7, B.floor + 1.2, 10], 'wood');
  w.box([x0 + 0.3, B.floor + 1.2, 8.8], [x0 + 1.5, B.floor + 2.2, 9.8], 'wood');
  w.box([x0 + 0.3, B.floor, 10.4], [x0 + 1.5, B.floor + 1, 11.6], 'wood');
  w.box([x1 - 2.4, B.floor, z1 - 1.6], [x1 - 0.3, B.floor + 0.5, z1 - 0.3], 'wood');
  // dim lights under the ceiling slab
  const lightY = B.ceiling - 0.14;
  for (const [lx, lz, color] of [
    [28, 3, 'warm'],
    [36, 9, 'green'],
    [41, 3, 'warm'],
  ] as const) {
    w.box([lx - 0.6, lightY, lz - 0.2], [lx + 0.6, B.ceiling, lz + 0.2], color === 'green' ? 'lampGreen' : 'lampWarm', { solid: false });
    w.lamp([lx, lightY, lz], color, 'ceiling');
  }
  // no ground plane under the room (its floor slab is the ground)
  w.data.pits.push({
    min: w.p([x0 - t, base, z0]),
    max: w.p([x1 + t, 0, z1 + t]),
  });
  // Randy, by the stair door, roasting something over his trash can fire
  const [rx, rz] = B.randy;
  const yaw = B.randyYaw;
  const [fx, fz] = B.fire;
  const cx = rx + fx * Math.cos(yaw) + fz * Math.sin(yaw);
  const cz = rz - fx * Math.sin(yaw) + fz * Math.cos(yaw);
  // the can blocks people as an NPC's prop (it goes where he goes), not level geometry
  w.lamp([cx, B.floor + B.fireLight, cz], 'warm', 'ceiling');
  w.data.npcs.push({
    id: 'randy',
    pos: w.p([rx, B.floor, rz]),
    yaw,
    fire: w.p([cx, B.floor, cz]),
  });
}

/**
 * The haunted parking deck: a ground floor fenced in with badge gates on the
 * east side, and upper levels with breakable parapets reached by ramps in
 * alternating lanes, roof furniture (kickers, billboard, banner towers, the
 * clock tower) on top, and a basement under it all.
 */
export function generateDeck(w: LevelWriter, origin: V3, seed: number): void {
  const rng = new Rng(seed);
  const { W, D, floors: F, slab: T } = DECK;
  const [ax0, ax1] = DECK.rampX;
  const top = F.length - 1;
  // a breakable guardrail or railing run, `out` off the side it guards
  const rail = (style: RailDef['style'], a: V3, b: V3, out: [number, number]): void => {
    w.data.rails.push({ style, a: w.p(a), b: w.p(b), out });
  };
  /** Top of upper level k's columns (0: the ground). */
  const colTop = (k: number): number => (k === 0 ? 0 : (F[k] as number) + DECK.parapet + 0.2);

  w.at(origin, () => {
    // ground floor
    w.box([0, 0, 0], [W, F[0], D], 'concreteDark');

    // ground floor: low wall + fence (collision to 3.6 so trucks can't hop it)
    const wall = (x0: number, z0: number, x1: number, z1: number): void => {
      w.box([x0, 0, z0], [x1, 1.6, z1], 'concrete', { drip: 'top' });
      w.box([x0, 1.6, z0], [x1, 3.7, z1], 'invisible');
      const along = x1 - x0 > z1 - z0;
      const len = along ? x1 - x0 : z1 - z0;
      const n = Math.max(1, Math.round(len / 2));
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const px = along ? x0 + (x1 - x0) * t : (x0 + x1) / 2;
        const pz = along ? (z0 + z1) / 2 : z0 + (z1 - z0) * t;
        w.block(px, 1.6, pz, 0.12, 2.1, 0.12, 'metal', { solid: false });
      }
      const mx = (x0 + x1) / 2;
      const mz = (z0 + z1) / 2;
      w.block(mx, 3.55, mz, along ? len : 0.1, 0.1, along ? 0.1 : len, 'metal', { solid: false });
      w.block(mx, 2.6, mz, along ? len : 0.06, 0.06, along ? 0.06 : len, 'metal', { solid: false });
    };
    // north wall, with the stairwell's door into the ground floor
    wall(1.6, 0, STAIR.door[0], 0.5);
    wall(STAIR.door[1], 0, ELEV_GAP[0], 0.5);
    wall(ELEV_GAP[1], 0, W - 1.6, 0.5);
    wall(1.6, D - 0.5, W - 1.8, D);
    wall(0, 1.6, 0.5, D - 1.6);
    wall(W - 0.5, 1.6, W, 9.8);
    wall(W - 0.5, 26.2, W, D - 1.8);

    // ground floor parking: spots numbered first, backed in facing the floor (yaw 0), lined like the levels above
    let spotId = 0;
    const firstSpot = w.data.spots.length;
    const G = GROUND_SPOTS;
    const gz1 = G.z + G.depth;
    for (const xc of G.xs) {
      w.data.spots.push({
        id: spotId++,
        center: w.p([xc, F[0], G.z + G.depth / 2]),
        size: [G.width, G.depth],
        yaw: 0,
        level: 0,
      });
      for (const x of [xc - G.width / 2, xc + G.width / 2]) w.box([x - 0.08, F[0], G.z], [x + 0.08, F[0] + 0.03, gz1], 'linePurple', { solid: false });
      w.box([xc - G.width / 2 + 0.08, F[0], gz1 - 0.16], [xc + G.width / 2 - 0.08, F[0] + 0.03, gz1], 'lineGreen', { solid: false });
    }

    // the upper levels
    for (let k = 1; k <= top; k++) {
      const lo = F[k - 1] as number;
      const fy = F[k] as number;
      // slab with a hole for the ramp coming up (lane A on odd levels, B on even), railed round
      const holeA = k % 2 === 1;
      const rects: [number, number, number, number][] = holeA
        ? [
            [0, 0, W, DECK.laneA[0]],
            [0, DECK.laneA[0], ax0, D],
            [ax1, DECK.laneA[0], W, D],
          ]
        : [
            [0, DECK.laneB[1], W, D],
            [0, 0, ax0, DECK.laneB[1]],
            [ax1, 0, W, DECK.laneB[1]],
          ];
      for (const [x0, z0, x1, z1] of rects) w.box([x0, fy - T, z0], [x1, fy, z1], 'concrete', { drip: 'bottom' });
      const ry1 = fy + DECK.parapet;
      if (holeA) {
        w.box([ax0, fy, DECK.laneA[0] - 0.4], [ax1, ry1, DECK.laneA[0]], 'concrete', { drip: 'top' });
        w.box([ax0 - 0.4, fy, DECK.laneA[0]], [ax0, ry1, D - 0.4], 'concrete', {
          drip: 'top',
        });
        rail('railing', [ax0, ry1, DECK.laneA[0] - 0.2], [ax1, ry1, DECK.laneA[0] - 0.2], [0, 1]);
        rail('railing', [ax0 - 0.2, ry1, DECK.laneA[0]], [ax0 - 0.2, ry1, D - 0.4], [1, 0]);
      } else {
        w.box([ax0, fy, DECK.laneB[1]], [ax1, ry1, DECK.laneB[1] + 0.4], 'concrete', { drip: 'top' });
        w.box([ax1, fy, 0.4], [ax1 + 0.4, ry1, DECK.laneB[1]], 'concrete', {
          drip: 'top',
        });
        rail('railing', [ax0, ry1, DECK.laneB[1] + 0.2], [ax1, ry1, DECK.laneB[1] + 0.2], [0, -1]);
        rail('railing', [ax1 + 0.2, ry1, 0.4], [ax1 + 0.2, ry1, DECK.laneB[1]], [-1, 0]);
      }

      // the ramp up to it (rising east in lane A, west in lane B), guardrails straddling both edges
      const [z0, z1] = holeA ? [29.4, 34.6] : [1.4, 6.6];
      w.ramp([ax0, lo, z0], [ax1, fy, z1], 'x', holeA ? 1 : -1, lo, 'concrete');
      const [ya, yb] = holeA ? [lo, fy] : [fy, lo];
      rail('guardrail', [ax0, ya, z0], [ax1, yb, z0], [0, -1]);
      rail('guardrail', [ax0, ya, z1], [ax1, yb, z1], [0, 1]);

      // perimeter columns, this level's stretch
      for (const x of [8, 16, 24, 32, 40]) {
        w.box([x - 0.6, colTop(k - 1), 0], [x + 0.6, colTop(k), 1.2], 'concreteLight');
        w.box([x - 0.6, colTop(k - 1), D - 1.2], [x + 0.6, colTop(k), D], 'concreteLight');
      }
      for (const z of [9, 18, 27]) {
        w.box([0, colTop(k - 1), z - 0.6], [1.2, colTop(k), z + 0.6], 'concreteLight');
        w.box([W - 1.2, colTop(k - 1), z - 0.6], [W, colTop(k), z + 0.6], 'concreteLight');
      }

      // parapets: breakable segments between columns
      const xs: [number, number][] = [
        [1.6, 7.4],
        [8.6, 15.4],
        [16.6, 23.4],
        [24.6, 31.4],
        [32.6, 39.4],
        [40.6, 46.2],
      ];
      for (const [x0, x1] of xs) {
        if (x0 === STAIR.x0) {
          // the stairwell door: solid either side, so a truck can't smash it wide open
          w.box([x0, fy, 0], [STAIR.door[0], ry1, 0.4], 'concrete', {
            drip: 'top',
          });
          w.box([STAIR.door[1], fy, 0], [x1, ry1, 0.4], 'concrete');
          rail('railing', [x0, ry1, 0.2], [STAIR.door[0], ry1, 0.2], [0, -1]);
          rail('railing', [STAIR.door[1], ry1, 0.2], [x1, ry1, 0.2], [0, -1]);
        } else if (x0 < ELEV_GAP[0] && x1 > ELEV_GAP[1]) {
          // the elevator: solid either side of its shaft
          const x2 = x1 + (x1 === 46.2 ? 0.2 : 0);
          w.box([x0, fy, 0], [ELEV_GAP[0], ry1, 0.4], 'concrete', {
            drip: 'top',
          });
          w.box([ELEV_GAP[1], fy, 0], [x2, ry1, 0.4], 'concrete', {
            drip: 'top',
          });
          rail('railing', [x0, ry1, 0.2], [ELEV_GAP[0], ry1, 0.2], [0, -1]);
          rail('railing', [ELEV_GAP[1], ry1, 0.2], [x1, ry1, 0.2], [0, -1]);
        } else {
          w.box([x0, fy, 0], [x1 + (x1 === 46.2 ? 0.2 : 0), ry1, 0.4], 'concrete', { drip: 'top', breakable: true });
          rail('railing', [x0, ry1, 0.2], [x1, ry1, 0.2], [0, -1]);
        }
        w.box([x0, fy, D - 0.4], [x1, ry1, D], 'concrete', {
          drip: 'top',
          breakable: true,
        });
        rail('railing', [x0, ry1, D - 0.2], [x1, ry1, D - 0.2], [0, 1]);
      }
      const zs: [number, number][] = [
        [1.6, 8.4],
        [9.6, 17.4],
        [18.6, 26.4],
        [27.6, 34.2],
      ];
      for (const [z0, z1] of zs) {
        w.box([0, fy, z0], [0.4, ry1, z1 + (z1 === 34.2 ? 0.2 : 0)], 'concrete', { drip: 'top', breakable: true });
        w.box([W - 0.4, fy, z0], [W, ry1, z1], 'concrete', {
          drip: 'top',
          breakable: true,
        });
        rail('railing', [0.2, ry1, z0], [0.2, ry1, z1], [-1, 0]);
        rail('railing', [W - 0.2, ry1, z0], [W - 0.2, ry1, z1], [1, 0]);
      }

      // lights under the slab (the level below's ceiling)
      const ceil = fy - T - 0.14;
      let n = 0;
      for (const x of [5, 13, 21, 29, 37, 43]) {
        for (const z of [4, 12, 24, 32]) {
          const inHole = x > ax0 && x < ax1 && (holeA ? z > DECK.laneA[0] : z < DECK.laneB[1]);
          if (inHole) continue;
          const green = n++ % 2 === 0;
          w.box([x - 0.9, ceil, z - 0.25], [x + 0.9, ceil + 0.14, z + 0.25], green ? 'lampGreen' : 'lampPurple', { solid: false });
          w.lamp([x, ceil, z], green ? 'green' : 'purple', 'ceiling');
        }
      }

      // parking spots, two facing rows of five
      for (let row = 0; row < 2; row++) {
        const zc = row === 0 ? 13.3 : 22.7;
        for (let i = 0; i < 5; i++) {
          const xc = 14.4 + i * 4.8;
          w.data.spots.push({
            id: spotId++,
            center: w.p([xc, fy, zc]),
            size: [4.8, 6.6],
            yaw: row === 0 ? 0 : Math.PI,
            level: k,
          });
        }
        for (let i = 0; i <= 5; i++) {
          const x = 12 + i * 4.8;
          w.box([x - 0.08, fy, zc - 3.3], [x + 0.08, fy + 0.03, zc + 3.3], 'linePurple', { solid: false });
        }
      }
      w.box([12, fy, 16.52], [36, fy + 0.03, 16.68], 'lineGreen', {
        solid: false,
      });
      w.box([12, fy, 19.32], [36, fy + 0.03, 19.48], 'lineGreen', {
        solid: false,
      });
      for (let p = 0; p < 3; p++) w.puddle([rng.range(4, 44), fy + 0.02, rng.range(9, 27)], rng.range(1.2, 2.6));

      // its level sign on the east and south faces
      const label = ['LEVEL', String(k + 1)];
      w.sign([W + 0.03, fy + 2.6, 27], [1.15, 1.6], 'x+', 'level', label);
      w.sign([24, fy + 2.6, D + 0.03], [1.15, 1.6], 'z+', 'level', label);
    }

    stairwell(w, F);
    elevator(w, F);
    basement(w);

    // roof furniture: corner banner towers and the clock tower stand a little taller than the deck,
    // the billboard and the kickers sit on its roof
    {
      const R = F[top] as number;
      const towers: [number, number][] = [
        [0, 0],
        [W, 0],
        [0, D],
      ];
      let b = 0;
      const tall = R + ROOF.banner;
      for (const [tx, tz] of towers) {
        w.block(tx, 0, tz, 3.2, tall, 3.2, 'concrete');
        w.block(tx, tall, tz, 3.9, 0.7, 3.9, 'concreteLight', { drip: 'top' });
        w.lamp([tx, tall + 1.2, tz], 'green', 'flood');
        const faces: [Facing, number, number][] = [
          ['x+', tx + 1.62, tz],
          ['x-', tx - 1.62, tz],
          ['z+', tx, tz + 1.62],
          ['z-', tx, tz - 1.62],
        ];
        for (const [f, fx, fz] of faces) w.sign([fx, tall / 2, fz], [2.5, 7.2], f, 'banner', BANNERS[b++ % BANNERS.length] ?? []);
      }
      // clock tower (front corner)
      const cx = W;
      const cz = D;
      const c0 = R + ROOF.clock;
      w.block(cx, 0, cz, 3.6, c0, 3.6, 'concreteLight');
      w.block(cx, c0, cz, 5, 5, 5, 'concrete', { drip: 'top' });
      w.block(cx, c0 + 5, cz, 5.6, 0.6, 5.6, 'concreteLight', { drip: 'top' });
      w.block(cx, c0 + 5.6, cz, 4.2, 1, 4.2, 'roof');
      w.block(cx, c0 + 6.6, cz, 3, 1, 3, 'roof');
      w.block(cx, c0 + 7.6, cz, 1.8, 1.2, 1.8, 'roof');
      w.block(cx, c0 + 8.8, cz, 0.5, 3, 0.5, 'metal');
      w.lamp([cx, c0 + 12.1, cz], 'green', 'flood');
      const off = 2.53;
      const clocks: [Facing, number, number][] = [
        ['x+', cx + off, cz],
        ['x-', cx - off, cz],
        ['z+', cx, cz + off],
        ['z-', cx, cz - off],
      ];
      for (const [f, fx, fz] of clocks)
        w.data.clocks.push({
          pos: w.p([fx, c0 + 2.5, fz]),
          facing: f,
          size: 4.2,
        });
      // billboard
      w.box([17.6, R, 1.6], [18.4, R + 3.4, 2.1], 'metal');
      w.box([29.6, R, 1.6], [30.4, R + 3.4, 2.1], 'metal');
      w.box([15.6, R + 3.3, 1.5], [32.4, R + 10.1, 2.0], 'metal', {
        solid: false,
        drip: 'top',
      });
      w.sign([24, R + 6.7, 2.05], [16.4, 6.4], 'z+', 'billboard', ['30', 'PHANTOM CODYS', 'SAME TRUCKS. DIFFERENT DIMENSION.']);
      // kickers
      w.ramp([38, R, 14], [44.5, R + 1.8, 20], 'x', 1, R, 'concrete', true);
      w.ramp([3.5, R, 15], [10, R + 1.8, 21], 'x', -1, R, 'concrete', true);
    }

    // badge gates (east side). The deck face is the block edge and this block's traffic lane
    // runs at W + 3, so nothing below roof height reaches past W + 1.6.
    w.box([W - 1.4, F[0], 16.6], [W + 1.4, 3.0, 19.4], 'concreteLight');
    w.box([W - 1.6, 3.0, 16.4], [W + 1.6, 3.3, 19.6], 'metal');
    w.box([W + 1.4, 1.4, 17.2], [W + 1.5, 2.6, 18.8], 'glass', {
      solid: false,
    });
    w.box([W, 0, 16.0], [W + 1.6, 0.45, 20.0], 'concreteLight', {
      top: 'hazard',
    });
    w.block(W + 1.15, 0.45, 16.3, 0.5, 1.4, 0.4, 'metal');
    w.block(W + 1.15, 0.45, 19.7, 0.5, 1.4, 0.4, 'metal');
    w.sign([W + 1.15, 1.35, 16.08], [0.48, 0.8], 'z-', 'scanner', ['SCAN BADGE']);
    w.sign([W + 1.15, 1.35, 19.92], [0.48, 0.8], 'z+', 'scanner', ['SCAN BADGE']);
    w.data.gates.push(
      {
        kind: 'entry',
        min: w.p([W - 4, 0, 9.8]),
        max: w.p([W + 5, 3.2, 16.6]),
        hinge: w.p([W + 1.15, 1.2, 15.85]),
        armDir: 'z-',
        armLength: 6.0,
      },
      {
        kind: 'exit',
        min: w.p([W - 4, 0, 19.4]),
        max: w.p([W + 5, 3.2, 26.2]),
        hinge: w.p([W + 1.15, 1.2, 20.15]),
        armDir: 'z+',
        armLength: 6.0,
      },
    );
    w.sign([W + 0.05, 4.68, 13.2], [5.6, 0.75], 'x+', 'neon', ['ENTRY']);
    w.sign([W + 0.05, 4.68, 22.8], [5.6, 0.75], 'x+', 'neonPurple', ['EXIT']);
    w.sign([W + 0.03, 2.6, 27], [1.15, 1.6], 'x+', 'level', ['LEVEL', '1']);
    w.sign([24, 2.6, D + 0.03], [1.15, 1.6], 'z+', 'level', ['LEVEL', '1']);
    w.sign([9, 1.45, D + 0.05], [12, 2.4], 'z+', 'checker', ['ROADIE']);

    w.puddle([30, F[0] + 0.02, 18], 2.2);
    w.puddle([8, F[0] + 0.02, 12], 1.6);

    // a few cars already parked, in spots picked at random
    const spots = w.data.spots.slice(firstSpot);
    for (let i = rng.int(...START_CARS); i > 0 && spots.length; i--) {
      const [s] = spots.splice(rng.int(0, spots.length - 1), 1);
      if (s) w.data.parked.push({ pos: s.center, yaw: s.yaw });
    }

    const roofMax = (F[top] as number) + ROOF.clock;
    w.data.ghostZones.push({
      min: w.p([2, 2, 2]),
      max: w.p([W - 2, roofMax, D - 2]),
    });

    w.data.deck = {
      min: w.p([0, 0, 0]),
      max: w.p([W, roofMax, D]),
      floors: [...F],
    };
  });
}
