import type { V3 } from '@/engine/core/math';
import { BOX_FACES, type BoxFace, faceRect, type FaceRect, intersectRects } from '@/render/geometry';

export interface FaceSource {
  min: V3;
  max: V3;
  /** Faces this box actually draws. */
  faces: readonly BoxFace[];
  /** Always gives way in an overlap (breakables: smashing one must not open a hole in its neighbour). */
  yields: boolean;
}

interface Face {
  box: number;
  face: BoxFace;
  rect: FaceRect;
  area: number;
  yields: boolean;
}

/** Faces closer than this count as coplanar. */
const PLANE_EPS = 1e-4;

/**
 * Same-facing faces of different boxes in one plane z-fight: each draws its
 * own texture, tint and AO gradient there (columns flush with walls, slab
 * edges flush with parapets, cubes snapped together in Blender). For every
 * such overlap the smaller face keeps it and the larger one gets it cut out.
 *
 * Returns the holes per face, keyed `box * 6 + face`.
 */
export function coplanarHoles(boxes: readonly FaceSource[]): Map<number, FaceRect[]> {
  const planes = new Map<string, Face[]>();
  boxes.forEach((b, box) => {
    for (const face of b.faces) {
      const { axis, dir } = BOX_FACES[face];
      const plane = dir > 0 ? b.max[axis] : b.min[axis];
      const rect = faceRect(b.min, b.max, axis);
      const key = `${face}|${Math.round(plane / PLANE_EPS)}`;
      let list = planes.get(key);
      if (!list) planes.set(key, (list = []));
      list.push({ box, face, rect, area: (rect.u1 - rect.u0) * (rect.v1 - rect.v0), yields: b.yields });
    }
  });

  const holes = new Map<number, FaceRect[]>();
  for (const list of planes.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.rect.u0 - b.rect.u0);
    for (let i = 0; i < list.length; i++) {
      const a = list[i] as Face;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j] as Face;
        if (b.rect.u0 >= a.rect.u1) break;
        const r = intersectRects(a.rect, b.rect);
        if (r.u1 - r.u0 < PLANE_EPS || r.v1 - r.v0 < PLANE_EPS) continue;
        const loser = pickLoser(a, b);
        if (!loser) continue;
        const key = loser.box * 6 + loser.face;
        let h = holes.get(key);
        if (!h) holes.set(key, (h = []));
        h.push(r);
      }
    }
  }
  return holes;
}

/** The face that gets the overlap cut out, or null to leave both (two breakables). */
function pickLoser(a: Face, b: Face): Face | null {
  if (a.yields !== b.yields) return a.yields ? a : b;
  if (a.yields) return null;
  if (a.area !== b.area) return a.area > b.area ? a : b;
  return a.box > b.box ? a : b;
}
