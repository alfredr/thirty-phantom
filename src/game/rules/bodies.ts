import { Vector3 } from 'three';

import type { Obstacle } from '@/actors/autopilot';
import type { Vehicle } from '@/actors/vehicle';
import { bodyOffsets } from '@/engine/physics/vehicle-params';

/** What a body is, to whoever's steering round it. */
export type BodyKind = 'person' | 'down' | 'still' | 'cody' | 'skeleton' | 'car';

/**
 * Something taking up room this frame. `pos` and `vel` are the thing's own vectors, so a body read later in the frame
 * is where the thing is then.
 */
export interface Body {
  kind: BodyKind;
  pos: Vector3;
  vel: Vector3;
  /** Its radius (m); a car's is its body circles'. */
  r: number;
  /** Under way (a person walking faster than a stroll): traffic and drivers brake for them. */
  moving: boolean;
  /** Walking a route, so it dodges too: only half of a dodge is the other's to make. */
  dodges: boolean;
  /** Whose it is (a walker), to leave it out of its own view. */
  owner: object | null;
  /** The car, for a car's body. */
  vehicle: Vehicle | null;
}

/** The velocity of something that doesn't move. Never written to. */
export const NO_VELOCITY: Readonly<Vector3> = new Vector3();

/** How a body is added: `kind`, where, how fast, how big; the rest default to standing, not dodging, nobody's. */
export interface BodyOf {
  kind: BodyKind;
  pos: Vector3;
  vel?: Vector3;
  r: number;
  moving?: boolean;
  dodges?: boolean;
  owner?: object | null;
  vehicle?: Vehicle | null;
}

/**
 * The world's bodies this frame: everyone and everything that takes up room, filled once in the sense phase, each
 * system adding its own (people, valets, Randy and his fire, skeletons, Cody, cars). Walkers steer round them, and
 * traffic and the AI drivers brake for the ones in their way, each taking the kinds it cares about. Records are reused
 * frame to frame.
 */
export class Bodies {
  private readonly pool: Body[] = [];
  private n = 0;
  /** Obstacle records, reused frame to frame (see obstacles()). */
  private readonly marks: { pos: Vector3; owner: object | null }[] = [];

  /** Starts this frame's list. */
  clear(): void {
    this.n = 0;
  }

  add(b: BodyOf): void {
    let body = this.pool[this.n];
    if (!body) {
      body = {
        kind: b.kind,
        pos: b.pos,
        vel: NO_VELOCITY,
        r: 0,
        moving: false,
        dodges: false,
        owner: null,
        vehicle: null,
      };
      this.pool.push(body);
    }

    this.n++;
    body.kind = b.kind;
    body.pos = b.pos;
    body.vel = b.vel ?? NO_VELOCITY;
    body.r = b.r;
    body.moving = b.moving ?? false;
    body.dodges = b.dodges ?? false;
    body.owner = b.owner ?? null;
    body.vehicle = b.vehicle ?? null;
  }

  /** Runs `fn` for every body this frame. */
  each(fn: (b: Body) => void): void {
    for (let i = 0; i < this.n; i++) {
      const b = this.pool[i];
      if (b) {
        fn(b);
      }
    }
  }

  /**
   * The bodies that pass `test`, as drivers keep clear of them, into `out` (emptied first): a point for each, and for a
   * car its three body circles, so its nose and tail count as much as its middle. Each says whose it is, so a car
   * leaves out its own. Positions are as they are now.
   */
  obstacles(test: (b: Body) => boolean, out: Obstacle[]): Obstacle[] {
    out.length = 0;
    let k = 0;
    const put = (x: number, y: number, z: number, owner: object | null): void => {
      let o = this.marks[k];
      if (!o) {
        this.marks.push((o = { pos: new Vector3(), owner: null }));
      }

      k++;
      o.pos.set(x, y, z);
      o.owner = owner;
      out.push(o);
    };

    this.each((b) => {
      if (!test(b)) {
        return;
      }

      const v = b.vehicle;
      if (!v) {
        put(b.pos.x, b.pos.y, b.pos.z, b.owner);
        return;
      }

      const fx = Math.sin(v.yaw);
      const fz = Math.cos(v.yaw);
      for (const off of bodyOffsets(v.params)) {
        put(v.pos.x + fx * off, v.pos.y, v.pos.z + fz * off, v);
      }
    });
    return out;
  }

  /** Where the bodies that pass `test` are, into `out` (emptied first). */
  points(test: (b: Body) => boolean, out: Vector3[]): Vector3[] {
    out.length = 0;
    this.each((b) => {
      if (test(b)) {
        out.push(b.pos);
      }
    });
    return out;
  }
}
