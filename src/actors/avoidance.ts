import type { Vector3 } from 'three';

import type { Vehicle } from '@/actors/vehicles/vehicle';
import { bodyOffsets } from '@/engine/physics/vehicle-params';
import type { ZoneDef } from '@/world/level-data';

/** Pedestrian collision radius including personal space, in meters. */
export const PERSON_RADIUS = 0.35;
/** Route clearance beyond a stationary vehicle footprint, in meters. Keep driver-door positions reachable. */
const ROUTE_ROOM = 0.25;
/** Speed threshold in m/s for treating a vehicle as a static route obstacle. */
const STANDING = 0.3;
/** Vertical extents of vehicle avoidance regions relative to the vehicle origin, in meters. */
const ZONE_BELOW = 0.3;
const ZONE_ABOVE = 2;
/** Extra pedestrian clearance around vehicle collision circles, in meters; keep door access reachable. */
const CAR_ROOM = 0.15;
/** Maximum vertical separation for local avoidance, in meters. */
const SAME_LEVEL = 1.5;
/** Prediction horizon for collision penalties, in seconds. */
const HORIZON = 2.5;
/** Collision urgency weights for people and vehicles; higher values favor earlier avoidance. */
const URGENCY = 1.2;
const CAR_URGENCY = 4;
/** Penalty per m/s of velocity change, used to stabilize successive choices. */
const STEADY = 0.3;
/** Minimum collision time in seconds used to cap urgency penalties. */
const T_MIN = 0.05;
/** Speed fractions and direction count for candidate velocities, with each ring aligned to the desired heading. */
const RINGS = [1, 0.6, 0.3];
const DIRECTIONS = 16;
/** Speed threshold in m/s for excluding stationary obstacles during recovery. */
const STILL = 0.1;
/** Standing-clearance look-ahead in seconds, with a minimum distance of PERSON_RADIUS. */
const LOOK = 0.5;

interface Disc {
  x: number;
  y: number;
  z: number;
  vx: number;
  vz: number;
  r: number;
  /** Whether this obstacle also participates in reciprocal avoidance. */
  reciprocal: boolean;
  urgency: number;
  owner: unknown;
}

const near: Disc[] = [];

/** Return an axis-aligned region around the rotated vehicle footprint, expanded horizontally by `pad`. */
export function footprint(v: Vehicle, pad: number): ZoneDef {
  const along = v.params.length / 2 + pad;
  const across = v.params.radius + pad;
  const s = Math.abs(Math.sin(v.yaw));
  const c = Math.abs(Math.cos(v.yaw));
  const hx = s * along + c * across;
  const hz = c * along + s * across;
  return {
    min: [v.pos.x - hx, v.pos.y - ZONE_BELOW, v.pos.z - hz],
    max: [v.pos.x + hx, v.pos.y + ZONE_ABOVE, v.pos.z + hz],
  };
}

/**
 * Build walking-route exclusion zones for parked or slow vehicles, skipping removed and crashing vehicles. Static
 * routing around these footprints prevents local avoidance from repeatedly steering into an immovable blockage.
 */
export function parkedBlocks(vehicles: readonly Vehicle[]): ZoneDef[] {
  const out: ZoneDef[] = [];
  for (const v of vehicles) {
    if (v.gone || v.crashing) {
      continue;
    }

    if (v.role === 'parked' || Math.hypot(v.vel.x, v.vel.z) < STANDING) {
      out.push(footprint(v, ROUTE_ROOM));
    }
  }

  return out;
}

/** Test whether `p` lies within any blocked zone, including its boundaries. */
export function inZones(p: Vector3, zones: readonly ZoneDef[]): boolean {
  return zones.some(
    (z) =>
      p.x >= z.min[0] && p.x <= z.max[0] && p.z >= z.min[2] && p.z <= z.max[2] && p.y >= z.min[1] && p.y <= z.max[1],
  );
}

/**
 * Calculate time to overlap for relative position (px, pz), closing velocity (wx, wz), and combined radius `r`. Return
 * zero for overlapping circles still closing, or Infinity for separating, stationary, or tangent motion.
 */
function timeToCollision(px: number, pz: number, wx: number, wz: number, r: number): number {
  const c = px * px + pz * pz - r * r;
  const b = px * wx + pz * wz;
  if (c < 0) {
    return b > 0 ? 0 : Infinity;
  }

  const a = wx * wx + wz * wz;
  if (b <= 0 || a < 1e-9) {
    return Infinity;
  }

  const disc = b * b - a * c;
  if (disc <= 0) {
    return Infinity;
  }

  return (b - Math.sqrt(disc)) / a;
}

/**
 * Sample pedestrian velocities using reciprocal velocity obstacles (van den Berg, Lin and Manocha 2008). Rebuild the
 * active obstacle list each frame, then choose velocities that balance route following, stable motion, and predicted
 * collisions. Walking pedestrians share avoidance responsibility; static obstacles, Cody, and vehicles do not.
 */
export class Avoidance {
  private readonly discs: Disc[] = [];
  private n = 0;

  /** Reset the active obstacle count while retaining allocated discs. */
  clear(): void {
    this.n = 0;
  }

  private add(
    x: number,
    y: number,
    z: number,
    vx: number,
    vz: number,
    r: number,
    reciprocal: boolean,
    urgency: number,
    owner: unknown,
  ): void {
    let d = this.discs[this.n];
    if (!d) {
      this.discs.push((d = { x, y, z, vx, vz, r, reciprocal, urgency, owner }));
    }

    this.n++;
    d.x = x;
    d.y = y;
    d.z = z;
    d.vx = vx;
    d.vz = vz;
    d.r = r;
    d.reciprocal = reciprocal;
    d.urgency = urgency;
    d.owner = owner;
  }

  /** Register a pedestrian. Walking pedestrians use reciprocal avoidance; `owner` excludes self-collisions. */
  person(pos: Vector3, vel: Vector3, walking: boolean, owner: unknown): void {
    this.add(pos.x, pos.y, pos.z, vel.x, vel.z, PERSON_RADIUS, walking, URGENCY, owner);
  }

  /** Register a stationary obstacle that does not participate in avoidance. */
  still(pos: Vector3, r: number): void {
    this.add(pos.x, pos.y, pos.z, 0, 0, r, false, URGENCY, null);
  }

  /** Register a moving obstacle whose motion does not respond to avoidance, such as Cody. */
  mover(pos: Vector3, vel: Vector3, r: number): void {
    this.add(pos.x, pos.y, pos.z, vel.x, vel.z, r, false, URGENCY, null);
  }

  /** A vehicle's three body circles, moving with it. */
  vehicle(v: Vehicle): void {
    const fx = Math.sin(v.yaw);
    const fz = Math.cos(v.yaw);
    for (const o of bodyOffsets(v.params)) {
      this.add(
        v.pos.x + fx * o,
        v.pos.y,
        v.pos.z + fz * o,
        v.vel.x,
        v.vel.z,
        v.params.radius + CAR_ROOM,
        false,
        CAR_URGENCY,
        null,
      );
    }
  }

  /**
   * Write the lowest-penalty ground velocity to `out` and return it. Compare desired velocity with a stop and samples
   * up to `top` m/s, rejecting moving samples without standing clearance. Trust `want` without a clearance check.
   * Exclude self-owned discs, other levels, and distant obstacles; movingOnly also excludes stationary obstacles.
   */
  steer(
    self: unknown,
    pos: Vector3,
    vel: Vector3,
    want: Vector3,
    top: number,
    fits: (x: number, z: number) => boolean,
    out: Vector3,
    movingOnly = false,
  ): Vector3 {
    near.length = 0;

    for (let i = 0; i < this.n; i++) {
      const d = this.discs[i];
      if (!d) {
        break;
      }

      if (d.owner === self && self !== null) {
        continue;
      }

      if (movingOnly && Math.hypot(d.vx, d.vz) < STILL) {
        continue;
      }

      if (Math.abs(d.y - pos.y) > SAME_LEVEL) {
        continue;
      }

      const reach = (top + Math.hypot(d.vx, d.vz)) * HORIZON + PERSON_RADIUS + d.r;
      if (Math.abs(d.x - pos.x) > reach || Math.abs(d.z - pos.z) > reach) {
        continue;
      }

      near.push(d);
    }

    out.set(want.x, 0, want.z);

    if (near.length === 0) {
      return out;
    }

    let best = this.penalty(pos, vel, want, want.x, want.z);
    const tryOne = (vx: number, vz: number): void => {
      const s = Math.hypot(vx, vz);
      if (s > 1e-6) {
        const ahead = Math.max(s * LOOK, PERSON_RADIUS) / s;
        if (!fits(pos.x + vx * ahead, pos.z + vz * ahead)) {
          return;
        }
      }

      const p = this.penalty(pos, vel, want, vx, vz);
      if (p < best) {
        best = p;
        out.set(vx, 0, vz);
      }
    };

    tryOne(0, 0);
    const a0 = Math.atan2(want.x, want.z);
    for (const k of RINGS) {
      const s = top * k;
      for (let i = 0; i < DIRECTIONS; i++) {
        const a = a0 + (i / DIRECTIONS) * Math.PI * 2;
        tryOne(Math.sin(a) * s, Math.cos(a) * s);
      }
    }

    return out;
  }

  /** Score deviation from desired and current velocity plus the largest predicted collision penalty. */
  private penalty(pos: Vector3, vel: Vector3, want: Vector3, vx: number, vz: number): number {
    let worst = 0;
    for (const d of near) {
      // Double the proposed change when testing reciprocal obstacles, which share avoidance responsibility.
      const mx = d.reciprocal ? 2 * vx - vel.x : vx;
      const mz = d.reciprocal ? 2 * vz - vel.z : vz;
      const t = timeToCollision(d.x - pos.x, d.z - pos.z, mx - d.vx, mz - d.vz, PERSON_RADIUS + d.r);
      if (t < HORIZON) {
        worst = Math.max(worst, d.urgency / Math.max(t, T_MIN));
      }
    }

    return Math.hypot(want.x - vx, want.z - vz) + STEADY * Math.hypot(vel.x - vx, vel.z - vz) + worst;
  }
}
