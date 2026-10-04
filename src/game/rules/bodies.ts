import { Vector3 } from 'three';

import type { Obstacle } from '@/actors/autopilot';
import type { Vehicle } from '@/actors/vehicle';
import { bodyOffsets } from '@/engine/physics/vehicle-params';

/** Body categories used to filter steering obstacles. */
export type BodyKind = 'person' | 'down' | 'still' | 'cody' | 'skeleton' | 'car';

/**
 * A body registered for the current frame. Position and velocity reference the actor’s vectors and reflect later
 * movement.
 */
export interface Body {
  kind: BodyKind;
  pos: Vector3;
  vel: Vector3;
  /** Collision radius in meters; vehicles use the radius of each body circle. */
  r: number;
  /** Whether drivers should treat this body as moving traffic. */
  moving: boolean;
  /** Whether this walker also avoids others, allowing reciprocal steering to share the correction. */
  dodges: boolean;
  /** Actor identity used to exclude the body from its own obstacle query. */
  owner: object | null;
  /** Vehicle represented by this body, if any. */
  vehicle: Vehicle | null;
}

/** Shared zero velocity. Callers must not mutate it. */
export const NO_VELOCITY: Readonly<Vector3> = new Vector3();

/** Body registration data. Optional flags default to false, identity fields to null, and velocity to zero. */
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
 * Collect bodies during sensing for steering and braking queries. Reuse records between frames; each consumer filters
 * the body categories it needs.
 */
export class Bodies {
  private readonly pool: Body[] = [];
  private n = 0;
  /** Reusable obstacle records overwritten by each obstacles() call. */
  private readonly marks: { pos: Vector3; owner: object | null }[] = [];

  /** Reset the active count while retaining pooled records. */
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

  /** Visit each body registered in the current frame. */
  each(fn: (b: Body) => void): void {
    for (let i = 0; i < this.n; i++) {
      const b = this.pool[i];
      if (b) {
        fn(b);
      }
    }
  }

  /**
   * Replace `out` with matching obstacles at their current positions. Expand vehicles into body-circle positions and
   * include owner identities for self-exclusion. Returned records are reused by the next call.
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

  /** Replace `out` with position references from matching bodies. */
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
