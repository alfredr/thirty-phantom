import type { Vector3 } from 'three';
import { bodyOffsets } from '../engine/physics/vehicle-params';
import type { ZoneDef } from '../world/level-data';
import type { Vehicle } from './vehicle';

/** A person's room: shoulders plus a little space. */
export const PERSON_RADIUS = 0.35;
/** Walking routes keep out of a standing car's body plus this (m): short of a driver's door spot, so the door stays reachable. */
const ROUTE_ROOM = 0.25;
/** A vehicle slower than this (m/s) is standing still: something to route round. */
const STANDING = 0.3;
/** A vehicle's region runs from just under its floor to above its roof. */
const ZONE_BELOW = 0.3;
const ZONE_ABOVE = 2;
/** Extra room people keep from a vehicle's body (still short of a driver's door spot). */
const CAR_ROOM = 0.15;
/** Only things within this height of a walker are on its floor. */
const SAME_LEVEL = 1.5;
/** Collisions further off than this (s) don't count yet. */
const HORIZON = 2.5;
/** Penalty per 1/s of time to collision with a person, and with a vehicle (people give cars a wide berth). */
const URGENCY = 1.2;
const CAR_URGENCY = 4;
/** Penalty per m/s of change from the current velocity: keeps a choice from flickering frame to frame. */
const STEADY = 0.3;
/** Times to collision below this all count as this (already touching). */
const T_MIN = 0.05;
/** Sampled velocities: rings at these shares of top speed, this many directions each, the first along the wanted velocity. */
const RINGS = [1, 0.6, 0.3];
const DIRECTIONS = 16;
/** Slower than this (m/s) is standing still. */
const STILL = 0.1;
/** A sampled velocity has to leave room to stand this far (s) along it, and at least a body's width. */
const LOOK = 0.5;

interface Disc {
  x: number;
  y: number;
  z: number;
  vx: number;
  vz: number;
  r: number;
  /** Dodges too: only half the dodge is the other's to make. */
  reciprocal: boolean;
  urgency: number;
  owner: unknown;
}

const near: Disc[] = [];

/** A region around `v`'s body grown by `pad`: the box around its turned footprint, from its floor to above its roof. */
export function footprint(v: Vehicle, pad: number): ZoneDef {
  const along = v.params.length / 2 + pad;
  const across = v.params.radius + pad;
  const s = Math.abs(Math.sin(v.yaw));
  const c = Math.abs(Math.cos(v.yaw));
  const hx = s * along + c * across;
  const hz = c * along + s * across;
  return { min: [v.pos.x - hx, v.pos.y - ZONE_BELOW, v.pos.z - hz], max: [v.pos.x + hx, v.pos.y + ZONE_ABOVE, v.pos.z + hz] };
}

/**
 * Cars standing still (parked, or stopped: a guest's car waiting for a valet)
 * as regions for walking routes to keep out of. Local avoidance only sees a
 * few seconds ahead, so a route straight through a car would leave a walker
 * stuck against it: the planner goes round instead.
 */
export function parkedBlocks(vehicles: readonly Vehicle[]): ZoneDef[] {
  const out: ZoneDef[] = [];
  for (const v of vehicles) {
    if (v.gone || v.crashing) continue;
    if (v.role === 'parked' || Math.hypot(v.vel.x, v.vel.z) < STANDING) out.push(footprint(v, ROUTE_ROOM));
  }
  return out;
}

/** Is p inside any of `zones`? (A route can't end in a blocked region.) */
export function inZones(p: Vector3, zones: readonly ZoneDef[]): boolean {
  return zones.some((z) => p.x >= z.min[0] && p.x <= z.max[0] && p.z >= z.min[2] && p.z <= z.max[2] && p.y >= z.min[1] && p.y <= z.max[1]);
}

/** Seconds until circles `r` apart along the relative position (px, pz) touch at relative velocity (wx, wz); 0 if touching and closing, Infinity if never. */
function timeToCollision(px: number, pz: number, wx: number, wz: number, r: number): number {
  const c = px * px + pz * pz - r * r;
  const b = px * wx + pz * wz;
  if (c < 0) return b > 0 ? 0 : Infinity;
  const a = wx * wx + wz * wz;
  if (b <= 0 || a < 1e-9) return Infinity;
  const disc = b * b - a * c;
  if (disc <= 0) return Infinity;
  return (b - Math.sqrt(disc)) / a;
}

/**
 * Local collision avoidance for people on foot: reciprocal velocity obstacles
 * (van den Berg, Lin and Manocha 2008), in their sampling form. Each frame
 * the game lists what's about: walkers, people standing, Cody, every vehicle
 * as its three body circles. A walker then tries velocities around the one
 * its route asks for and takes the best trade between keeping to it and time
 * to collision. Another walker dodges too, so only half of that dodge is
 * theirs (the reciprocal part); Cody, people standing and vehicles don't, so
 * all of it is.
 */
export class Avoidance {
  private readonly discs: Disc[] = [];
  private n = 0;

  /** Start this frame's list. */
  clear(): void {
    this.n = 0;
  }

  private add(x: number, y: number, z: number, vx: number, vz: number, r: number, reciprocal: boolean, urgency: number, owner: unknown): void {
    let d = this.discs[this.n];
    if (!d) this.discs.push((d = { x, y, z, vx, vz, r, reciprocal, urgency, owner }));
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

  /** Someone on foot; a `walking` one dodges as well. `owner` is left out when it steers itself. */
  person(pos: Vector3, vel: Vector3, walking: boolean, owner: unknown): void {
    this.add(pos.x, pos.y, pos.z, vel.x, vel.z, PERSON_RADIUS, walking, URGENCY, owner);
  }

  /** Something that won't move out of the way: Randy, his fire, someone lying in the road. */
  still(pos: Vector3, r: number): void {
    this.add(pos.x, pos.y, pos.z, 0, 0, r, false, URGENCY, null);
  }

  /** Cody on foot: moving, but not dodging anyone. */
  mover(pos: Vector3, vel: Vector3, r: number): void {
    this.add(pos.x, pos.y, pos.z, vel.x, vel.z, r, false, URGENCY, null);
  }

  /** A vehicle's three body circles, moving with it. */
  vehicle(v: Vehicle): void {
    const fx = Math.sin(v.yaw);
    const fz = Math.cos(v.yaw);
    for (const o of bodyOffsets(v.params)) {
      this.add(v.pos.x + fx * o, v.pos.y, v.pos.z + fz * o, v.vel.x, v.vel.z, v.params.radius + CAR_ROOM, false, CAR_URGENCY, null);
    }
  }

  /**
   * Velocity (x, z, into `out`) for walker `self` at `pos`, moving at `vel`,
   * whose route asks for `want`, up to `top` m/s: the sampled velocity with
   * the least penalty. Only velocities that leave somewhere to stand by `fits`
   * are tried, except `want` itself (the route is walkable). With `movingOnly`,
   * things standing still don't count (a walker pushing past after being stuck).
   */
  steer(self: unknown, pos: Vector3, vel: Vector3, want: Vector3, top: number, fits: (x: number, z: number) => boolean, out: Vector3, movingOnly = false): Vector3 {
    near.length = 0;
    for (let i = 0; i < this.n; i++) {
      const d = this.discs[i];
      if (!d) break;
      if (d.owner === self && self !== null) continue;
      if (movingOnly && Math.hypot(d.vx, d.vz) < STILL) continue;
      if (Math.abs(d.y - pos.y) > SAME_LEVEL) continue;
      const reach = (top + Math.hypot(d.vx, d.vz)) * HORIZON + PERSON_RADIUS + d.r;
      if (Math.abs(d.x - pos.x) > reach || Math.abs(d.z - pos.z) > reach) continue;
      near.push(d);
    }
    out.set(want.x, 0, want.z);
    if (near.length === 0) return out;
    let best = this.penalty(pos, vel, want, want.x, want.z);
    const tryOne = (vx: number, vz: number): void => {
      const s = Math.hypot(vx, vz);
      if (s > 1e-6) {
        const ahead = Math.max(s * LOOK, PERSON_RADIUS) / s;
        if (!fits(pos.x + vx * ahead, pos.z + vz * ahead)) return;
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

  /** How far (vx, vz) strays from `want` and from `vel`, plus the most urgent collision it heads for. */
  private penalty(pos: Vector3, vel: Vector3, want: Vector3, vx: number, vz: number): number {
    let worst = 0;
    for (const d of near) {
      // a walker who dodges too: aim for the velocity halfway between this one and the current
      const mx = d.reciprocal ? 2 * vx - vel.x : vx;
      const mz = d.reciprocal ? 2 * vz - vel.z : vz;
      const t = timeToCollision(d.x - pos.x, d.z - pos.z, mx - d.vx, mz - d.vz, PERSON_RADIUS + d.r);
      if (t < HORIZON) worst = Math.max(worst, d.urgency / Math.max(t, T_MIN));
    }
    return Math.hypot(want.x - vx, want.z - vz) + STEADY * Math.hypot(vel.x - vx, vel.z - vz) + worst;
  }
}
