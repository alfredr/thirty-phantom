import { clamp } from '../engine/core/math';
import type { BoxFace, FaceMap } from '../render/geometry';
import type { MatKey } from '../render/materials';
import type { BoxDef, FacadeDef, FacadeKind, Facing, StreetFront, WindowStyle } from './level-data';

/**
 * Facade layout shared by the generators (which put doors, awnings and
 * balconies on the bays and storeys) and the renderer (which hands each face
 * its bays and storeys for the facade shader, render/facade.ts).
 */
export const FACADE = {
  /** Storey height above the ground floor (m). */
  storey: 3.2,
  /** Ground floor height from the box's base (m): the sidewalk's 0.2 and a tall shop storey. */
  ground: 4.4,
  /** Bay width a face aims for (m). */
  bay: 3,
  /** Blank wall under the top (m), where the cornice goes. */
  cap: 0.9,
  windows: 'punched' as WindowStyle,
  /** Rooms behind the windows are this deep (m); shops and lobbies run deeper. */
  room: 4,
  /**
   * Ground floor openings, shared by the shader's painted fronts and a walk-in
   * building's real ones (world/interiors.ts), in metres within a bay.
   */
  front: {
    /** Shop windows: side frames, the bulkhead under the glass, the sign fascia over it (down from the ground floor's top). */
    shop: { frame: 0.12, bulkhead: 0.7, fascia: 1.0 },
    /** Lobby glass: mullions at the bay edges; its top, down from the ground floor's top. */
    lobby: { mullion: 0.06, head: 0.6 },
    /** Plain ground floors and entries: the pier as a share of the bay (and its limits), a raised sill, the head (down from the top). */
    plain: { pier: 0.22, pierMin: 0.4, pierMax: 0.9, sill: 1.3, head: 0.8 },
    /** Doorways: a leaf's width (lobbies have two; wide enough that the 0.5 m nav grid always fits a person through), their top; the floor inside is the sidewalk's height. */
    door: 1.5,
    doorTop: 2.6,
    floor: 0.2,
  },
  /**
   * Upper storeys' windows, by style (punched, ribbon, paired, grid): sill and
   * head (down from the storey above); a punched window's pier as a share of
   * the bay and its limits; ribbon and grid mullions; a paired window's outer
   * pier and the mullion between its two lights.
   */
  glazing: {
    sill: [0.9, 1.0, 0.6, 0.9] as const,
    head: [0.55, 0.3, 0.45, 0.04] as const,
    pier: { share: 0.22, min: 0.4, max: 0.9 },
    mullion: 0.06,
    pairPier: 0.35,
    pairMullion: 0.16,
  },
};

/** A ground floor bay's window under a street front (or none): lo x, lo y, hi x, hi y in metres from the bay's bottom left. */
export function frontWindow(front: StreetFront | undefined, bay: number, ground: number): [number, number, number, number] {
  const F = FACADE.front;
  if (front === 'shop') return [F.shop.frame, F.shop.bulkhead, bay - F.shop.frame, ground - F.shop.fascia];
  if (front === 'lobby') return [F.lobby.mullion, F.floor, bay - F.lobby.mullion, ground - F.lobby.head];
  const pier = clamp(bay * F.plain.pier, F.plain.pierMin, F.plain.pierMax);
  return [pier, F.plain.sill, bay - pier, ground - F.plain.head];
}

const STYLE_INDEX: Readonly<Record<WindowStyle, 0 | 1 | 2 | 3>> = { punched: 0, ribbon: 1, paired: 2, grid: 3 };

/** An upper storey's window in a bay `bay` wide: lo x, lo y, hi x, hi y in metres from the bay's bottom left (the storey's floor line). */
export function storeyWindow(style: WindowStyle, bay: number, storey: number): [number, number, number, number] {
  const G = FACADE.glazing;
  const i = STYLE_INDEX[style];
  const side = style === 'punched' ? clamp(bay * G.pier.share, G.pier.min, G.pier.max) : style === 'paired' ? G.pairPier : G.mullion;
  return [side, G.sill[i], bay - side, storey - G.head[i]];
}

/** How wide a street front's doorway is (centred in its door bay). */
export function doorWidth(front: StreetFront): number {
  return front === 'lobby' ? 2 * FACADE.front.door : FACADE.front.door;
}

/** A FacadeDef with every field filled in. */
export type Facade = Required<Omit<FacadeDef, 'paint' | 'street'>> & Pick<FacadeDef, 'paint' | 'street'>;

/** The facade materials: one shader, their own paint for boxes that don't name one (the old textures' wall colors). */
export const FACADE_PAINT: Readonly<Partial<Record<MatKey, string>>> = {
  facadeA: '#4a4258',
  facadeB: '#3c3550',
  facadeC: '#5a5368',
};

export function isFacade(mat: MatKey): boolean {
  return FACADE_PAINT[mat] !== undefined;
}

/** A facade box's layout: its FacadeDef with defaults filled in, or null for other materials. */
export function facadeOf(b: BoxDef): Facade | null {
  if (!isFacade(b.mat)) return null;
  const f = b.facade;
  return {
    kind: f?.kind ?? 'wall',
    storey: f?.storey ?? FACADE.storey,
    ground: f?.ground ?? FACADE.ground,
    bay: f?.bay ?? FACADE.bay,
    windows: f?.windows ?? FACADE.windows,
    cap: f?.cap ?? FACADE.cap,
    paint: f?.paint ?? FACADE_PAINT[b.mat],
    street: f?.street,
  };
}

/** Whole bays across a face `len` long, aiming for `bay` wide. */
export function bayCount(len: number, bay: number): number {
  return Math.max(1, Math.round(len / bay));
}

/** Storeys of windows above the ground floor of a wall `height` tall (from its base to its top). */
export function storeyCount(f: Facade, height: number): number {
  return Math.max(0, Math.floor((height - f.ground - f.cap) / f.storey));
}

/** The bay a street front's door is in: the middle one (left of middle for an even count). */
export function doorBay(bays: number): number {
  return Math.floor((bays - 1) / 2);
}

/** Box faces by the way they look (vertical faces only). */
export const FACE_FACING: Readonly<Record<0 | 1 | 2 | 3, Facing>> = { 0: 'x+', 1: 'x-', 2: 'z+', 3: 'z-' };

/**
 * A vertical face's extent along the wall, in the batch's UV convention
 * (GeometryBatch.quad: u runs along x on z faces and along z on x faces, signed
 * so it increases left to right seen from outside): its u at the left edge, and its length.
 */
export function faceSpan(min: readonly number[], max: readonly number[], face: 0 | 1 | 2 | 3): { u0: number; len: number } {
  const [x0, , z0] = min as [number, number, number];
  const [x1, , z1] = max as [number, number, number];
  switch (face) {
    case 0:
      return { u0: -z1, len: z1 - z0 };
    case 1:
      return { u0: z0, len: z1 - z0 };
    case 2:
      return { u0: x0, len: x1 - x0 };
    case 3:
      return { u0: -x1, len: x1 - x0 };
  }
}

/** A room's surfaces are trim with style 1 (lit). */
const KIND_CODE: Readonly<Record<FacadeKind, number>> = { wall: 1, trim: 2, awning: 3, room: 2 };
const WINDOW_CODE: Readonly<Record<WindowStyle, number>> = { punched: 0, ribbon: 1, paired: 2, grid: 3 };
const STREET_CODE: Readonly<Record<StreetFront, number>> = { shop: 1, lobby: 2, entry: 3 };

/**
 * What the facade shader reads from a face's FACE_DATA w, packed into one
 * float (exact well past these ranges): kind + 4 style + 16 street + 64 storeys
 * + 4096 (door bay + 1). For an awning, style is the axis its stripes run across (0 x, 1 z);
 * for trim, 1 is a room's surface (lit at night).
 */
export const FACE_CODE = { style: 4, street: 16, storeys: 64, door: 4096 };

/**
 * The FaceMap for each face of a facade box: walls get UVs in bays (u, from
 * the face's left edge) and storeys (v, from the top of the ground floor), and
 * FACE_DATA (bay width, storey height, ground floor height, code); trim and
 * awnings only need their code. Undefined for faces the shader leaves plain.
 */
export function facadeFaces(b: BoxDef, f: Facade): (face: BoxFace) => FaceMap | undefined {
  const height = b.max[1] - b.min[1];
  if (f.kind !== 'wall') {
    const alongX = b.max[0] - b.min[0] >= b.max[2] - b.min[2];
    const style = f.kind === 'room' ? 1 : f.kind === 'awning' && !alongX ? 1 : 0;
    const map: FaceMap = { u0: 0, v0: 0, su: 1, sv: 1, data: [0, 0, 0, KIND_CODE[f.kind] + FACE_CODE.style * style] };
    return () => map;
  }
  const storeys = storeyCount(f, height);
  const maps = ([0, 1, 2, 3] as const).map((face) => {
    const { u0, len } = faceSpan(b.min, b.max, face);
    const bays = bayCount(len, f.bay);
    const width = len / bays;
    const street = f.street?.[FACE_FACING[face]];
    const code =
      KIND_CODE.wall +
      FACE_CODE.style * WINDOW_CODE[f.windows] +
      FACE_CODE.street * (street ? STREET_CODE[street] : 0) +
      FACE_CODE.storeys * Math.min(storeys, FACE_CODE.storeys - 1) +
      FACE_CODE.door * (street ? doorBay(bays) + 1 : 0);
    return { u0, v0: b.min[1] + f.ground, su: width, sv: f.storey, data: [width, f.storey, f.ground, code] } satisfies FaceMap;
  });
  return (face) => (face < 4 ? maps[face] : undefined);
}
