import type { MatKey } from '@/render/materials';

import type { ElevatorDef, Facing, V3 } from './level-data';
import type { LevelWriter } from './level-writer';

/**
 * Dimensions shared by static shaft generation, runtime cabins and doors in world/elevators.ts, and navigation links in
 * world/nav-grid.ts. Distances are in meters.
 */
export const LIFT = {
  /** Shaft walls. */
  wall: 0.3,
  /** Landing doors are this tall. */
  doorTop: 2.2,
  /** The shaft rises this far above each stop's floor: the door, its lintel and room over the cab. */
  head: 2.9,
  /** The cab: inside height and floor slab thickness (its floor's top is the stop's floor). */
  cabHeight: 2.4,
  floor: 0.25,
  /** Pit below the lowest stop, for the cab's floor slab and the buffers; its floor slab's thickness. */
  pit: 1.2,
  slab: 0.3,
  /** The roof over the top of the shaft. */
  roof: 0.3,
  /** Someone waiting for the cab stands this far out from the landing door. */
  landing: 1.0,
  /** Door trim: how far it stands proud of the wall, and how wide it is. */
  trim: 0.05,
  trimWidth: 0.12,
  /** The call button's plate beside each door (along the wall from the door's edge, and up from the floor). */
  plate: { from: 0.25, to: 0.55, y0: 0.95, y1: 1.45 },
  /** The arrival lantern, a bar over the door that lights while the cab is here: its bottom and height above the floor. */
  lantern: { y: 2.33, h: 0.08 },
  /** The ELEVATOR sign over each door: center height above the floor, and size. */
  sign: { y: 2.68, size: [1.5, 0.34] as [number, number] },
};

/** The axis a facing points along (0 = x, 2 = z) and which way along it. */
export function facingAxis(f: Facing): { axis: 0 | 2; sign: 1 | -1 } {
  return { axis: f === 'x+' || f === 'x-' ? 0 : 2, sign: f === 'x+' || f === 'z+' ? 1 : -1 };
}

/** The middle of the shaft's footprint, at height y. */
export function shaftCenter(def: ElevatorDef, y: number, out: V3 = [0, 0, 0]): V3 {
  out[0] = (def.min[0] + def.max[0]) / 2;
  out[1] = y;
  out[2] = (def.min[2] + def.max[2]) / 2;
  return out;
}

/**
 * Write a point on stop i's door centreline into `p` and return it. `out` is the distance from the shaft's inner face,
 * positive outward and negative into the cabin. The point lies at the stop's floor height. Throw if the stop does not
 * exist.
 */
export function doorPoint(def: ElevatorDef, i: number, out: number, p: V3 = [0, 0, 0]): V3 {
  const s = def.stops[i];
  if (!s) {
    throw new Error(`elevator has no stop ${i}`);
  }

  const { axis, sign } = facingAxis(s.facing);
  shaftCenter(def, s.y, p);
  p[axis] = (sign > 0 ? def.max[axis] : def.min[axis]) + sign * out;
  return p;
}

/** Where someone waits for the cab at stop i (and where they step out to). */
export function landingPoint(def: ElevatorDef, i: number, p: V3 = [0, 0, 0]): V3 {
  return doorPoint(def, i, LIFT.wall + LIFT.landing, p);
}

/** A box forming part of the elevator shaft, including structural walls, slabs, trim, or call-button plates. */
export interface ShaftPart {
  min: V3;
  max: V3;
  mat: MatKey;
  /** Collides (walls, the pit's floor, the roof); trim and plates don't. */
  solid: boolean;
}

/** The ELEVATOR sign over a stop's door: its centre and the way it faces. */
export interface ShaftSign {
  pos: V3;
  facing: Facing;
}

/**
 * Generate shaft boxes and sign placements in `def` coordinates. Stops must be ordered from lowest to highest. Include
 * a doorway at each landing, the pit floor, and a roof with a lamp above the top stop. Consumers decide whether to
 * render these parts permanently or with an active interior.
 */
export function shaftParts(def: ElevatorDef): { boxes: ShaftPart[]; signs: ShaftSign[] } {
  const L = LIFT;
  const t = L.wall;
  const { min, max, stops } = def;
  const [ix0, pitFloor, iz0] = min;
  const [ix1, , iz1] = max;
  const ox0 = ix0 - t;
  const oz0 = iz0 - t;
  const ox1 = ix1 + t;
  const oz1 = iz1 + t;
  const base = pitFloor - L.slab;
  const boxes: ShaftPart[] = [];
  const signs: ShaftSign[] = [];
  const box = (m: [V3, V3], mat: MatKey, solid = true): void => {
    boxes.push({ min: m[0], max: m[1], mat, solid });
  };

  // the pit's floor
  box(
    [
      [ix0, base, iz0],
      [ix1, pitFloor, iz1],
    ],
    'concreteDark',
  );

  /** A slab of wall on side f, `a0..a1` along it, standing `d0..d1` out from the shaft's inside face. */
  const onSide = (f: Facing, a0: number, a1: number, y0: number, y1: number, d0: number, d1: number): [V3, V3] => {
    const { axis, sign } = facingAxis(f);
    const face = sign > 0 ? max[axis] : min[axis];
    const c0 = face + sign * d0;
    const c1 = face + sign * d1;
    return axis === 2
      ? [
          [a0, y0, Math.min(c0, c1)],
          [a1, y1, Math.max(c0, c1)],
        ]
      : [
          [Math.min(c0, c1), y0, a0],
          [Math.max(c0, c1), y1, a1],
        ];
  };

  /** Along-the-wall extent of side f: the x sides take the corners. */
  const span = (f: Facing): [number, number] => (facingAxis(f).axis === 0 ? [oz0, oz1] : [ix0, ix1]);
  const SIDES: Facing[] = ['x-', 'x+', 'z-', 'z+'];

  stops.forEach((s, i) => {
    const lo = i === 0 ? base : (stops[i - 1]?.y ?? base) + L.head;
    const hi = s.y + L.head;
    for (const f of SIDES) {
      const [a0, a1] = span(f);
      if (f !== s.facing) {
        box(onSide(f, a0, a1, lo, hi, 0, t), 'concreteDark');
        continue;
      }

      // the doorway: jambs either side, a sill level with the floor below it, the lintel above
      const { axis } = facingAxis(f);
      const mid = (min[axis === 0 ? 2 : 0] + max[axis === 0 ? 2 : 0]) / 2;
      const d0 = mid - def.door / 2;
      const d1 = mid + def.door / 2;
      box(onSide(f, a0, d0, lo, hi, 0, t), 'concreteDark');
      box(onSide(f, d1, a1, lo, hi, 0, t), 'concreteDark');
      box(onSide(f, d0, d1, lo, s.y, 0, t), 'concreteDark');
      box(onSide(f, d0, d1, s.y + L.doorTop, hi, 0, t), 'concreteDark');
      // trim round the door, the call button's plate, the sign over it
      const tw = L.trimWidth;
      box(onSide(f, d0 - tw, d0, s.y, s.y + L.doorTop + tw, t, t + L.trim), 'metal', false);
      box(onSide(f, d1, d1 + tw, s.y, s.y + L.doorTop + tw, t, t + L.trim), 'metal', false);
      box(onSide(f, d0 - tw, d1 + tw, s.y + L.doorTop, s.y + L.doorTop + tw, t, t + L.trim), 'metal', false);
      const P = L.plate;
      box(onSide(f, d1 + P.from, d1 + P.to, s.y + P.y0, s.y + P.y1, t, t + L.trim), 'metal', false);
      const pos = doorPoint(def, i, t + 0.03);
      pos[1] = s.y + L.sign.y;
      signs.push({ pos, facing: f });
    }
  });

  // the roof, over the top stop
  const top = stops[stops.length - 1];
  if (top) {
    const y = top.y + L.head;
    box(
      [
        [ox0, y, oz0],
        [ox1, y + L.roof, oz1],
      ],
      'roof',
    );
    const [cx, , cz] = shaftCenter(def, y);
    box(
      [
        [cx - 0.5, y + L.roof, cz - 0.15],
        [cx + 0.5, y + L.roof + 0.12, cz + 0.15],
      ],
      'lampGreen',
      false,
    );
  }

  return { boxes, signs };
}

/**
 * Append shaft geometry, signs, and the elevator definition in the writer's coordinate frame. Add a pit cutout when the
 * definition's pit floor is below local Y=0.
 */
export function writeElevator(w: LevelWriter, def: ElevatorDef): void {
  const { boxes, signs } = shaftParts(def);
  for (const b of boxes) {
    w.box(b.min, b.max, b.mat, b.solid ? {} : { solid: false });
  }

  for (const s of signs) {
    w.sign(s.pos, LIFT.sign.size, s.facing, 'neonPurple', ['ELEVATOR']);
  }

  // Remove ground beneath the shaft and its surrounding walls when the pit is below street level.
  const [ix0, pitFloor, iz0] = def.min;
  const [ix1, , iz1] = def.max;
  const t = LIFT.wall;
  if (pitFloor < 0) {
    w.data.pits.push({ min: w.p([ix0 - t, pitFloor - LIFT.slab, iz0 - t]), max: w.p([ix1 + t, 0, iz1 + t]) });
  }

  w.data.elevators.push({
    ...def,
    min: w.p(def.min),
    max: w.p(def.max),
    stops: def.stops.map((s) => ({ ...s, y: w.p([0, s.y, 0])[1] })),
  });
}
