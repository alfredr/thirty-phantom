import { type Object3D, Vector3 } from 'three';

import { buildGasCan } from '@/actors/models/gas-can';
import { buildKeys } from '@/actors/models/keys';
import {
  effect,
  gesture,
  type Home,
  homeOf,
  type NpcAction,
  putBack,
  Take,
  wait,
} from '@/actors/npcs/npc-actions';
import type { Npc } from '@/actors/npcs/npcs';
import { driverDoor } from '@/actors/vehicles/doors';
import type { Vehicle } from '@/actors/vehicles/vehicle';
import { releaseOnce } from '@/engine/core/disposable';
import { done } from '@/engine/sim/action';
import { Sequence } from '@/engine/sim/sequence';
import type { Game } from '@/game/game';

import type { NpcSceneBindings } from './npc-scene';
import {
  roof,
  type RoofAction,
  type RoofDefinition,
  type RoofPoint,
} from './roof-choreography';

const KEYS_OFF = 0.6;
const KEYS_SCALE = 1.7;
const CAN_SPREAD = 0.8;
const CAN_BACK = 0.3;
const FILL_BACK = 0.3;
const FILL_STAND = 0.75;
const GRIP_DROP = 0.42;
const POUR = 3.2;
const GLUG = 0.45;
const SPLASH = 1.2;
const LIE = Math.PI / 2;
const HAND_GAP = 1.05;
const OFFER_FOR = 0.5;
const TAKE_FOR = 0.9;
const TAKE_AT = 0.4;
const HELD = 1.8;

const _a = new Vector3();
const _b = new Vector3();
const _s = new Vector3();

export function fillPoint(v: Vehicle): Vector3 {
  const back = v.params.length * FILL_BACK;
  const p = driverDoor(v, 0, new Vector3());
  return p.set(
    p.x - Math.sin(v.yaw) * back,
    v.pos.y + 1,
    p.z - Math.cos(v.yaw) * back,
  );
}

function beside(v: Vehicle, at: Vector3, out: number): Vector3 {
  const lx = Math.cos(v.yaw);
  const lz = -Math.sin(v.yaw);
  const side = Math.sign((at.x - v.pos.x) * lx + (at.z - v.pos.z) * lz) || 1;
  return new Vector3(at.x + lx * side * out, at.y, at.z + lz * side * out);
}

export function canSpots(fire: Vector3, keeper: Vector3): [Vector3, Vector3] {
  const d = _a.subVectors(fire, keeper).setY(0).normalize();
  const perp = _b.set(-d.z, 0, d.x);
  const spot = (s: number): Vector3 =>
    fire
      .clone()
      .addScaledVector(perp, s * CAN_SPREAD)
      .addScaledVector(d, -CAN_BACK);
  return [spot(1), spot(-1)];
}

export class RoofScene {
  readonly cans: Object3D[] = [];
  keys: Object3D | null = null;
  poured = false;
  flared = false;
  private badgeHome: Home | null = null;

  constructor(private readonly game: Game) {}

  setup(randy: Npc): void {
    const g = this.game;
    for (const old of [...this.cans, this.keys]) {
      old?.removeFromParent();
    }

    this.cans.length = 0;
    this.keys = null;
    this.poured = false;
    this.flared = false;
    const badge = randy.prop('badge');
    this.badgeHome ??= homeOf(badge);

    if (this.badgeHome) {
      putBack(badge, this.badgeHome);
    }

    badge.visible = false;
    const fire = randy.fire?.root.position ?? randy.pos;
    for (const at of canSpots(fire, randy.pos)) {
      const can = buildGasCan();
      can.position.set(
        at.x,
        g.world.collision.groundAt(at.x, at.z, at.y + 1, 0),
        at.z,
      );
      can.rotation.y = Math.atan2(fire.x - at.x, fire.z - at.z);
      g.scene.add(can);
      this.cans.push(can);
    }
  }

  dropKeys(pickup: Vehicle): void {
    const g = this.game;
    const cody = g.player.pos;
    const az = g.iso.azimuth;
    const at = _a
      .set(Math.sin(az), 0, Math.cos(az))
      .multiplyScalar(KEYS_OFF)
      .add(cody);
    const keys = buildKeys();
    keys.position.set(
      at.x,
      g.world.collision.groundAt(at.x, at.z, cody.y + 0.5, 0) + 0.02,
      at.z,
    );
    keys.scale.setScalar(KEYS_SCALE);
    keys.rotation.y = pickup.yaw;
    g.scene.add(keys);
    this.keys = keys;
    pickup.ignition.transfer(g.inventory.keys, 'ground');
    g.events.emit('sfx', { name: 'keys-clink', at: keys.position.clone() });
  }

  turnToward(at: Vector3): void {
    const p = this.game.player;
    p.place(p.pos.clone(), Math.atan2(at.x - p.pos.x, at.z - p.pos.z));
  }

  play(
    definition: RoofDefinition,
    randy: Npc,
    pickup: Vehicle,
    home = randy.pos,
  ): NpcAction {
    return roof.play(definition, this.sceneBindings(randy, pickup, home));
  }

  private takeBadge(randy: Npc, pickup: Vehicle): NpcAction {
    const g = this.game;
    const cody = g.player;
    const badge = randy.prop('badge');
    const home = this.badgeHome;
    const props = this;
    return new Sequence(function* () {
      if (!home) {
        return done;
      }

      using _offer = releaseOnce(() => {
        cody.offer(0);

        if (badge.parent === cody.palm) {
          putBack(badge, home);
        }
      });
      props.turnToward(randy.pos);
      g.inventory.take('badge', 1);
      props.palm(cody.palm, badge);
      cody.offer(1);
      props.dropKeys(pickup);
      yield wait(OFFER_FOR);
      return yield new Take({
        npc: randy,
        item: badge,
        home,
        seconds: TAKE_FOR,
        at: TAKE_AT,
        took: () => cody.offer(0),
      });
    });
  }

  private skipBadge(randy: Npc, pickup: Vehicle): void {
    const g = this.game;
    g.inventory.take('badge', 1);
    g.player.offer(0);

    if (this.badgeHome) {
      putBack(randy.prop('badge'), this.badgeHome);
    }

    if (!this.keys && pickup.ignition.heldBy(g.inventory.keys)) {
      this.dropKeys(pickup);
    }
  }

  private palm(palm: Object3D, item: Object3D): void {
    palm.add(item);
    palm.updateWorldMatrix(true, false);
    palm.getWorldScale(_s);
    item.quaternion.identity();
    item.scale.set(HELD / _s.x, HELD / _s.y, HELD / _s.z);
    const card = item.children[0]?.position;
    item.position.set(
      -(card?.x ?? 0) * item.scale.x,
      -(card?.y ?? 0) * item.scale.y,
      -(card?.z ?? 0) * item.scale.z,
    );
    item.visible = true;
  }

  dropCan(randy: Npc, i: number): void {
    const can = this.cans[i];
    if (!can || can.parent === this.game.scene) {
      return;
    }

    randy.release(can, this.game.scene);
    can.rotation.set(0, randy.yaw, LIE);
    const p = can.position;
    p.y =
      this.game.world.collision.groundAt(p.x, p.z, randy.pos.y + 1, 0) + 0.1;
  }

  private flare(randy: Npc): void {
    const fire = randy.fire;
    if (!fire) {
      return;
    }

    fire.flare = 1;
    fire.plume = 1;
    this.flared = true;
    this.game.events.emit('sfx', {
      name: 'fire-flare',
      at: fire.root.position.clone(),
    });
  }

  private sceneBindings(
    randy: Npc,
    pickup: Vehicle,
    home: Vector3,
  ): NpcSceneBindings<'randy', RoofPoint, never, RoofAction> {
    const g = this.game;
    const cody = g.player;
    const az = g.iso.azimuth;
    const across = new Vector3(Math.cos(az), 0, -Math.sin(az));
    const side =
      Math.sign(_a.subVectors(randy.pos, cody.pos).dot(across)) || 1;
    const fill = fillPoint(pickup);
    const fire = randy.fire?.root.position.clone() ?? randy.pos.clone();
    const holdCan = (i: number): NpcAction =>
      effect(() => {
        const can = this.cans[i];
        if (can) {
          randy.attach(can, 'leftHand', GRIP_DROP);
        }
      });
    const pour = (into: Vector3, seconds: number): NpcAction =>
      gesture(randy, 'pour', seconds, {
        every: GLUG,
        run: () =>
          g.events.emit('sfx', { name: 'gas-glug', at: into.clone() }),
      });
    const pocketKeys = (): void => {
      this.keys?.removeFromParent();
      this.keys = null;

      if (pickup.ignition.heldBy('ground')) {
        pickup.ignition.transfer('ground', randy.keys);
      }
    };

    return {
      actors: { randy },
      points: {
        handoff: cody.pos.clone().addScaledVector(across, side * HAND_GAP),
        keys: this.keys?.position.clone() ?? randy.pos.clone(),
        gasCan: this.cans[0]?.position.clone() ?? randy.pos.clone(),
        bastingCan: this.cans[1]?.position.clone() ?? randy.pos.clone(),
        fillStand: beside(pickup, fill, FILL_STAND).setY(randy.pos.y),
        fill,
        home: home.clone(),
        fire,
      },
      shots: {},
      actions: {
        takeBadge: () => this.takeBadge(randy, pickup),
        skipBadge: () => effect(() => this.skipBadge(randy, pickup)),
        holdKeys: () =>
          effect(() => {
            if (this.keys) {
              randy.attach(this.keys, 'leftHand');
              pickup.ignition.transfer('ground', randy.keys);
            }
          }),
        pocketKeys: () => effect(pocketKeys),
        holdGasCan: () => holdCan(0),
        holdBastingCan: () => holdCan(1),
        pourFuel: () => pour(fill, POUR),
        basteFire: () => pour(fire, SPLASH),
        markPoured: () =>
          effect(() => {
            this.poured = true;
          }),
        flare: () => effect(() => this.flare(randy)),
        dropBastingCan: () => effect(() => this.dropCan(randy, 1)),
      },
    };
  }
}
