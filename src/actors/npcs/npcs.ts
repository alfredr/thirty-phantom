import { type Object3D, type Scene, Vector3 } from 'three';

import { Keyring } from '@/actors/vehicles/ignition';
import type { Mind } from '@/engine/sim/mind';
import { Smoke } from '@/fx/smoke';
import type { SpriteFx } from '@/fx/sprite-fx';
import type { ItemKind } from '@/game/items/item-breeds';
import { Stock } from '@/game/items/stock';
import type { ItemAmount } from '@/game/items/trades';
import type { NpcDef } from '@/world/level-data';

import type { NpcEvent, Pitch, Work } from './behaviors';
import { NPC_BREEDS, type NpcBreed } from './breeds';
import { Fire, type FireWorld } from './fire';
import type { NpcModel } from './presentation';
import { Throwing, type ThrowWorld } from './throwing';

/** Maximum vertical separation for conversations, in meters. */
const SAME_LEVEL = 2;
/** Spread idle animation phases over this many seconds. */
const ANIMATION_PHASE = 5;

/** Scene services and notifications available to NPC capabilities. */
export interface NpcWorld extends FireWorld, ThrowWorld {
  readonly sprites: Pick<SpriteFx, 'emit'>;
  fed(reward: ItemAmount): void;
}

/** An NPC's model, stock, and capability instances, built from its shared breed definition. */
export class Npc {
  readonly keys = new Keyring();
  readonly pos: Vector3;
  readonly model: NpcModel;
  readonly fire: Fire | null;
  readonly throwing: Throwing | null;
  readonly stock: Stock | null;
  readonly pitch: Mind<Npc, Pitch, NpcEvent> | null;
  readonly work: Mind<Npc, Work, NpcEvent> | null;
  private readonly smoke: Smoke | null;
  /** Resting and current yaw in radians. Use place() to move the NPC and fire together. */
  homeYaw: number;
  yaw: number;
  /** Animation time with an independent phase for each NPC. */
  t = Math.random() * ANIMATION_PHASE;
  /** Whether Cody is on foot within the breed's attention range. */
  near = false;

  constructor(
    readonly def: NpcDef,
    readonly breed: NpcBreed,
    readonly world: NpcWorld,
  ) {
    this.pos = new Vector3(...def.pos);
    this.homeYaw = this.yaw = def.yaw;
    this.model = breed.model();
    this.model.root.position.copy(this.pos);
    this.model.root.rotation.y = this.yaw;
    world.scene.add(this.model.root);
    this.fire =
      def.fire && breed.fire
        ? new Fire(breed.fire, world, { pos: this.pos, yaw: this.yaw, time: this.t }, def.fire)
        : null;
    this.throwing = null;

    if (breed.throwing) {
      if (!this.model.throwArm) {
        throw new Error(`${breed.name} needs a throwing arm`);
      }

      this.throwing = new Throwing(breed.throwing, this.model.throwArm, this.model.props ?? {}, world);
    }

    this.stock = breed.shop ? new Stock(breed.shop.stock) : null;
    this.pitch = breed.pitch?.(this) ?? null;
    this.work = breed.work?.(this) ?? null;
    this.smoke = null;

    if (breed.smoke) {
      if (!this.model.smokeOrigin) {
        throw new Error(`${breed.name} needs a smoke origin`);
      }

      this.smoke = new Smoke(breed.smoke, this.model.smokeOrigin, world.sprites);
    }
  }

  /** Require a named prop for a scripted scene. Missing props indicate a scene/model mismatch. */
  prop(kind: ItemKind): Object3D {
    const prop = this.model.props?.[kind];
    if (!prop) {
      throw new Error(`${this.breed.name} has no ${kind} prop`);
    }

    return prop;
  }

  /** Whether a scene controls facing and presentation. */
  get held(): boolean {
    return !!this.pitch?.in('directed');
  }

  /** Scene-specified look target, or null to use Cody's position. */
  get face(): Vector3 | null {
    return this.pitch?.in('directed')?.face ?? null;
  }

  /** Whether the current pitch state requests an open coat. */
  get pitching(): boolean {
    const s = this.pitch?.state;
    return s?.at === 'pitching' || s?.at === 'browsing' || (s?.at === 'directed' && s.open);
  }

  /** Send an event to the pitch and work behaviors. Return whether either transitioned. */
  send(event: NpcEvent): boolean {
    const pitch = this.pitch?.send(event) ?? false;
    const work = this.work?.send(event) ?? false;
    return pitch || work;
  }

  /** Move the NPC and its fire together and set the resting yaw. */
  place(pos: Vector3, yaw: number): void {
    this.pos.copy(pos);
    this.homeYaw = this.yaw = yaw;
    this.model.root.position.copy(pos);
    this.model.root.rotation.y = yaw;
    this.fire?.moveWith(pos, yaw);
  }

  /** Advance behaviors and animation. Null disables responses to Cody's proximity. */
  update(dt: number, cody: Vector3 | null): void {
    this.t += dt;
    const attention = this.breed.attention;
    this.near = !!(
      attention &&
      cody &&
      Math.hypot(cody.x - this.pos.x, cody.z - this.pos.z) < attention.reach &&
      Math.abs(cody.y - this.pos.y) < attention.level
    );
    this.pitch?.tick(dt);
    this.work?.tick(dt);
    this.model.pose?.(this, dt, cody);
    this.smoke?.update(dt, this.breed.smoke?.active(this) ?? false);
    this.throwing?.update(dt);
    this.fire?.update(dt);
  }
}

/** Create, find, and update NPCs placed in the level. */
export class Npcs {
  readonly list: Npc[];

  constructor(defs: readonly NpcDef[], scene: Scene, hooks: Omit<NpcWorld, 'scene'>) {
    const world: NpcWorld = { scene, ...hooks };
    this.list = defs.map((def) => new Npc(def, NPC_BREEDS[def.id], world));
  }

  find(id: NpcDef['id']): Npc | null {
    return this.list.find((n) => n.def.id === id) ?? null;
  }

  /** Return the nearest NPC within the horizontal reach and level tolerance. */
  talkable(p: Vector3, reach: number): Npc | null {
    let best: Npc | null = null;
    let distance = reach;
    for (const n of this.list) {
      const d = Math.hypot(n.pos.x - p.x, n.pos.z - p.z);
      if (d < distance && Math.abs(n.pos.y - p.y) < SAME_LEVEL) {
        distance = d;
        best = n;
      }
    }

    return best;
  }

  update(dt: number, cody: Vector3 | null): void {
    for (const n of this.list) {
      n.update(dt, cody);
    }
  }
}
