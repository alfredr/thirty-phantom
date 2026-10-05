import { intersectRects, type Rect } from '@/engine/core/geometry';
import type { V3 } from '@/engine/core/math';
import { BOX_FACES, type BoxFace, faceRect } from '@/render/geometry';

export interface FaceSource {
  min: V3;
  max: V3;
  /** Faces this box actually draws. */
  faces: readonly BoxFace[];
  /** Yield to non-yielding faces so removing a breakable box does not expose a hole in its neighbour. */
  yields: boolean;
}

interface Face {
  box: number;
  face: BoxFace;
  rect: Rect;
  area: number;
  yields: boolean;
}

/** Coordinate quantization step for grouping coplanar faces. */
const PLANE_EPS = 1e-4;

/**
 * Find overlapping same-facing box faces on quantized planes and return rectangular holes keyed by `box * 6 + face`.
 * Yielding faces lose to non-yielding faces; two yielding faces remain intact. Otherwise, remove the overlap from the
 * larger face, breaking equal-area ties by box index. This prevents z-fighting without exposing holes when breakable
 * boxes are removed.
 */
export function coplanarHoles(boxes: readonly FaceSource[]): Map<number, Rect[]> {
  const planes = new Map<string, Face[]>();
  boxes.forEach((b, box) => {
    for (const face of b.faces) {
      const { axis, dir } = BOX_FACES[face];
      const plane = dir > 0 ? b.max[axis] : b.min[axis];
      const rect = faceRect(b.min, b.max, axis);
      const key = `${face}|${Math.round(plane / PLANE_EPS)}`;
      let list = planes.get(key);
      if (!list) {
        planes.set(key, (list = []));
      }

      list.push({ box, face, rect, area: (rect.u1 - rect.u0) * (rect.v1 - rect.v0), yields: b.yields });
    }
  });

  const holes = new Map<number, Rect[]>();
  for (const list of planes.values()) {
    if (list.length < 2) {
      continue;
    }

    list.sort((a, b) => a.rect.u0 - b.rect.u0);

    for (let i = 0; i < list.length; i++) {
      const a = list[i] as Face;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j] as Face;
        if (b.rect.u0 >= a.rect.u1) {
          break;
        }

        const r = intersectRects(a.rect, b.rect);
        if (r.u1 - r.u0 < PLANE_EPS || r.v1 - r.v0 < PLANE_EPS) {
          continue;
        }

        const loser = pickLoser(a, b);
        if (!loser) {
          continue;
        }

        const key = loser.box * 6 + loser.face;
        let h = holes.get(key);
        if (!h) {
          holes.set(key, (h = []));
        }

        h.push(r);
      }
    }
  }

  return holes;
}

/** The face that gets the overlap cut out, or null to leave both (two breakables). */
function pickLoser(a: Face, b: Face): Face | null {
  if (a.yields !== b.yields) {
    return a.yields ? a : b;
  }

  if (a.yields) {
    return null;
  }

  if (a.area !== b.area) {
    return a.area > b.area ? a : b;
  }

  return a.box > b.box ? a : b;
}
