import type { Color } from 'three';

import type { V3 } from '@/engine/core/math';
import type { Rng } from '@/engine/core/rng';
import type { GeometryBatch } from '@/render/geometry';

/** Geometry queries required to place slime lips, drips, and landing pools. */
export interface DripWorld {
  /** Visible geometry at a point. */
  occupied(x: number, y: number, z: number): boolean;
  /** Boxes slime must not cut through (signs). */
  blocked(min: V3, max: V3): boolean;
  /**
   * Return the landing height and receiving pool for a drop at (x, y, z). Pool
   * placement uses (px, pz); return pool -1 for surfaces that cannot support a
   * puddle.
   */
  land(
    x: number,
    y: number,
    z: number,
    px: number,
    pz: number,
  ): { y: number; pool: number };
  /** A fresh id for a run of underside slime. */
  run(): number;
}

/** Underside slime volume that drains into the drips assigned to its run. */
export interface FilmSpec {
  min: V3;
  max: V3;
  /** Height of the lower edge toward which the film contracts. */
  edge: number;
  run: number;
}

/**
 * One drip hanging from an edge lip. The lip feeds it slowly; the runtime sim
 * (slime.ts) swells and stretches it within the limits set here.
 */
export interface DripSpec {
  /**
   * Edge direction (the drip's width runs along it) and outward sign on the
   * other axis.
   */
  axis: 'x' | 'z';
  out: 1 | -1;
  /** Position along the edge, and the face's coordinate on the other axis. */
  along: number;
  face: number;
  top: number;
  w: number;
  /** Maximum wall-supported strand length, in meters. */
  reach: number;
  /**
   * Maximum nominal unsupported length in meters; zero keeps the drip on the
   * wall.
   */
  hang: number;
  /** Whether a full hanging bulb detaches as a falling drop. */
  drops: boolean;
  /** Where its drops land, and the puddle they feed (-1 for none). */
  landY: number;
  pool: number;
  /** The underside run it collects from, or -1 when its lip feeds it. */
  run: number;
}

/**
 * Bulb dimensions depend on drip width and fill fraction. Free bulbs stretch
 * and bulge more than wall-supported bulbs. `below` is the fraction of bulb
 * height extending below the strand endpoint.
 */
export const BULB = {
  base: 1.05,
  grow: 0.85,
  stretchWall: 0.15,
  stretchFree: 0.45,
  depth: 0.13,
  bulge: 0.3,
  below: 0.6,
};

function bulbSize(
  w: number,
  f: number,
  free: boolean,
): { across: number; tall: number; depth: number } {
  const across = w * (BULB.base + BULB.grow * f);
  return {
    across,
    tall: across * (1 + (free ? BULB.stretchFree : BULB.stretchWall) * f),
    depth: BULB.depth + (free ? BULB.bulge * across * f : 0),
  };
}

/** How far a full bulb reaches below its strand's end. */
const bulbBelow = (w: number, free: boolean): number =>
  bulbSize(w, 1, free).tall * BULB.below;

/** How far a drip's column is scanned per step (m). */
const STEP = 0.05;

interface Edge {
  a0: number;
  a1: number;
  axis: 'x' | 'z';
  /** fixed coordinate on the other horizontal axis */
  fixed: number;
  /** outward sign on that axis */
  out: 1 | -1;
}

/**
 * Choose a drip length in meters, favouring short drips with less frequent
 * medium and long drips.
 */
function dripLength(rng: Rng, maxLong: number): number {
  const r = rng.next();
  if (r < 0.55) {
    return rng.range(0.08, 0.32);
  }

  if (r < 0.88) {
    return rng.range(0.32, 0.85);
  }

  return rng.range(0.85, maxLong);
}

/** Share of the spots along a slimed edge that grow a drip. */
const DRIP_DENSITY = 0.6;

/**
 * Place slime along exposed box edges, avoiding adjacent geometry and sign
 * bounds. Append top-edge lips to `batch`; return drip specifications and
 * underside films for SlimeSim. Limit strands and bulbs to available wall and
 * obstacle clearance, and associate falling drops with suitable landing pools.
 * Underside films supply finite volume through their assigned runs.
 */
export function addDrips(
  batch: GeometryBatch,
  min: V3,
  max: V3,
  mode: 'top' | 'bottom',
  rng: Rng,
  color: Color,
  world: DripWorld,
): { drips: DripSpec[]; films: FilmSpec[] } {
  const out: DripSpec[] = [];
  const films: FilmSpec[] = [];
  let run = -1;
  const edges: Edge[] = [
    { a0: min[0], a1: max[0], axis: 'x', fixed: min[2], out: -1 },
    { a0: min[0], a1: max[0], axis: 'x', fixed: max[2], out: 1 },
    { a0: min[2], a1: max[2], axis: 'z', fixed: min[0], out: -1 },
    { a0: min[2], a1: max[2], axis: 'z', fixed: max[0], out: 1 },
  ];
  const yEdge = mode === 'top' ? max[1] : min[1];
  const thick = max[1] - min[1];

  // (x, z) of a point `o` outward from the face, `along` the edge
  const xz = (e: Edge, along: number, o: number): [number, number] => {
    const f = e.fixed + e.out * o;
    return e.axis === 'x' ? [along, f] : [f, along];
  };

  const at = (e: Edge, along: number, o: number, y: number): boolean => {
    const [x, z] = xz(e, along, o);
    return world.occupied(x, y, z);
  };

  // box spanning [along±w/2] x [o0..o1 outward offsets] x [y0..y1]; underside ones join the current run
  const B = (
    e: Edge,
    along: number,
    w: number,
    o0: number,
    o1: number,
    y0: number,
    y1: number,
  ): boolean => {
    const [x0, z0] = xz(e, along - w / 2, o0);
    const [x1, z1] = xz(e, along + w / 2, o1);
    const bmin: V3 = [Math.min(x0, x1), y0, Math.min(z0, z1)];
    const bmax: V3 = [Math.max(x0, x1), y1, Math.max(z0, z1)];
    if (world.blocked(bmin, bmax)) {
      return false;
    }

    if (mode === 'top') {
      batch.box(bmin, bmax, color, 1, false);
    } else {
      films.push({ min: bmin, max: bmax, edge: yEdge, run });
    }

    return true;
  };

  // a sign within reach of the biggest bulb, or a ledge right under the drip
  const inWay = (
    e: Edge,
    along: number,
    w: number,
    y0: number,
    y1: number,
  ): boolean => {
    const big = bulbSize(w, 1, true);
    const [x0, z0] = xz(e, along - big.across / 2, -0.03);
    const [x1, z1] = xz(e, along + big.across / 2, -0.03 + big.depth);
    return (
      world.blocked(
        [Math.min(x0, x1), y0, Math.min(z0, z1)],
        [Math.max(x0, x1), y1, Math.max(z0, z1)],
      ) || at(e, along, 0.035, y0)
    );
  };

  const covered = (e: Edge, along: number): boolean => {
    if (mode === 'top') {
      return (
        at(e, along, 0.15, yEdge - Math.min(0.25, thick * 0.5)) ||
        at(e, along, -0.15, yEdge + 0.12)
      );
    }

    return (
      at(e, along, 0.15, yEdge + Math.min(0.2, thick * 0.5)) ||
      at(e, along, 0.15, yEdge - 0.25)
    );
  };

  const drip = (
    e: Edge,
    along: number,
    w: number,
    top: number,
    L: number,
  ): void => {
    // Scan downward to find the continuous supporting wall and the first obstruction.
    const depth = L + 1.2;
    let wall = 0;
    let limit = depth;
    let backed = true;
    for (let len = 0; len < depth; len += STEP) {
      const y = top - len - STEP;
      if (inWay(e, along, w, y, y + STEP)) {
        limit = len;
        break;
      }

      if (backed && at(e, along, -0.05, y)) {
        wall = len + STEP;
      } else {
        backed = false;
      }
    }

    const spec = (
      reach: number,
      hang = 0,
      drops = false,
      landY = 0,
      pool = -1,
    ): void => {
      out.push({
        axis: e.axis,
        out: e.out,
        along,
        face: e.fixed,
        top,
        w,
        reach,
        hang,
        drops,
        landY,
        pool,
        run: mode === 'top' ? -1 : run,
      });
    };

    // Reserve clearance for a full bulb and stretch oscillation.
    const hang =
      L > wall
        ? Math.min(
            rng.range(0.15, 0.45),
            (limit - wall - bulbBelow(w, true)) / 1.2,
          )
        : 0;
    if (hang < 0.06) {
      // Reject underside drips without enough room for a hanging bulb.
      if (mode === 'bottom') {
        return;
      }

      // Limit wall-supported drips by the desired length, wall end, and obstacle clearance.
      const reach = Math.min(L, wall, limit - bulbBelow(w, false));
      if (reach > 0.03) {
        spec(reach);
      }

      return;
    }

    // Short top-fed drips retain a hanging bulb; underside drips must be able to shed their finite supply.
    if (mode === 'top' && L - wall <= hang) {
      spec(wall, L - wall);
      return;
    }

    // Find the landing surface, checking for signs and ledges above the ground query result.
    const from = top - wall - hang;
    const [cx, cz] = xz(e, along, 0.035);
    const [px, pz] = xz(e, along, 0.3);
    const land = world.land(cx, from, cz, px, pz);
    for (let y = from - STEP; y > land.y; y -= STEP) {
      if (inWay(e, along, w, y, y + STEP)) {
        spec(wall, hang, true, y + STEP);
        return;
      }
    }

    spec(wall, hang, true, land.y, land.pool);
  };

  for (const e of edges) {
    if (e.a1 - e.a0 < 0.6) {
      continue;
    }

    let t = e.a0 + rng.range(0, 1.2);
    while (t < e.a1 - 0.2) {
      if (!rng.chance(DRIP_DENSITY)) {
        t += rng.range(0.8, 3);
        continue;
      }

      const runEnd = Math.min(e.a1 - 0.05, t + rng.range(0.8, 4.5));
      if (mode === 'bottom') {
        run = world.run();
      }

      // Record successfully placed lip segments so drips receive a visible source.
      const lipped: number[] = [];
      let s = t;
      while (s < runEnd - 0.05) {
        const seg = Math.min(runEnd - s, rng.range(0.25, 0.75));
        const mid = s + seg / 2;
        if (!covered(e, mid)) {
          const lip = rng.range(0.08, 0.3);
          let placed: boolean;
          if (mode === 'top') {
            B(
              e,
              mid,
              seg + 0.02,
              -rng.range(0.1, 0.32),
              0.06,
              yEdge,
              yEdge + rng.range(0.03, 0.07),
            );
            placed = B(
              e,
              mid,
              seg + 0.02,
              -0.02,
              0.06,
              yEdge - lip,
              yEdge + 0.03,
            );
          } else {
            placed = B(
              e,
              mid,
              seg + 0.02,
              -0.03,
              0.05,
              yEdge - lip * 0.6,
              yEdge + Math.min(0.2, thick * 0.6),
            );
          }

          if (placed) {
            lipped.push(s, s + seg);
          }
        }

        s += seg;
      }

      // Require the drip position to lie beneath a successfully placed lip or film.
      const underLip = (along: number): boolean => {
        for (let i = 0; i < lipped.length; i += 2) {
          if (
            along >= (lipped[i] as number) &&
            along <= (lipped[i + 1] as number)
          ) {
            return true;
          }
        }

        return false;
      };

      // Place drips along the exposed portions of this run.
      let d = t + rng.range(0.02, 0.2);
      while (d < runEnd - 0.06) {
        const w =
          mode === 'top' ? rng.range(0.07, 0.26) : rng.range(0.06, 0.13);
        const along = d + w / 2;
        if (!covered(e, along) && underLip(along)) {
          drip(
            e,
            along,
            w,
            mode === 'top' ? yEdge : yEdge + 0.06,
            dripLength(rng, 2.4),
          );
        }

        d +=
          w + (mode === 'top' ? rng.range(0.04, 0.42) : rng.range(0.5, 1.4));
      }

      t = runEnd + rng.range(0.4, 2.6);
    }
  }

  return { drips: out, films };
}
