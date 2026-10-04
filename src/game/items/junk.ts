import { type Object3D, type Scene, Vector3 } from 'three';

import { buildJunk, type PartKind } from '@/actors/models/junk';
import type { Vehicle } from '@/actors/vehicles/vehicle';
import { TUNING } from '@/config';
import type { Rng } from '@/engine/core/rng';
import { Highlight } from '@/fx/highlight';
import type { NavGrid } from '@/world/nav-grid';

import type { ItemKind } from './item-breeds';

const J = TUNING.junk;

/** Launch height in meters, maximum angular speed in rad/s, and gravity in m/s². */
const BUMPER = 0.6;
const TUMBLE = 9;
const GRAVITY = 14;
/** Maximum angular deviation from the outward launch direction, in radians. */
const SPREAD = 1.1;
/** Fraction of velocity and spin retained for the single ground bounce. */
const BOUNCE = 0.3;
/** Shrink duration before expiry, in seconds. */
const FADE = 2;
/** Height allowance in meters for finding the ground beneath a descending part. */
const LOOK_UP = 0.5;
const _g = new Vector3();

interface Part {
  kind: ItemKind;
  pos: Vector3;
  vel: Vector3;
  spin: Vector3;
  floor: number;
  bounced: boolean;
  landed: boolean;
  age: number;
  /** Keep this item until collection and show a highlight. */
  keep: boolean;
  highlight: Highlight | null;
  root: Object3D;
  pickup?: Pickup;
}

/** A unique pickup keeps its identity instead of becoming an inventory count. */
export interface Pickup {
  available(): boolean;
  take(): void;
}

/** Per-vehicle part and tire counts, with the last shedding time in seconds. */
interface Shed {
  parts: number;
  tires: number;
  at: number;
}

/**
 * Manage collectible debris with per-car part limits and a global debris limit. Parts tumble, bounce once, and expire
 * unless collected. Items placed with `lay` remain highlighted until collection.
 */
export class Junk {
  private readonly parts: Part[] = [];
  private readonly shed = new WeakMap<Vehicle, Shed>();
  private t = 0;

  constructor(
    private readonly scene: Scene,
    private readonly nav: NavGrid,
    private readonly rng: Rng,
  ) {}

  /** Shed parts when the impact velocity change `dv`, in m/s, exceeds the configured threshold. */
  hit(car: Vehicle, at: Vector3, dv: number): void {
    const drops = car.breed.drops;
    if (!drops || dv < drops.crashDv) {
      return;
    }

    this.lose(car, at, Math.min(drops.perHit, 1 + Math.floor((dv - drops.crashDv) / drops.perDv)));
  }

  /** Request the configured number of parts for a crushed car, subject to shedding limits. */
  crushed(car: Vehicle): void {
    this.lose(car, car.pos, car.breed.drops?.crushed ?? 0);
  }

  /**
   * Register an item at its current position as a permanent pickup. Attach it to the scene and highlight the ground at
   * `floor`.
   */
  lay(kind: ItemKind, item: Object3D, floor: number, pickup?: Pickup): void {
    if (item.parent !== this.scene) {
      this.scene.attach(item);
    }

    const highlight = new Highlight();
    highlight.place(item.position, _g.set(item.position.x, floor, item.position.z));
    this.scene.add(highlight.root);
    this.parts.push({
      kind,
      pos: item.position.clone(),
      vel: new Vector3(),
      spin: new Vector3(),
      floor,
      bounced: true,
      landed: true,
      age: 0,
      keep: true,
      highlight,
      root: item,
      pickup,
    });
  }

  /** Advance debris and return items collected near `pos`. A null position disables collection. */
  update(dt: number, pos: Vector3 | null): ItemKind[] {
    this.t += dt;
    const got: ItemKind[] = [];
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i] as Part;
      if (p.pickup && !p.pickup.available()) {
        this.remove(i);
        continue;
      }

      p.age += dt;

      if (!p.landed) {
        this.fly(p, dt);
      }

      p.root.position.copy(p.pos);
      p.highlight?.update(dt);

      if (!p.keep) {
        p.root.scale.setScalar(Math.min(1, (J.life - p.age) / FADE));
      }

      const taken =
        p.landed &&
        pos !== null &&
        Math.hypot(pos.x - p.pos.x, pos.z - p.pos.z) < J.reach &&
        Math.abs(pos.y - p.floor) < J.reach;
      if (taken) {
        if (p.pickup) {
          p.pickup.take();
        } else {
          got.push(p.kind);
        }
      }

      if (taken || (!p.keep && p.age >= J.life)) {
        this.remove(i);
      }
    }

    return got;
  }

  private lose(car: Vehicle, at: Vector3, n: number): void {
    const drops = car.breed.drops;
    if (!drops) {
      return;
    }

    let s = this.shed.get(car);
    if (!s) {
      this.shed.set(car, (s = { parts: 0, tires: 0, at: -Infinity }));
    }

    if (this.t - s.at < drops.cooldown) {
      return;
    }

    s.at = this.t;
    // Launch outward through the impact point.
    const out = Math.atan2(at.x - car.pos.x, at.z - car.pos.z);
    for (let k = 0; k < n && s.parts < drops.perCar; k++) {
      const tire = s.tires < car.rig.wheels.length && this.rng.next() < drops.tireShare;
      const kind = tire ? 'tire' : this.rng.pick(drops.parts);
      if (tire) {
        s.tires++;
      }

      s.parts++;
      this.throw(kind, at, out + this.rng.range(-SPREAD, SPREAD));
    }

    // Remove the oldest temporary debris first; permanent pickups are exempt.
    for (let i = 0, n = this.parts.length; n > J.max && i < this.parts.length;) {
      if ((this.parts[i] as Part).keep) {
        i++;
      } else {
        this.remove(i);
        n--;
      }
    }
  }

  private throw(kind: PartKind, at: Vector3, yaw: number): void {
    const fling = this.rng.range(...J.fling);
    const root = buildJunk(kind);
    const pos = new Vector3(at.x, at.y + BUMPER, at.z);
    root.position.copy(pos);
    root.rotation.y = this.rng.range(0, Math.PI * 2);
    this.scene.add(root);
    this.parts.push({
      kind,
      pos,
      vel: new Vector3(Math.sin(yaw) * fling, this.rng.range(...J.up), Math.cos(yaw) * fling),
      spin: new Vector3(
        this.rng.range(-TUMBLE, TUMBLE),
        this.rng.range(-TUMBLE, TUMBLE),
        this.rng.range(-TUMBLE, TUMBLE),
      ),
      floor: at.y,
      bounced: false,
      landed: false,
      age: 0,
      keep: false,
      highlight: null,
      root,
    });
  }

  /** Integrate flight and spin, bounce once, then settle flat while preserving yaw. */
  private fly(p: Part, dt: number): void {
    p.vel.y -= GRAVITY * dt;
    p.pos.addScaledVector(p.vel, dt);
    const r = p.root.rotation;
    r.x += p.spin.x * dt;
    r.y += p.spin.y * dt;
    r.z += p.spin.z * dt;

    if (p.vel.y >= 0) {
      return;
    }

    p.floor = this.nav.heightAt(p.pos.x, p.pos.y + LOOK_UP, p.pos.z) ?? p.floor;

    if (p.pos.y > p.floor) {
      return;
    }

    p.pos.y = p.floor;

    if (!p.bounced) {
      p.bounced = true;
      p.vel.multiplyScalar(BOUNCE);
      p.vel.y = -p.vel.y;
      p.spin.multiplyScalar(BOUNCE);
      return;
    }

    p.landed = true;
    p.vel.set(0, 0, 0);
    r.set(0, r.y, 0);
  }

  private remove(i: number): void {
    const p = this.parts[i] as Part;
    this.scene.remove(p.root);
    p.highlight?.dispose();
    this.parts.splice(i, 1);
  }
}
