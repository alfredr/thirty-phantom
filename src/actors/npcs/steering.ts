import { Vector3 } from 'three';

import { clamp, wrapAngle } from '@/engine/core/math';
import { Polyline } from '@/engine/nav/polyline';

export interface Turning {
  readonly rate: number;
  readonly speed: number;
}

export const heading = (from: Vector3, to: Vector3): number => Math.atan2(to.x - from.x, to.z - from.z);

export const offBy = (yaw: number, want: number): number => Math.abs(wrapAngle(want - yaw));

export function turnToward(yaw: number, want: number, turn: Turning, dt: number): number {
  const step = wrapAngle(want - yaw) * (1 - Math.exp(-turn.rate * dt));
  const most = turn.speed * dt;
  return wrapAngle(yaw + clamp(step, -most, most));
}

export function clampAround(want: number, rest: number, most: number): number {
  return wrapAngle(rest + clamp(wrapAngle(want - rest), -most, most));
}

export function trimPath(path: Polyline, short: number): Polyline | null {
  const keep = path.total - short;
  if (keep <= 0) {
    return null;
  }

  if (short <= 0) {
    return path;
  }

  const points: Vector3[] = [];
  let s = 0;
  let prev: Vector3 | null = null;
  for (const p of path.points) {
    s += prev ? prev.distanceTo(p) : 0;
    prev = p;

    if (s >= keep) {
      break;
    }

    points.push(p);
  }

  points.push(path.sample(keep, new Vector3()));
  return new Polyline(points);
}
