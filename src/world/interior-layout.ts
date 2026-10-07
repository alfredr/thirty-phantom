import { subtractRects } from '@/engine/core/geometry';
import { Rng } from '@/engine/core/rng';

import { LIFT, shaftParts } from './elevator-shaft';
import {
  bayCount,
  FACADE,
  type Facade,
  frontWindow,
  storeyWindow,
} from './facade-layout';
import type {
  BoxDef,
  BuildingDef,
  BuildingUse,
  DoorDef,
  ElevatorDef,
  FacadeDef,
  Facing,
  V3,
} from './level-data';

/**
 * Interior dimensions in meters. Expand seeded buildings into collision shells
 * and furnished rooms whose openings match the facade shader. Elevator cores
 * connect walkable upper floors; stair cores remain closed placeholders. Room
 * surfaces, lamps, and panes batch into separate material groups when
 * rendered.
 */
export const INTERIOR = {
  /**
   * Collision-shell thickness in meters. Thick walls reduce tunnelling and
   * provide deep reveals around rendered openings.
   */
  wall: 1.0,
  /**
   * The linings start this far behind the facade, so they never share its
   * plane.
   */
  revealGap: 0.01,
  /** The slab under each upper floor. */
  slab: 0.3,
  /** How far the linings stand in from the shell; floor and ceiling finishes. */
  lining: 0.06,
  finish: 0.03,
  /**
   * Lamp dimensions, ceiling offset, and target spacing in meters. Offset
   * fixtures below the ceiling to avoid coplanar overlap.
   */
  lamp: [0.9, 0.3, 0.08] as const,
  lampDrop: 0.01,
  lampEvery: 4,
  /**
   * Kept clear in front of every doorway: how far into the room, and how much
   * wider than the door.
   */
  doorway: { depth: 1.8, side: 0.5 },
  /**
   * Kept clear in front of an elevator's door: how far out, and how much wider
   * than the door.
   */
  landing: { depth: 2.2, side: 0.6 },
  /**
   * Elevator and stair core footprints as (width, depth), including shaft
   * walls.
   */
  elevator: [3.0, 2.9] as const,
  stair: [2.4, 3.0] as const,
  /** An elevator's landing doors, as the deck's. */
  liftDoor: 1.4,
  /**
   * Maximum upper storeys served by an interior elevator, limiting initial
   * collision and navigation costs.
   */
  liftStoreys: 6,
  /** A stair core's door plate: width, height, standing off it. */
  plate: { w: 1.1, h: 2.2, off: 0.05 },
  /**
   * Partition thickness, doorway width, and lintel height in meters. Doorways
   * allow pedestrian passage on the 0.5-meter navigation grid.
   */
  partition: { thick: 0.12, door: 1.5, top: 2.4 },
  /** Small rooms: the narrowest, and how deep along a corridor (a range). */
  room: { min: 2.6, depth: [3.5, 5] as const },
  /**
   * Back-room strip dimensions for ground floors at least `from` meters deep.
   * Use core depth when present; otherwise clamp the configured depth
   * fraction.
   */
  back: { share: 0.3, min: 2.8, max: 4.5, from: 7 },
  /** An upper floor's corridor runs this far either side of the core. */
  corridor: 0.6,
  /** Window panes, drawn while live: how far in from the facade, how thick. */
  pane: { inset: 0.05, thick: 0.02 },
  /** How often a shop is a diner. */
  diner: 0.35,
};

/** Paints for the rooms: fittings by finish, and a few wall paints and floors. */
const PAINT = {
  wood: '#5a3a2e',
  steel: '#8a8496',
  dark: '#2a2233',
  counter: '#d0c8d8',
  booth: '#9a2b40',
  stone: '#8a8094',
  plant: '#3f7a2a',
  ceiling: '#d8d0e0',
  core: '#4a4258',
  crate: '#7a5a3a',
  walls: ['#d8c49a', '#c98a9a', '#8ab8a0', '#a898d0', '#e0d0b0', '#9ab0c0'],
  floors: ['#4a3036', '#3a3448', '#6a5a52', '#2e3a3e'],
  dinerFloor: '#9a3046',
};

/** Wall paints for a walk-in's rooms (BuildingDef.paint). */
export const ROOM_WALLS: readonly string[] = PAINT.walls;

/**
 * The facade material's key for painted room boxes (every facade key shares
 * the material).
 */
const PAINTED = 'facadeA' as const;

/** Furnishing category for a room off the main hub. */
type RoomKind =
  | 'office'
  | 'meeting'
  | 'storage'
  | 'restroom'
  | 'kitchen'
  | 'mail';

/** Small rooms behind each ground floor, by its use. */
const BACK_ROOMS: Readonly<Record<BuildingUse, readonly RoomKind[]>> = {
  shop: ['storage', 'restroom', 'office'],
  diner: ['kitchen', 'restroom', 'storage'],
  lobby: ['mail', 'office', 'restroom'],
  hall: ['storage', 'mail', 'restroom'],
};
/** Weighted choices for upper-floor room use. */
const UPPER_ROOMS: readonly RoomKind[] = [
  'office',
  'office',
  'office',
  'meeting',
  'storage',
  'restroom',
];

/** Expanded interior definitions for collision and on-demand rendering. */
export interface Interior {
  def: BuildingDef;
  /**
   * Collision only: walls round the doorways, slabs, the block over the top
   * floor, the elevator's shaft.
   */
  shell: BoxDef[];
  /**
   * Render geometry for linings, finishes, lamps, partitions, fittings, and
   * cores. Solid entries participate in collision even while not rendered.
   */
  rooms: BoxDef[];
  /** Glass in the windows, drawn while live in its own see-through material. */
  panes: BoxDef[];
  /** The elevator up through it, as level.elevators has it, if it has one. */
  lift: ElevatorDef | null;
  /**
   * The ground floor's floor and ceiling heights, and the top of the highest
   * floor you can walk.
   */
  floor: number;
  ceiling: number;
  top: number;
}

/**
 * A side of a footprint, seen from inside: its wall plane, which way is in,
 * and its extent along the wall.
 */
interface Side {
  facing: Facing;
  /** The axis along the wall (0 x, 2 z). */
  axis: 0 | 2;
  at: number;
  in: 1 | -1;
  a0: number;
  a1: number;
}

function sides(min: V3, max: V3): Side[] {
  return [
    { facing: 'x+', axis: 2, at: max[0], in: -1, a0: min[2], a1: max[2] },
    { facing: 'x-', axis: 2, at: min[0], in: 1, a0: min[2], a1: max[2] },
    { facing: 'z+', axis: 0, at: max[2], in: -1, a0: min[0], a1: max[0] },
    { facing: 'z-', axis: 0, at: min[2], in: 1, a0: min[0], a1: max[0] },
  ];
}

/**
 * A box against side s: a..b along it, y0..y1, from d0 to d1 in from its outer
 * face.
 */
function against(
  s: Side,
  a: number,
  b: number,
  y0: number,
  y1: number,
  d0: number,
  d1: number,
): [V3, V3] {
  const c0 = s.at + s.in * d0;
  const c1 = s.at + s.in * d1;
  const lo = Math.min(c0, c1);
  const hi = Math.max(c0, c1);
  return s.axis === 0
    ? [
        [a, y0, lo],
        [b, y1, hi],
      ]
    : [
        [lo, y0, a],
        [hi, y1, b],
      ];
}

/**
 * Interior coordinate frame relative to the main entrance wall: `a` spans
 * width W along the wall, and `d` spans depth D inward, measured inside the
 * linings.
 */
export interface RoomFrame {
  W: number;
  D: number;
  box(
    a0: number,
    a1: number,
    d0: number,
    d1: number,
    y0: number,
    y1: number,
  ): [V3, V3];
  /** A world rectangle (x0, z0, x1, z1) in this frame: a0, a1, d0, d1. */
  local(
    rect: readonly [number, number, number, number],
  ): [number, number, number, number];
}

export function roomFrame(min: V3, max: V3, facing: Facing): RoomFrame {
  const t = INTERIOR.wall + INTERIOR.lining;
  const [x0, z0, x1, z1] = [min[0] + t, min[2] + t, max[0] - t, max[2] - t];
  const alongX = facing === 'z+' || facing === 'z-';
  const W = alongX ? x1 - x0 : z1 - z0;
  const D = alongX ? z1 - z0 : x1 - x0;
  return {
    W,
    D,
    box: (a0, a1, d0, d1, y0, y1) => {
      switch (facing) {
        case 'z+':
          return [
            [x0 + a0, y0, z1 - d1],
            [x0 + a1, y1, z1 - d0],
          ];
        case 'z-':
          return [
            [x1 - a1, y0, z0 + d0],
            [x1 - a0, y1, z0 + d1],
          ];
        case 'x+':
          return [
            [x1 - d1, y0, z0 + a0],
            [x1 - d0, y1, z0 + a1],
          ];
        case 'x-':
          return [
            [x0 + d0, y0, z0 + a0],
            [x0 + d1, y1, z0 + a1],
          ];
      }
    },
    local: ([wx0, wz0, wx1, wz1]) => {
      switch (facing) {
        case 'z+':
          return [wx0 - x0, wx1 - x0, z1 - wz1, z1 - wz0];
        case 'z-':
          return [x1 - wx1, x1 - wx0, wz0 - z0, wz1 - z0];
        case 'x+':
          return [wz0 - z0, wz1 - z0, x1 - wx1, x1 - wx0];
        case 'x-':
          return [wz0 - z0, wz1 - z0, wx0 - x0, wx1 - x0];
      }
    },
  };
}

/** The floor kept clear in front of each doorway (x0, z0, x1, z1). */
function doorZones(
  min: V3,
  max: V3,
  doors: readonly DoorDef[],
): [number, number, number, number][] {
  const I = INTERIOR;
  return doors.map((d) => {
    const s = sides(min, max).find((q) => q.facing === d.facing) as Side;
    const [lo, hi] = against(
      s,
      d.at - d.width / 2 - I.doorway.side,
      d.at + d.width / 2 + I.doorway.side,
      0,
      0,
      0,
      I.wall + I.lining + I.doorway.depth,
    );
    return [lo[0], lo[2], hi[0], hi[2]];
  });
}

/**
 * Place an elevator core for a lobby or a closed stair core for other uses,
 * behind the first doorway. Try central and corner placements while avoiding
 * doorway clearances. Return null without upper storeys, a main door,
 * sufficient space, or a clear candidate.
 */
export function placeCore(
  use: BuildingUse,
  min: V3,
  max: V3,
  doors: readonly DoorDef[],
  storeys: number,
): BuildingDef['core'] {
  const main = doors[0];
  if (storeys < 1 || !main) {
    return null;
  }

  const r = roomFrame(min, max, main.facing);
  const [w, d] = use === 'lobby' ? INTERIOR.elevator : INTERIOR.stair;
  if (r.W < w + 2 || r.D < d + 3) {
    return null;
  }

  const zones = doorZones(min, max, doors);
  const tries =
    use === 'lobby'
      ? [(r.W - w) / 2, 0, r.W - w]
      : [r.W - w, 0, (r.W - w) / 2];
  for (const a0 of tries) {
    const [lo, hi] = r.box(a0, a0 + w, r.D - d, r.D, 0, 0);
    if (
      zones.some(
        ([a, b, c, e]) => lo[0] < c && hi[0] > a && lo[2] < e && hi[2] > b,
      )
    ) {
      continue;
    }

    return {
      kind: use === 'lobby' ? 'elevator' : 'stair',
      rect: [lo[0], lo[2], hi[0], hi[2]],
    };
  }

  return null;
}

/** The storeys over the lobby its elevator serves (0 without one). */
function liftStoreys(def: BuildingDef): number {
  return def.core?.kind === 'elevator'
    ? Math.min(def.storeys, INTERIOR.liftStoreys)
    : 0;
}

/**
 * Derive an indoor elevator with stops at the lobby and each supported upper
 * floor, facing the main entrance. Return null without a main door or an
 * elevator core serving upper floors. Generation and interior rendering share
 * this definition.
 */
export function buildingLift(def: BuildingDef): ElevatorDef | null {
  const n = liftStoreys(def);
  const main = def.doors[0];
  if (!n || !main || !def.core) {
    return null;
  }

  const f = { ...FACADE, ...def.facade } as Facade;
  const [x0, z0, x1, z1] = def.core.rect;
  const t = LIFT.wall;
  const y0 = def.min[1];
  const stops = [
    { y: y0 + FACADE.front.floor, facing: main.facing, label: 'LOBBY' },
  ];
  for (let k = 0; k < n; k++) {
    stops.push({
      y: y0 + f.ground + k * f.storey,
      facing: main.facing,
      label: `FLOOR ${k + 2}`,
    });
  }

  const top = stops[stops.length - 1]?.y ?? y0;
  return {
    min: [x0 + t, (stops[0]?.y ?? y0) - LIFT.pit, z0 + t],
    max: [x1 - t, top + LIFT.head, z1 - t],
    door: INTERIOR.liftDoor,
    stops,
    indoors: true,
  };
}

/**
 * Walkable floor and ceiling heights; k=-1 identifies ground level and
 * nonnegative k indexes upper storeys.
 */
interface Level {
  k: number;
  floor: number;
  ceiling: number;
}

/**
 * A small room off a hub, in the room frame: its rectangle, which wall its
 * door is in and where along it.
 */
interface Room {
  kind: RoomKind;
  a0: number;
  a1: number;
  d0: number;
  d1: number;
  door: 'd0' | 'a0' | 'a1';
  at: number;
}

/**
 * Expand the seeded building into collision-shell boxes, furnished room boxes,
 * window panes, and an optional elevator definition. Include the ground floor
 * and elevator-served upper floors. Match facade openings and preserve shaft
 * openings through floor finishes and slabs.
 */
export function expandInterior(def: BuildingDef): Interior {
  const I = INTERIOR;
  const P = I.partition;
  const f = { ...FACADE, ...def.facade } as Facade;
  const [x0, y0, z0] = def.min;
  const [x1, y1, z1] = def.max;
  const t = I.wall;
  const L = I.lining;
  const shell: BoxDef[] = [];
  const rooms: BoxDef[] = [];
  const panes: BoxDef[] = [];
  const lift = buildingLift(def);
  const painted = (
    b: [V3, V3],
    paint: string,
    solid: boolean,
    kind: FacadeDef['kind'] = 'room',
  ): void => {
    rooms.push({
      min: b[0],
      max: b[1],
      mat: PAINTED,
      solid,
      facade: { kind, paint },
    });
  };

  const invisible = (b: [V3, V3]): void => {
    shell.push({ min: b[0], max: b[1], mat: 'invisible' });
  };

  // Build walkable interiors for the ground floor and elevator-served upper floors.
  const levels: Level[] = [
    { k: -1, floor: y0 + FACADE.front.floor, ceiling: y0 + f.ground - I.slab },
  ];
  for (let k = 0; k < liftStoreys(def); k++) {
    const floor = y0 + f.ground + k * f.storey;
    levels.push({ k, floor, ceiling: floor + f.storey - I.slab });
  }

  const ground = levels[0] as Level;
  const last = levels[levels.length - 1] as Level;
  const core = def.core?.rect ?? null;
  const shaftHole =
    lift && core
      ? [{ u0: core[0], v0: core[1], u1: core[2], v1: core[3] }]
      : [];

  // Build continuous collision walls, leaving ground-floor doors open. Upper slabs exclude the elevator shaft.
  for (const s of sides(def.min, def.max)) {
    const doors = def.doors.filter((d) => d.facing === s.facing);
    // Fit Z-side walls between the full-length X-side walls to avoid corner overlap.
    const inset = s.axis === 0 ? t : 0;
    const wa = s.a0 + inset;
    const wb = s.a1 - inset;
    let a = wa;
    for (const d of [...doors].sort((p, q) => p.at - q.at)) {
      const g0 = d.at - d.width / 2;
      const g1 = d.at + d.width / 2;
      if (g0 > a) {
        invisible(against(s, a, g0, y0, ground.ceiling, 0, t));
      }

      invisible(
        against(s, g0, g1, ground.floor + d.height, ground.ceiling, 0, t),
      );
      a = g1;
    }

    if (wb > a) {
      invisible(against(s, a, wb, y0, ground.ceiling, 0, t));
    }

    if (last !== ground) {
      invisible(against(s, wa, wb, ground.ceiling, last.ceiling, 0, t));
    }
  }

  const inner = { u0: x0 + t, v0: z0 + t, u1: x1 - t, v1: z1 - t };
  for (let i = 1; i < levels.length; i++) {
    const below = levels[i - 1] as Level;
    const lv = levels[i] as Level;
    for (const r of subtractRects(inner, shaftHole)) {
      invisible([
        [r.u0, below.ceiling, r.v0],
        [r.u1, lv.floor, r.v1],
      ]);
    }
  }

  invisible([
    [x0, last.ceiling, z0],
    [x1, y1, z1],
  ]);

  // Reuse shaft walls for collision and interior paint. Omit the pit floor, signs, and roof lamp; the sidewalk
  // remains beneath indoor shafts, and extra materials would add draw calls.
  if (lift) {
    const paint: Partial<Record<string, string>> = {
      concreteDark: PAINT.core,
      roof: PAINT.core,
      metal: PAINT.steel,
    };
    shaftParts(lift).boxes.forEach((b, i) => {
      const p = paint[b.mat];
      if (i === 0 || !p) {
        return;
      }

      if (b.solid) {
        invisible([b.min, b.max]);
      }

      painted([b.min, b.max], p, false);
    });
  }

  // Match physical window reveals and panes to the facade shader before adding finishes and furnishings.
  const m = t + L;
  const finishRect = { u0: x0 + m, v0: z0 + m, u1: x1 - m, v1: z1 - m };
  const wallPaint = def.paint;
  for (const lv of levels) {
    const lvRng = new Rng(def.seed + 7919 * (lv.k + 2));
    for (const s of sides(def.min, def.max)) {
      const doors =
        lv === ground ? def.doors.filter((d) => d.facing === s.facing) : [];
      const len = s.a1 - s.a0;
      const n = bayCount(len, f.bay);
      const bw = len / n;
      const front = f.street?.[s.facing];
      const la = s.a0 + (s.axis === 0 ? m : t);
      const lb = s.a1 - (s.axis === 0 ? m : t);
      for (let k = 0; k < n; k++) {
        const b0 = s.a0 + k * bw;
        const b1 = b0 + bw;
        // Lobby doors are cut from the larger glazed opening instead of replacing a window.
        const door =
          front === 'lobby'
            ? undefined
            : doors.find((d) => d.at > b0 && d.at < b1);
        const [wx0, wy0, wx1, wy1] =
          lv === ground
            ? frontWindow(front, bw, f.ground)
            : storeyWindow(f.windows, bw, f.storey);
        const base = lv === ground ? y0 : lv.floor;
        const o0 = door ? door.at - door.width / 2 : b0 + wx0;
        const o1 = door ? door.at + door.width / 2 : b0 + wx1;
        const oy0 = door ? lv.floor : Math.max(lv.floor, base + wy0);
        const oy1 = door
          ? lv.floor + door.height
          : Math.min(lv.ceiling, base + wy1);
        const piece = (p: number, q: number, ya: number, yb: number): void => {
          const pa = Math.max(p, la);
          const pb = Math.min(q, lb);
          if (pb - pa > 0.01 && yb - ya > 0.01) {
            painted(
              against(s, pa, pb, ya, yb, I.revealGap, m),
              wallPaint,
              false,
            );
          }
        };

        piece(b0, o0, lv.floor, lv.ceiling);
        piece(o1, b1, lv.floor, lv.ceiling);
        piece(o0, o1, lv.floor, oy0);
        piece(o0, o1, oy1, lv.ceiling);

        if (!door && o0 > la && o1 < lb && oy1 > oy0) {
          // Split the pane around any doorway within this bay.
          const pane = (
            p: number,
            q: number,
            ya: number,
            yb: number,
          ): void => {
            if (q - p < 0.01 || yb - ya < 0.01) {
              return;
            }

            const b = against(
              s,
              p,
              q,
              ya,
              yb,
              I.pane.inset,
              I.pane.inset + I.pane.thick,
            );
            panes.push({ min: b[0], max: b[1], mat: 'glass', solid: false });
          };

          const gap = doors.find((d) => d.at > b0 && d.at < b1);
          if (!gap) {
            pane(o0, o1, oy0, oy1);
          } else {
            const g0 = gap.at - gap.width / 2;
            const g1 = gap.at + gap.width / 2;
            pane(o0, g0, oy0, oy1);
            pane(g1, o1, oy0, oy1);
            pane(g0, g1, lv.floor + gap.height, oy1);
          }
        }
      }
    }

    // Keep floor and ceiling finishes inside the linings and clear of the shaft.
    const floorPaint =
      def.use === 'diner' && lv === ground
        ? PAINT.dinerFloor
        : lvRng.pick(PAINT.floors);
    for (const r of subtractRects(finishRect, shaftHole)) {
      painted(
        [
          [r.u0, lv.floor, r.v0],
          [r.u1, lv.floor + I.finish, r.v1],
        ],
        floorPaint,
        false,
        def.use === 'diner' && lv === ground ? 'awning' : 'room',
      );
      painted(
        [
          [r.u0, lv.ceiling - I.finish, r.v0],
          [r.u1, lv.ceiling, r.v1],
        ],
        PAINT.ceiling,
        false,
      );
    }

    furnishLevel(def, lv, lv === ground, lift, lvRng, painted, rooms);
  }

  return {
    def,
    shell,
    rooms,
    panes,
    lift,
    floor: ground.floor,
    ceiling: ground.ceiling,
    top: last === ground ? y0 + f.ground : last.floor + f.storey,
  };

  /**
   * Append floor partitions, furnishings, lamps, and a ground-floor stair
   * placeholder, reserving entrance and elevator clearances.
   */
  function furnishLevel(
    def: BuildingDef,
    lv: Level,
    isGround: boolean,
    lift: ElevatorDef | null,
    rng: Rng,
    paintBox: (
      b: [V3, V3],
      paint: string,
      solid: boolean,
      kind?: FacadeDef['kind'],
    ) => void,
    out: BoxDef[],
  ): void {
    const main = def.doors[0];
    if (!main) {
      return;
    }

    const r = roomFrame(def.min, def.max, main.facing);
    const { W, D } = r;
    const y = lv.floor + I.finish;
    const head = lv.ceiling - I.finish;
    const coreL = def.core ? r.local(def.core.rect) : null;
    // Reserve entrance approaches, the core footprint, and elevator landing before placing fittings.
    const clear: [number, number, number, number][] = isGround
      ? doorZones(def.min, def.max, def.doors)
      : [];
    if (def.core) {
      clear.push(def.core.rect);
    }

    if (lift && coreL) {
      const mid = (coreL[0] + coreL[1]) / 2;
      const half = I.liftDoor / 2 + I.landing.side;
      const [lo, hi] = r.box(
        mid - half,
        mid + half,
        coreL[2] - I.landing.depth,
        coreL[2],
        0,
        0,
      );
      clear.push([lo[0], lo[2], hi[0], hi[2]]);
    }

    const free = ([lo, hi]: [V3, V3]): boolean =>
      !clear.some(
        ([a, b, c, e]) => lo[0] < c && hi[0] > a && lo[2] < e && hi[2] > b,
      );
    /**
     * Append a fitting in room coordinates with heights relative to the
     * finished floor. Return false for invalid bounds, placement outside the
     * room, or overlap with a reserved circulation area.
     */
    const fit = (
      a0: number,
      a1: number,
      d0: number,
      d1: number,
      ya: number,
      yb: number,
      paint: string,
      solid = true,
    ): boolean => {
      if (a1 <= a0 || d1 <= d0 || a0 < 0 || a1 > W || d0 < 0 || d1 > D) {
        return false;
      }

      const b = r.box(a0, a1, d0, d1, y + ya, y + yb);
      if (!free(b)) {
        return false;
      }

      paintBox(b, paint, solid);
      return true;
    };

    const lamp = (a: number, d: number): void => {
      const [lx, lz, lt] = I.lamp;
      const b = r.box(
        a - lx / 2,
        a + lx / 2,
        d - lz / 2,
        d + lz / 2,
        head - I.lampDrop - lt,
        head - I.lampDrop,
      );
      if (
        coreL &&
        a + lx / 2 > coreL[0] &&
        a - lx / 2 < coreL[1] &&
        d + lz / 2 > coreL[2] &&
        d - lz / 2 < coreL[3]
      ) {
        return;
      }

      out.push({ min: b[0], max: b[1], mat: 'lampWarm', solid: false });
    };

    /**
     * Append a solid partition with doorway centres at `gaps` along its longer
     * axis, clipping openings to the partition extent.
     */
    const wall = (
      a0: number,
      a1: number,
      d0: number,
      d1: number,
      gaps: readonly number[],
    ): void => {
      const alongA = a1 - a0 > d1 - d0;
      const [s0, s1] = alongA ? [a0, a1] : [d0, d1];
      let at = s0;
      const seg = (p: number, q: number, ya: number, yb: number): void => {
        if (q - p < 0.01) {
          return;
        }

        const b = alongA
          ? r.box(p, q, d0, d1, ya, yb)
          : r.box(a0, a1, p, q, ya, yb);
        paintBox(b, def.paint, true);
      };

      for (const g of [...gaps].sort((p, q) => p - q)) {
        const g0 = Math.max(s0, g - P.door / 2);
        const g1 = Math.min(s1, g + P.door / 2);
        seg(at, g0, y, head);
        seg(g0, g1, y + P.top, head);
        at = g1;
      }

      seg(at, s1, y, head);
    };

    // Divide each floor into a shared hub and adjoining rooms.
    const smalls: Room[] = [];
    let hub: [number, number, number, number] = [0, W, 0, D];
    const kinds = isGround ? BACK_ROOMS[def.use] : UPPER_ROOMS;
    if (isGround && D >= I.back.from) {
      // Place ground-floor rooms behind the hub on either side of the core.
      const bd = coreL
        ? D - coreL[2]
        : Math.min(I.back.max, Math.max(I.back.min, D * I.back.share));
      const d0 = D - bd;
      // End the hub at the front wall of the rear rooms.
      hub = [0, W, 0, d0 - P.thick];
      const segs: [number, number][] = coreL
        ? [
            [0, coreL[0]],
            [coreL[1], W],
          ]
        : [[0, W]];
      let n = 0;
      for (const [s0, s1] of segs) {
        const w = s1 - s0;
        if (w < I.room.min) {
          continue;
        }

        const split = w >= 2 * I.room.min + P.thick && rng.chance(0.5) ? 2 : 1;
        for (let j = 0; j < split; j++) {
          const a0 = s0 + (j * w) / split;
          const a1 = s0 + ((j + 1) * w) / split;
          smalls.push({
            kind: kinds[n++ % kinds.length] as RoomKind,
            a0,
            a1,
            d0,
            d1: D,
            door: 'd0',
            at: (a0 + a1) / 2,
          });
        }
      }

      // Leave doorway openings in the front wall and separate adjacent rooms.
      for (const [s0, s1] of segs) {
        const these = smalls.filter(
          (q) => q.a0 >= s0 - 1e-6 && q.a1 <= s1 + 1e-6,
        );
        if (!these.length) {
          continue;
        }

        wall(
          s0,
          s1,
          d0 - P.thick,
          d0,
          these.map((q) => q.at),
        );

        for (const q of these.slice(1)) {
          wall(q.a0 - P.thick / 2, q.a0 + P.thick / 2, d0, D, []);
        }
      }
    } else if (!isGround && coreL) {
      // Connect upper-floor windows to the elevator with a corridor between two room rows.
      let h0 = Math.max(0, coreL[0] - I.corridor);
      let h1 = Math.min(W, coreL[1] + I.corridor);
      if (h0 < I.room.min) {
        h0 = 0;
      }

      if (W - h1 < I.room.min) {
        h1 = W;
      }

      hub = [h0, h1, 0, D];
      // Keep each room entrance ahead of the core so it opens into the corridor.
      const doorLimit = coreL[2] - I.landing.side;
      for (const [z0, z1, side] of [
        [0, h0, 'a1'],
        [h1, W, 'a0'],
      ] as const) {
        if (z1 - z0 < I.room.min) {
          continue;
        }

        const zone: Room[] = [];
        let d = 0;
        while (d < D - 0.01) {
          let end = Math.min(
            D,
            d + rng.range(I.room.depth[0], I.room.depth[1]),
          );
          if (D - end < I.room.min) {
            end = D;
          }

          const at = Math.min((d + end) / 2, doorLimit - P.door / 2);
          const prev = zone[zone.length - 1];
          // Merge with the preceding room when the new doorway cannot fit before the core.
          if (at - P.door / 2 < d + 0.2 && prev) {
            prev.d1 = end;
          } else {
            zone.push({
              kind: rng.pick(kinds),
              a0: z0,
              a1: z1,
              d0: d,
              d1: end,
              door: side,
              at,
            });
          }

          d = end;
        }

        smalls.push(...zone);
        const wa = side === 'a1' ? h0 - P.thick : h1;
        wall(
          wa,
          wa + P.thick,
          0,
          D,
          zone.map((q) => q.at),
        );
        const [ra0, ra1] =
          side === 'a1' ? [0, h0 - P.thick] : [h1 + P.thick, W];
        for (const q of zone.slice(1)) {
          wall(ra0, ra1, q.d0 - P.thick / 2, q.d0 + P.thick / 2, []);
        }
      }
    }

    // Reserve clearance on both sides of each interior doorway.
    for (const q of smalls) {
      const half = P.door / 2 + I.doorway.side;
      const zone =
        q.door === 'd0'
          ? r.box(
              q.at - half,
              q.at + half,
              q.d0 - I.doorway.depth,
              q.d0 + I.doorway.depth,
              0,
              0,
            )
          : r.box(
              q.door === 'a1'
                ? q.a1 - I.doorway.depth
                : q.a0 - I.doorway.depth,
              q.door === 'a1'
                ? q.a1 + I.doorway.depth
                : q.a0 + I.doorway.depth,
              q.at - half,
              q.at + half,
              0,
              0,
            );
      clear.push([zone[0][0], zone[0][2], zone[1][0], zone[1][2]]);
    }

    // Light the hub with a regular grid and each room with one fixture.
    const [ha0, ha1, hd0, hd1] = hub;
    const nx = Math.max(1, Math.round((ha1 - ha0) / I.lampEvery));
    const nz = Math.max(1, Math.round((hd1 - hd0) / I.lampEvery));
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < nz; j++) {
        lamp(
          ha0 + ((i + 0.5) * (ha1 - ha0)) / nx,
          hd0 + ((j + 0.5) * (hd1 - hd0)) / nz,
        );
      }
    }

    for (const q of smalls) {
      lamp((q.a0 + q.a1) / 2, (q.d0 + q.d1) / 2);
    }

    // the hub's fittings
    const hubFit = (
      a0: number,
      a1: number,
      d0: number,
      d1: number,
      ya: number,
      yb: number,
      paint: string,
      solid = true,
    ): boolean =>
      d1 <= hd1 && a0 >= ha0 && a1 <= ha1
        ? fit(a0, a1, d0, d1, ya, yb, paint, solid)
        : false;
    const HD = hd1;
    if (!isGround) {
      // a bench and a plant by the corridor's windows
      hubFit(ha0 + 0.2, ha0 + 0.7, 0.6, 2.0, 0, 0.45, PAINT.wood);

      if (hubFit(ha1 - 0.9, ha1 - 0.2, 0.3, 1.0, 0, 0.5, PAINT.stone)) {
        hubFit(ha1 - 0.8, ha1 - 0.3, 0.4, 0.9, 0.5, 1.5, PAINT.plant, false);
      }
    } else {
      switch (def.use) {
        case 'shop': {
          // shelves along the back, a counter with a till, a gondola down the middle
          hubFit(0.3, W - 0.3, HD - 0.55, HD, 0, 2.1, PAINT.steel);
          const cd = HD * 0.45;
          if (hubFit(W * 0.55, W - 0.5, cd, cd + 0.7, 0, 1.0, PAINT.wood)) {
            hubFit(
              W * 0.55 + 0.3,
              W * 0.55 + 0.7,
              cd + 0.15,
              cd + 0.55,
              1.0,
              1.3,
              PAINT.dark,
              false,
            );
          }

          if (HD > 5) {
            hubFit(
              0.6,
              W * 0.45,
              HD * 0.25,
              HD * 0.25 + 0.9,
              0,
              1.4,
              PAINT.steel,
            );
          }

          break;
        }

        case 'diner': {
          // a counter with stools, booths along the front windows
          const cd = HD * 0.62;
          if (hubFit(0.6, W - 1.4, cd, cd + 0.7, 0, 1.05, PAINT.wood)) {
            hubFit(
              0.5,
              W - 1.3,
              cd - 0.1,
              cd + 0.75,
              1.05,
              1.1,
              PAINT.counter,
              false,
            );

            for (let s = 1.0; s < W - 1.8; s += 0.9) {
              hubFit(
                s - 0.18,
                s + 0.18,
                cd - 0.6,
                cd - 0.24,
                0,
                0.75,
                PAINT.booth,
                false,
              );
            }
          }

          for (let c = 1.3; c < W - 1.2; c += 2.6) {
            if (
              !hubFit(c - 0.35, c + 0.35, 0.5, 1.3, 0, 0.75, PAINT.counter)
            ) {
              continue;
            }

            hubFit(c - 1.0, c - 0.55, 0.4, 1.4, 0, 0.5, PAINT.booth);
            hubFit(c + 0.55, c + 1.0, 0.4, 1.4, 0, 0.5, PAINT.booth);
            hubFit(c - 1.0, c - 0.85, 0.4, 1.4, 0.5, 1.15, PAINT.booth, false);
            hubFit(c + 0.85, c + 1.0, 0.4, 1.4, 0.5, 1.15, PAINT.booth, false);
          }

          break;
        }

        case 'lobby': {
          // a reception desk, two pillars, a bench, a planter
          hubFit(
            W * 0.35,
            W * 0.65,
            HD * 0.5,
            HD * 0.5 + 0.8,
            0,
            1.1,
            PAINT.wood,
          );

          for (const pa of [W * 0.25, W * 0.75]) {
            hubFit(
              pa - 0.25,
              pa + 0.25,
              HD * 0.3,
              HD * 0.3 + 0.5,
              0,
              head - y,
              PAINT.stone,
            );
          }

          hubFit(0.3, 0.8, HD * 0.3, HD * 0.3 + 1.8, 0, 0.45, PAINT.wood);

          if (
            hubFit(W - 1.2, W - 0.4, HD - 1.2, HD - 0.4, 0, 0.6, PAINT.stone)
          ) {
            hubFit(
              W - 1.1,
              W - 0.5,
              HD - 1.1,
              HD - 0.5,
              0.6,
              1.7,
              PAINT.plant,
              false,
            );
          }

          break;
        }

        case 'hall': {
          // mailboxes on a side wall, a bench, a rug
          hubFit(0.05, 0.4, 1.4, 2.6, 0.7, 1.7, PAINT.steel);
          hubFit(
            W - 0.6,
            W - 0.1,
            HD * 0.5,
            HD * 0.5 + 1.4,
            0,
            0.45,
            PAINT.wood,
          );
          hubFit(
            W * 0.3,
            W * 0.7,
            2.2,
            Math.min(HD - 1, 5),
            0,
            0.01,
            rng.pick(PAINT.walls),
            false,
          );
          break;
        }
      }
    }

    // Furnish rooms in local coordinates: u follows the doorway wall and v points into the room.
    for (const q of smalls) {
      const U = q.door === 'd0' ? q.a1 - q.a0 : q.d1 - q.d0;
      const V = q.door === 'd0' ? q.d1 - q.d0 : q.a1 - q.a0;
      const put = (
        u0: number,
        u1: number,
        v0: number,
        v1: number,
        ya: number,
        yb: number,
        paint: string,
        solid = true,
      ): boolean => {
        if (u0 < 0 || u1 > U || v0 < 0 || v1 > V) {
          return false;
        }

        if (q.door === 'd0') {
          return fit(
            q.a0 + u0,
            q.a0 + u1,
            q.d0 + v0,
            q.d0 + v1,
            ya,
            yb,
            paint,
            solid,
          );
        }

        if (q.door === 'a1') {
          return fit(
            q.a1 - v1,
            q.a1 - v0,
            q.d0 + u0,
            q.d0 + u1,
            ya,
            yb,
            paint,
            solid,
          );
        }

        return fit(
          q.a0 + v0,
          q.a0 + v1,
          q.d0 + u0,
          q.d0 + u1,
          ya,
          yb,
          paint,
          solid,
        );
      };

      switch (q.kind) {
        case 'office':
          put(U / 2 - 0.7, U / 2 + 0.7, V - 1.0, V - 0.3, 0, 0.75, PAINT.wood);
          put(
            U / 2 - 0.25,
            U / 2 + 0.25,
            V - 1.6,
            V - 1.1,
            0,
            0.9,
            PAINT.dark,
            false,
          );
          put(0.1, 0.6, V - 0.7, V - 0.1, 0, 1.3, PAINT.steel);

          if (put(U - 0.6, U - 0.1, V - 0.6, V - 0.1, 0, 0.4, PAINT.stone)) {
            put(
              U - 0.55,
              U - 0.15,
              V - 0.55,
              V - 0.15,
              0.4,
              1.2,
              PAINT.plant,
              false,
            );
          }

          break;
        case 'meeting':
          if (put(0.8, U - 0.8, 1.9, V - 0.7, 0, 0.75, PAINT.wood)) {
            for (let u = 1.2; u < U - 1.2; u += 0.9) {
              put(u - 0.2, u + 0.2, 1.4, 1.8, 0, 0.85, PAINT.dark, false);
              put(
                u - 0.2,
                u + 0.2,
                V - 0.6,
                V - 0.2,
                0,
                0.85,
                PAINT.dark,
                false,
              );
            }
          }

          break;
        case 'storage':
          put(0.2, U - 0.2, V - 0.5, V, 0, 2.0, PAINT.steel);
          put(0, 0.5, 1.9, V - 0.6, 0, 2.0, PAINT.steel);

          if (put(U - 1.0, U - 0.2, 1.9, 2.7, 0, 0.8, PAINT.crate)) {
            put(U - 0.9, U - 0.3, 2.0, 2.6, 0.8, 1.4, PAINT.crate, false);
          }

          break;
        case 'restroom':
          for (const u of [U / 3, (2 * U) / 3]) {
            put(u - 0.04, u + 0.04, V - 1.5, V, 0, 1.8, PAINT.counter);
          }

          put(0.1, U - 0.1, 1.9, 2.4, 0.8, 0.9, PAINT.steel, false);
          break;
        case 'kitchen':
          put(0.2, U / 2 - 0.45, V - 0.6, V, 0, 0.9, PAINT.steel);
          put(U / 2 - 0.45, U / 2 + 0.45, V - 0.65, V, 0, 0.95, PAINT.dark);
          put(U / 2 + 0.45, U - 0.9, V - 0.6, V, 0, 0.9, PAINT.steel);
          put(U - 0.85, U - 0.1, V - 0.75, V - 0.05, 0, 1.9, PAINT.steel);
          break;
        case 'mail':
          put(0, 0.35, 1.9, V - 0.4, 0.6, 1.8, PAINT.steel);
          put(U / 2 - 0.6, U / 2 + 0.6, V - 1.2, V - 0.5, 0, 0.8, PAINT.wood);
          break;
      }
    }

    // Represent the stair core as a closed solid with a decorative door plate.
    if (isGround && def.core && def.core.kind === 'stair') {
      const [cx0, cz0, cx1, cz1] = def.core.rect;
      paintBox(
        [
          [cx0, y, cz0],
          [cx1, head, cz1],
        ],
        PAINT.core,
        true,
      );
      const Pl = I.plate;
      const fa = main.facing;
      const mid =
        fa === 'z+' || fa === 'z-' ? (cx0 + cx1) / 2 : (cz0 + cz1) / 2;
      const face =
        fa === 'z+' ? cz1 : fa === 'z-' ? cz0 : fa === 'x+' ? cx1 : cx0;
      const out = fa === 'z+' || fa === 'x+' ? 1 : -1;
      const plate: [V3, V3] =
        fa === 'z+' || fa === 'z-'
          ? [
              [mid - Pl.w / 2, y, Math.min(face, face + out * Pl.off)],
              [mid + Pl.w / 2, y + Pl.h, Math.max(face, face + out * Pl.off)],
            ]
          : [
              [Math.min(face, face + out * Pl.off), y, mid - Pl.w / 2],
              [Math.max(face, face + out * Pl.off), y + Pl.h, mid + Pl.w / 2],
            ];
      paintBox(plate, PAINT.dark, false);
    }
  }
}
