import { type Object3D, type Scene, Vector3 } from 'three';

import { buildJunk, type PartKind } from '@/actors/models/junk';
import type { V3 } from '@/engine/core/math';

export interface FireSpec {
  model(): { root: Object3D; flames: readonly Object3D[] };
  /** Height of the opening above the model's origin, in meters. */
  readonly rim: number;
}

export interface FireWorld {
  readonly scene: Scene;
  burned(at: Vector3): void;
}

/** Feeding duration in seconds, arc height and final depth below the rim in meters, and spin in rad/s. */
const FEED = { flight: 0.7, arc: 1.2, sink: 0.3, spin: 9 };
/** Additional flame scale at full strength and decay duration in seconds. */
const PLUME = { height: 2.2, width: 0.6, time: 1.6 };
const FLARE = { height: 6, width: 2.4, time: 6 };
/** Resting flame scale and flicker amplitudes, driven by two frequencies in rad/s. */
const FLICKER = { rest: 0.8, height: 0.35, width: 0.12, rates: [7.3, 11.1] as const };

interface Feed {
  item: Object3D;
  from: Vector3;
  t: number;
}

/** Own a fire's model, feeding animation, and flame intensity. */
export class Fire {
  readonly root: Object3D;
  /** Normalized plume strength, also used by the fire's audio loop. */
  plume = 0;
  flare = 0;
  private readonly flames: readonly Object3D[];
  private readonly offset: readonly [number, number];
  private feeding: Feed[] = [];
  private t: number;

  constructor(
    private readonly spec: FireSpec,
    private readonly world: FireWorld,
    home: { pos: Vector3; yaw: number; time: number },
    at: V3,
  ) {
    const model = spec.model();
    this.root = model.root;
    this.flames = model.flames;
    this.t = home.time;
    this.root.position.set(...at);
    world.scene.add(this.root);
    const dx = at[0] - home.pos.x;
    const dz = at[2] - home.pos.z;
    const c = Math.cos(home.yaw);
    const s = Math.sin(home.yaw);
    this.offset = [dx * c - dz * s, dx * s + dz * c];
  }

  /** Preserve the fire's local offset when its owner is repositioned. */
  moveWith(pos: Vector3, yaw: number): void {
    const [x, z] = this.offset;
    this.root.position.set(
      pos.x + x * Math.cos(yaw) + z * Math.sin(yaw),
      pos.y,
      pos.z - x * Math.sin(yaw) + z * Math.cos(yaw),
    );
  }

  /** Launch a part into the fire and report its arrival after removing it from the scene. */
  feed(kind: PartKind, from: Vector3): void {
    const item = buildJunk(kind);
    item.position.copy(from);
    this.world.scene.add(item);
    this.feeding.push({ item, from: from.clone(), t: 0 });
  }

  update(dt: number): void {
    this.t += dt;
    this.feedItems(dt);
    this.plume = Math.max(0, this.plume - dt / PLUME.time);
    this.flare = Math.max(0, this.flare - dt / FLARE.time);
    const roar = this.plume * this.plume;
    const blaze = this.flare * this.flare;
    this.flames.forEach((f, i) => {
      const a =
        Math.sin(this.t * FLICKER.rates[0] + i * 1.7) * 0.6 + Math.sin(this.t * FLICKER.rates[1] + i * 2.9) * 0.4;
      const wide = (1 + roar * PLUME.width) * (1 + this.flare * FLARE.width);
      f.scale.set(
        (1 + a * FLICKER.width) * wide,
        (FLICKER.rest + a * FLICKER.height) * (1 + roar * PLUME.height) * (1 + blaze * FLARE.height),
        (1 - a * FLICKER.width) * wide,
      );
    });
  }

  private feedItems(dt: number): void {
    const flying: Feed[] = [];
    const landed: Feed[] = [];
    for (const f of this.feeding) {
      f.t += dt;
      const u = Math.min(1, f.t / FEED.flight);
      const to = this.root.position;
      f.item.position.lerpVectors(f.from, to, u);
      // Finish below the rim so the item disappears inside the fire's container.
      const rim = to.y + this.spec.rim - FEED.sink * u - f.from.y;
      f.item.position.y = f.from.y + rim * u + 4 * FEED.arc * u * (1 - u);
      f.item.rotation.x += FEED.spin * dt;
      (u < 1 ? flying : landed).push(f);
    }

    this.feeding = flying;

    for (const f of landed) {
      this.world.scene.remove(f.item);
      this.plume = 1;
      this.world.burned(this.root.position);
    }
  }
}
