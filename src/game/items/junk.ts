import { type Object3D, type Scene, Vector3 } from 'three';
import { buildJunk, PART_KINDS, type PartKind } from '@/actors/models/junk';
import type { Rng } from '@/engine/core/rng';
import { Highlight } from '@/fx/highlight';
import type { Vehicle } from '@/actors/vehicle';
import { TUNING } from '@/config';
import type { NavGrid } from '@/world/nav-grid';
import type { ItemKind } from './item-breeds';

const J = TUNING.junk;

/** Parts fly out from about bumper height, tumbling (rad/s), under this gravity. */
const BUMPER = 0.6;
const TUMBLE = 9;
const GRAVITY = 14;
/** Thrown this far either side of straight out from the car (rad). */
const SPREAD = 1.1;
/** A part bounces off the ground once with this share of its speed, then lies flat. */
const BOUNCE = 0.3;
/** It shrinks away over its last few seconds. */
const FADE = 2;
/** The ground under a flying part is looked for this far above it (m), so one sailing off a deck finds the street. */
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
  /** Something that matters (Cody's badge): it stays till he picks it up, marked so it's seen. */
  keep: boolean;
  highlight: Highlight | null;
  root: Object3D;
}

/** What a car has shed so far, and when it last did. */
interface Shed {
  parts: number;
  tires: number;
  at: number;
}

/**
 * Things lying about for Cody to pick up on foot. Mostly car parts knocked off
 * in smashes: tires, hubcaps, mirrors, bumpers and the like fly out from the
 * hit, tumble, bounce once and lie where they land until he walks over them
 * (or they're old). Each car only has so much to lose, and only as many tires
 * as it has wheels. Anything else that ends up on the ground (his badge, where
 * Randy threw it) can be laid down here to stay till he picks it up.
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

  /** `car` took a hit at `at` that changed its speed by `dv` (m/s): bits come off, if it was hard enough. */
  hit(car: Vehicle, at: Vector3, dv: number): void {
    if (dv < J.crashDv) return;
    this.lose(car, at, Math.min(J.perHit, 1 + Math.floor((dv - J.crashDv) / J.perDv)));
  }

  /** `car` was flattened: a pile of parts at once, out of whatever it has left. */
  crushed(car: Vehicle): void {
    this.lose(car, car.pos, J.crushed);
  }

  /** `item` (already in the scene, where it lies) is `kind`, there to pick up from the ground at `floor` for as long as it takes. */
  lay(kind: ItemKind, item: Object3D, floor: number): void {
    if (item.parent !== this.scene) this.scene.attach(item);
    const highlight = new Highlight();
    highlight.place(item.position, _g.set(item.position.x, floor, item.position.z));
    this.scene.add(highlight.root);
    this.parts.push({ kind, pos: item.position.clone(), vel: new Vector3(), spin: new Vector3(), floor, bounced: true, landed: true, age: 0, keep: true, highlight, root: item });
  }

  /** Walk along: returns what Cody (on foot at `pos`, or null) picked up this frame. */
  update(dt: number, pos: Vector3 | null): ItemKind[] {
    this.t += dt;
    const got: ItemKind[] = [];
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i] as Part;
      p.age += dt;
      if (!p.landed) this.fly(p, dt);
      p.root.position.copy(p.pos);
      p.highlight?.update(dt);
      if (!p.keep) p.root.scale.setScalar(Math.min(1, (J.life - p.age) / FADE));
      const taken = p.landed && pos !== null && Math.hypot(pos.x - p.pos.x, pos.z - p.pos.z) < J.reach && Math.abs(pos.y - p.floor) < J.reach;
      if (taken) got.push(p.kind);
      if (taken || (!p.keep && p.age >= J.life)) this.remove(i);
    }
    return got;
  }

  private lose(car: Vehicle, at: Vector3, n: number): void {
    // the phantom truck is made of sterner stuff
    if (car.form === 'truck') return;
    let s = this.shed.get(car);
    if (!s) this.shed.set(car, (s = { parts: 0, tires: 0, at: -Infinity }));
    if (this.t - s.at < J.cooldown) return;
    s.at = this.t;
    // straight out from the car through the hit
    const out = Math.atan2(at.x - car.pos.x, at.z - car.pos.z);
    for (let k = 0; k < n && s.parts < J.perCar; k++) {
      const tire = s.tires < car.rig.wheels.length && this.rng.next() < J.tireShare;
      const kind = tire ? 'tire' : (this.rng.pick(PART_KINDS.filter((c) => c !== 'tire')) as PartKind);
      if (tire) s.tires++;
      s.parts++;
      this.throw(kind, at, out + this.rng.range(-SPREAD, SPREAD));
    }
    // too much lying about: the oldest junk goes (never what's kept)
    for (let i = 0, n = this.parts.length; n > J.max && i < this.parts.length; ) {
      if ((this.parts[i] as Part).keep) i++;
      else {
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
      spin: new Vector3(this.rng.range(-TUMBLE, TUMBLE), this.rng.range(-TUMBLE, TUMBLE), this.rng.range(-TUMBLE, TUMBLE)),
      floor: at.y,
      bounced: false,
      landed: false,
      age: 0,
      keep: false,
      highlight: null,
      root,
    });
  }

  /** In the air: arc and tumble; on the ground, bounce once, then lie flat (turned however it came down). */
  private fly(p: Part, dt: number): void {
    p.vel.y -= GRAVITY * dt;
    p.pos.addScaledVector(p.vel, dt);
    const r = p.root.rotation;
    r.x += p.spin.x * dt;
    r.y += p.spin.y * dt;
    r.z += p.spin.z * dt;
    if (p.vel.y >= 0) return;
    p.floor = this.nav.heightAt(p.pos.x, p.pos.y + LOOK_UP, p.pos.z) ?? p.floor;
    if (p.pos.y > p.floor) return;
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
