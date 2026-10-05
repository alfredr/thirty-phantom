import { type Object3D, Vector3 } from 'three';

import { buildGasCan } from '@/actors/models/gas-can';
import { buildKeys } from '@/actors/models/keys';
import {
  attachProp,
  effect,
  face,
  gesture,
  type Home,
  homeOf,
  type NpcAction,
  putBack,
  releaseProp,
  Take,
  wait,
  walkTo,
} from '@/actors/npcs/npc-actions';
import type { Npc } from '@/actors/npcs/npcs';
import { driverDoor } from '@/actors/vehicles/doors';
import type { Vehicle } from '@/actors/vehicles/vehicle';
import type { Game } from '@/game/game';

const KEYS_OFF = 0.6;
const KEYS_SCALE = 1.7;
const STAND_OFF = 0.55;
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
  return p.set(p.x - Math.sin(v.yaw) * back, v.pos.y + 1, p.z - Math.cos(v.yaw) * back);
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
      can.position.set(at.x, g.world.collision.groundAt(at.x, at.z, at.y + 1, 0), at.z);
      can.rotation.y = Math.atan2(fire.x - at.x, fire.z - at.z);
      g.scene.add(can);
      this.cans.push(can);
    }
  }

  dropKeys(pickup: Vehicle): void {
    const g = this.game;
    const cody = g.player.pos;
    const az = g.iso.azimuth;
    const at = _a.set(Math.sin(az), 0, Math.cos(az)).multiplyScalar(KEYS_OFF).add(cody);
    const keys = buildKeys();
    keys.position.set(at.x, g.world.collision.groundAt(at.x, at.z, cody.y + 0.5, 0) + 0.02, at.z);
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

  handBadge(randy: Npc, pickup: Vehicle): NpcAction[] {
    const g = this.game;
    const cody = g.player;
    const badge = randy.prop('badge');
    const home = this.badgeHome;
    if (!home) {
      return [];
    }

    const az = g.iso.azimuth;
    const across = new Vector3(Math.cos(az), 0, -Math.sin(az));
    const side = Math.sign(_a.subVectors(randy.pos, cody.pos).dot(across)) || 1;
    const stand = cody.pos.clone().addScaledVector(across, side * HAND_GAP);
    return [
      walkTo(randy, stand, { face: null }),
      effect(() => {
        this.turnToward(randy.pos);
        g.inventory.take('badge', 1);
        this.palm(cody.palm, badge);
        cody.offer(1);
        this.dropKeys(pickup);
      }),
      wait(OFFER_FOR),
      new Take({ npc: randy, item: badge, home, seconds: TAKE_FOR, at: TAKE_AT, took: () => cody.offer(0) }),
    ];
  }

  skipBadge(randy: Npc, pickup: Vehicle): NpcAction[] {
    const g = this.game;
    return [
      effect(() => {
        g.inventory.take('badge', 1);
        g.player.offer(0);

        if (this.badgeHome) {
          putBack(randy.prop('badge'), this.badgeHome);
        }

        if (!this.keys && pickup.ignition.heldBy(g.inventory.keys)) {
          this.dropKeys(pickup);
        }
      }),
    ];
  }

  private palm(palm: Object3D, item: Object3D): void {
    palm.add(item);
    palm.updateWorldMatrix(true, false);
    palm.getWorldScale(_s);
    item.quaternion.identity();
    item.scale.set(HELD / _s.x, HELD / _s.y, HELD / _s.z);
    const card = item.children[0]?.position;
    item.position.set(-(card?.x ?? 0) * item.scale.x, -(card?.y ?? 0) * item.scale.y, -(card?.z ?? 0) * item.scale.z);
    item.visible = true;
  }

  pickKeys(randy: Npc, pickup: Vehicle): NpcAction[] {
    const keys = this.keys;
    if (!keys) {
      return [];
    }

    const at = keys.position.clone();
    return [
      walkTo(randy, at, { arrive: STAND_OFF, face: at }),
      gesture(randy, 'bend', 0.55),
      attachProp(randy, 'leftHand', keys),
      effect(() => pickup.ignition.transfer('ground', randy.keys)),
      gesture(randy, 'bend', 0.45),
      wait(0.15),
      releaseProp(randy, keys, null),
      effect(() => {
        this.keys = null;
      }),
      face(randy, null),
      wait(0.2),
    ];
  }

  pourGas(randy: Npc, pickup: Vehicle): NpcAction[] {
    const can = this.cans[0];
    if (!can) {
      return [];
    }

    const fill = fillPoint(pickup);
    const stand = beside(pickup, fill, FILL_STAND).setY(randy.pos.y);
    return [
      ...this.fetch(randy, can),
      walkTo(randy, stand, { face: fill }),
      ...this.pourOut(randy, fill, POUR),
      effect(() => {
        this.poured = true;
      }),
    ];
  }

  dropCan(randy: Npc, i: number): void {
    const can = this.cans[i];
    if (!can || can.parent === this.game.scene) {
      return;
    }

    randy.release(can, this.game.scene);
    can.rotation.set(0, randy.yaw, LIE);
    const p = can.position;
    p.y = this.game.world.collision.groundAt(p.x, p.z, randy.pos.y + 1, 0) + 0.1;
  }

  baste(randy: Npc, home: Vector3): NpcAction[] {
    const can = this.cans[1];
    const fire = randy.fire;
    if (!can || !fire) {
      return [];
    }

    const drum = fire.root.position.clone();
    return [
      ...this.fetch(randy, can),
      walkTo(randy, home.clone(), { face: drum }),
      ...this.pourOut(randy, drum, SPLASH),
      effect(() => this.flare(randy)),
      effect(() => this.dropCan(randy, 1)),
      wait(2.2),
    ];
  }

  skipKeys(randy: Npc, pickup: Vehicle): NpcAction[] {
    return [
      effect(() => {
        this.keys?.removeFromParent();
        this.keys = null;

        if (pickup.ignition.heldBy('ground')) {
          pickup.ignition.transfer('ground', randy.keys);
        }
      }),
    ];
  }

  skipGas(): NpcAction[] {
    return [
      effect(() => {
        this.poured = true;
      }),
    ];
  }

  skipBaste(randy: Npc): NpcAction[] {
    return [effect(() => this.flare(randy)), effect(() => this.dropCan(randy, 1))];
  }

  private flare(randy: Npc): void {
    const fire = randy.fire;
    if (!fire) {
      return;
    }

    fire.flare = 1;
    fire.plume = 1;
    this.flared = true;
    this.game.events.emit('sfx', { name: 'fire-flare', at: fire.root.position.clone() });
  }

  private fetch(randy: Npc, can: Object3D): NpcAction[] {
    const at = can.position.clone();
    return [
      walkTo(randy, at, { arrive: STAND_OFF, face: at }),
      gesture(randy, 'bend', 0.5),
      attachProp(randy, 'leftHand', can, GRIP_DROP),
      gesture(randy, 'bend', 0.4),
    ];
  }

  private pourOut(randy: Npc, into: Vector3, seconds: number): NpcAction[] {
    return [
      face(randy, into),
      gesture(randy, 'pour', seconds, {
        every: GLUG,
        run: () => this.game.events.emit('sfx', { name: 'gas-glug', at: into.clone() }),
      }),
    ];
  }
}
