/**
 * Dubins paths: the shortest ways for a car that can only drive forward with a
 * minimum turning radius to get from one pose to another, built from Left /
 * Right arcs and Straights (LSL, RSR, LSR, RSL, RLR, LRL). Poses use the game's
 * yaw convention: forward = (sin yaw, cos yaw) in (x, z).
 */

import { mod, TAU } from '../core/math';

export interface Pose {
  x: number;
  z: number;
  yaw: number;
}

type Word = 'LSL' | 'RSR' | 'LSR' | 'RSL' | 'RLR' | 'LRL';

export interface DubinsPath {
  word: Word;
  /** Length of each of the three pieces, metres. */
  lengths: [number, number, number];
  total: number;
}

const mod2pi = (a: number): number => mod(a, TAU);

/** Standard math frame: x right, y = game z, heading angle counterclockwise from +x. */
const toTheta = (yaw: number): number => Math.PI / 2 - yaw;

/** Every feasible Dubins path between two poses for turning radius r, shortest first. */
export function dubins(a: Pose, b: Pose, r: number): DubinsPath[] {
  const dx = b.x - a.x;
  const dy = b.z - a.z;
  const D = Math.hypot(dx, dy);
  const d = D / r;
  const phi = Math.atan2(dy, dx);
  const al = mod2pi(toTheta(a.yaw) - phi);
  const be = mod2pi(toTheta(b.yaw) - phi);
  const sa = Math.sin(al);
  const sb = Math.sin(be);
  const ca = Math.cos(al);
  const cb = Math.cos(be);
  const cab = Math.cos(al - be);
  const out: DubinsPath[] = [];
  const add = (word: Word, t: number, p: number, q: number): void => {
    if (!(t >= 0 && p >= 0 && q >= 0) || !Number.isFinite(t + p + q)) return;
    const lengths: [number, number, number] = [t * r, p * r, q * r];
    out.push({ word, lengths, total: lengths[0] + lengths[1] + lengths[2] });
  };
  {
    const p2 = 2 + d * d - 2 * cab + 2 * d * (sa - sb);
    if (p2 >= 0) {
      const tmp = Math.atan2(cb - ca, d + sa - sb);
      add('LSL', mod2pi(-al + tmp), Math.sqrt(p2), mod2pi(be - tmp));
    }
  }
  {
    const p2 = 2 + d * d - 2 * cab + 2 * d * (sb - sa);
    if (p2 >= 0) {
      const tmp = Math.atan2(ca - cb, d - sa + sb);
      add('RSR', mod2pi(al - tmp), Math.sqrt(p2), mod2pi(-be + tmp));
    }
  }
  {
    const p2 = -2 + d * d + 2 * cab + 2 * d * (sa + sb);
    if (p2 >= 0) {
      const p = Math.sqrt(p2);
      const tmp = Math.atan2(-ca - cb, d + sa + sb) - Math.atan2(-2, p);
      add('LSR', mod2pi(-al + tmp), p, mod2pi(-mod2pi(be) + tmp));
    }
  }
  {
    const p2 = -2 + d * d + 2 * cab - 2 * d * (sa + sb);
    if (p2 >= 0) {
      const p = Math.sqrt(p2);
      const tmp = Math.atan2(ca + cb, d - sa - sb) - Math.atan2(2, p);
      add('RSL', mod2pi(al - tmp), p, mod2pi(be - tmp));
    }
  }
  {
    const tmp = (6 - d * d + 2 * cab + 2 * d * (sa - sb)) / 8;
    if (Math.abs(tmp) <= 1) {
      const p = mod2pi(TAU - Math.acos(tmp));
      const t = mod2pi(al - Math.atan2(ca - cb, d - sa + sb) + p / 2);
      add('RLR', t, p, mod2pi(al - be - t + p));
    }
  }
  {
    const tmp = (6 - d * d + 2 * cab + 2 * d * (sb - sa)) / 8;
    if (Math.abs(tmp) <= 1) {
      const p = mod2pi(TAU - Math.acos(tmp));
      const t = mod2pi(-al - Math.atan2(ca - cb, d + sa - sb) + p / 2);
      add('LRL', t, p, mod2pi(be - al - t + p));
    }
  }
  return out.sort((x, y) => x.total - y.total);
}

/** Poses along a Dubins path every `step` metres (start excluded, end included). */
export function sampleDubins(a: Pose, path: DubinsPath, r: number, step: number): Pose[] {
  const out: Pose[] = [];
  let x = a.x;
  let y = a.z;
  let th = toTheta(a.yaw);
  for (let k = 0; k < 3; k++) {
    const kind = path.word[k] as 'L' | 'R' | 'S';
    const len = path.lengths[k] as number;
    const n = Math.max(1, Math.ceil(len / step));
    const ds = len / n;
    for (let i = 0; i < n; i++) {
      if (kind === 'S') {
        x += Math.cos(th) * ds;
        y += Math.sin(th) * ds;
      } else {
        // arc about the turning center, left = counterclockwise
        const s = kind === 'L' ? 1 : -1;
        const cx = x - s * r * Math.sin(th);
        const cy = y + s * r * Math.cos(th);
        th += (s * ds) / r;
        x = cx + s * r * Math.sin(th);
        y = cy - s * r * Math.cos(th);
      }
      out.push({ x, z: y, yaw: Math.PI / 2 - th });
    }
  }
  return out;
}
