import { type Object3D, type Scene, Vector3 } from 'three';

import { Keyring } from '@/actors/vehicles/ignition';
import { Walker } from '@/actors/walker';
import type { Polyline } from '@/engine/nav/polyline';
import { Doing } from '@/engine/sim/action';
import { Leases } from '@/engine/sim/leases';
import type { Mind } from '@/engine/sim/mind';
import { Sequence } from '@/engine/sim/sequence';
import { Smoke } from '@/fx/smoke';
import type { SpriteFx } from '@/fx/sprite-fx';
import type { ItemKind } from '@/game/items/item-breeds';
import { Stock } from '@/game/items/stock';
import type { ItemAmount } from '@/game/items/trades';
import type { NpcDef, ZoneDef } from '@/world/level-data';
import { type NavGrid, type NavHop, type NavPlanner, NO_HOPS } from '@/world/nav-grid';

import type { Facing, NpcEvent, Pitch, Work } from './behaviors';
import { NPC_BREEDS, type NpcBreed } from './breeds';
import { Fire, type FireWorld } from './fire';
import type { NpcAction } from './npc-actions';
import type { Hand, NpcModel } from './presentation';
import { clampAround, heading, offBy, turnToward, type Turning } from './steering';
import { Throwing, type ThrowWorld } from './throwing';

/** Maximum vertical separation for conversations, in meters. */
const SAME_LEVEL = 2;
export const WALK_SPEED = 1.5;
/** Spread idle animation phases over this many seconds. */
const ANIMATION_PHASE = 5;
const ANCHOR = 0.3;
const SET_OFF = 0.7;
const SET_OFF_DONE = 0.2;
const STEER_MIN = 0.15;
const IN_PLACE = 0.8;
const MOVING = 0.05;
const STANDING: Turning = { rate: 7, speed: 4.5 };
const STRIDING: Turning = { rate: 10, speed: 6 };

const _ahead = new Vector3();

export type RunStatus = 'running' | 'done' | 'failed' | 'cancelled';

export class NpcRun {
  status: RunStatus = 'running';
  reason: string | null = null;

  constructor(readonly act: NpcAction) {}

  get running(): boolean {
    return this.status === 'running';
  }

  end(status: Exclude<RunStatus, 'running'>, reason: string | null = null): void {
    if (this.running) {
      this.status = status;
      this.reason = reason;
    }
  }
}

/** Scene services and notifications available to NPC capabilities. */
export interface NpcWorld extends FireWorld, ThrowWorld {
  readonly sprites: Pick<SpriteFx, 'emit'>;
  readonly nav: NavGrid;
  readonly planner: NavPlanner;
  walkBlocks(): readonly ZoneDef[];
  fed(reward: ItemAmount): void;
}

/** An NPC's model, stock, and capability instances, built from its shared breed definition. */
export class Npc {
  readonly keys = new Keyring();
  readonly walker: Walker;
  readonly pos: Vector3;
  readonly model: NpcModel;
  readonly fire: Fire | null;
  readonly throwing: Throwing | null;
  readonly stock: Stock | null;
  readonly pitch: Mind<Npc, Pitch, NpcEvent> | null;
  readonly work: Mind<Npc, Work, NpcEvent> | null;
  readonly attention = new Leases<{ face: Facing }>((held) => {
    this.send(held ? { type: 'held', face: held.face } : { type: 'released' });
  });
  private readonly smoke: Smoke | null;
  /** Resting and current yaw in radians. Use place() to move the NPC and fire together. */
  homeYaw: number;
  yaw: number;
  /** Animation time with an independent phase for each NPC. */
  t = Math.random() * ANIMATION_PHASE;
  /** Whether Cody is on foot within the breed's attention range. */
  near = false;
  reaching = 0;
  bending = 0;
  pouring = 0;
  gaze: number | null = null;
  private readonly home = new Vector3();
  private restYaw: number;
  private setOff: number | null = null;
  private frozen = false;
  private watching: Vector3 | null = null;
  private readonly doing = new Doing<NpcWorld, NpcWorld>({
    lost: () => false,
    end: () => undefined,
    performed: (a) => this.settle(a, 'done'),
    failed: (a, reason) => this.settle(a, 'failed', reason),
  });
  private directive: NpcRun | null = null;

  constructor(
    readonly def: NpcDef,
    readonly breed: NpcBreed,
    readonly world: NpcWorld,
  ) {
    this.model = breed.model();
    this.walker = new Walker(this.model.rig, null);
    this.walker.place(new Vector3(...def.pos), def.yaw);
    this.pos = this.walker.pos;
    this.home.copy(this.pos);
    this.homeYaw = this.yaw = this.restYaw = def.yaw;
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

  inHand(kind: ItemKind): Object3D {
    const item = this.model.palm?.[kind];
    if (!item) {
      throw new Error(`${this.breed.name} has no ${kind} to hold`);
    }

    return item;
  }

  /** Whether a scene controls facing and presentation. */
  get held(): boolean {
    return !!this.pitch?.in('directed');
  }

  /** Scene-specified look target or yaw, or null to use Cody's position. */
  get face(): Facing {
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

  get walking(): boolean {
    return this.walker.walking;
  }

  get pace(): number {
    return this.frozen ? 0 : this.walker.speed;
  }

  get anchored(): boolean {
    return !!this.fire && Math.hypot(this.pos.x - this.home.x, this.pos.z - this.home.z) < ANCHOR;
  }

  walk(path: Polyline, speed = WALK_SPEED, hops: readonly NavHop[] = NO_HOPS): void {
    this.walker.follow(path, speed, hops);
    const ahead = path.sample(Math.min(SET_OFF, path.total), _ahead);
    this.setOff = Math.hypot(ahead.x - this.pos.x, ahead.z - this.pos.z) > STEER_MIN ? heading(this.pos, ahead) : null;
  }

  halt(path?: Polyline): void {
    if (path && this.walker.goal !== path.end) {
      return;
    }

    this.walker.stop();
    this.setOff = null;
    this.frozen = false;
    this.restYaw = this.yaw;
  }

  lookAt(face: Facing): void {
    const held = this.attention.top;
    if (held) {
      held.face = face;
    }

    this.send({ type: 'held', face });
  }

  aligned(within: number): boolean {
    return !this.walking && offBy(this.yaw, this.standingYaw(this.gazeAt())) <= within;
  }

  direct(steps: readonly NpcAction[]): NpcRun {
    this.stopDirecting();
    const run = new NpcRun(new Sequence<NpcWorld, NpcWorld>(steps));
    this.directive = run;
    this.doing.do(this.world, run.act);
    return run;
  }

  stopDirecting(run: NpcRun | null = this.directive): void {
    if (!run) {
      return;
    }

    if (run.running) {
      run.end('cancelled');
      this.doing.cancel(run.act);
    }

    if (run === this.directive) {
      this.directive = null;
    }
  }

  hand(name: Hand): Object3D {
    const hand = this.model.hands?.[name];
    if (!hand) {
      throw new Error(`${this.breed.name} has no ${name}`);
    }

    return hand;
  }

  attach(item: Object3D, hand: Hand, below = 0): void {
    this.hand(hand).add(item);
    item.position.set(0, -below, 0);
    item.rotation.set(0, 0, 0);
  }

  release(item: Object3D, into: Object3D | null): void {
    if (into) {
      into.attach(item);
    } else {
      item.removeFromParent();
    }
  }

  reach(seconds: number): void {
    this.reaching = seconds;
  }

  bend(seconds: number): void {
    this.bending = seconds;
  }

  pour(seconds: number): void {
    this.pouring = seconds;
  }

  /** Move the NPC and its fire together and set the resting yaw. */
  place(pos: Vector3, yaw: number): void {
    this.stopDirecting();
    this.walker.place(pos, yaw);
    this.home.copy(this.pos);
    this.homeYaw = this.yaw = this.restYaw = yaw;
    this.setOff = null;
    this.frozen = false;
    this.model.root.rotation.y = yaw;
    this.fire?.moveWith(pos, yaw);
  }

  /** Advance behaviors and animation. Null disables responses to Cody's proximity. */
  update(dt: number, cody: Vector3 | null): void {
    this.t += dt;
    this.reaching = Math.max(0, this.reaching - dt);
    this.bending = Math.max(0, this.bending - dt);
    this.pouring = Math.max(0, this.pouring - dt);
    const attention = this.breed.attention;
    this.near = !!(
      attention &&
      cody &&
      Math.hypot(cody.x - this.pos.x, cody.z - this.pos.z) < attention.reach &&
      Math.abs(cody.y - this.pos.y) < attention.level
    );
    this.pitch?.tick(dt);
    this.work?.tick(dt);
    this.watching = cody;
    this.doing.update(this.world, dt);
    this.gaze = this.gazeAt();
    this.move(dt);
    this.model.pose?.(this, dt);
    this.smoke?.update(dt, this.breed.smoke?.active(this) ?? false);
    this.throwing?.update(dt);
    this.fire?.update(dt);
  }

  private settle(act: NpcAction, status: 'done' | 'failed', reason: string | null = null): void {
    if (this.directive?.act === act) {
      this.directive.end(status, reason);
    }
  }

  private gazeAt(): number | null {
    const face = this.held ? this.face : null;
    if (typeof face === 'number') {
      return face;
    }

    const at = face ?? this.watching;
    return at ? heading(this.pos, at) : null;
  }

  private standingYaw(gaze: number | null): number {
    const rest = this.anchored ? this.homeYaw : this.restYaw;
    const attend = this.held || this.pitching ? gaze : null;
    if (attend === null) {
      return rest;
    }

    const most = this.anchored ? this.model.fireTurn : undefined;
    return most === undefined ? attend : clampAround(attend, rest, most);
  }

  private move(dt: number): void {
    const w = this.walker;
    if (w.walking) {
      const v = w.vel;
      const dir = this.setOff ?? (Math.hypot(v.x, v.z) > MOVING ? Math.atan2(v.x, v.z) : this.yaw);
      this.frozen = offBy(this.yaw, dir) > IN_PLACE;
      this.yaw = turnToward(this.yaw, dir, STRIDING, dt);

      if (this.setOff !== null && offBy(this.yaw, this.setOff) < SET_OFF_DONE) {
        this.setOff = null;
      }

      w.update(this.frozen ? 0 : dt, this.world.nav);

      if (!w.walking) {
        this.frozen = false;
        this.restYaw = this.yaw;
      }
    } else {
      this.yaw = turnToward(this.yaw, this.standingYaw(this.gaze), STANDING, dt);
      w.update(dt, this.world.nav);
    }

    this.model.root.rotation.y = this.yaw;
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
