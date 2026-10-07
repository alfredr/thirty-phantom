import type { Object3D, Quaternion, Vector3 } from 'three';

import type { Polyline } from '@/engine/nav/polyline';
import {
  Action,
  done,
  fail,
  instead,
  type Result,
  running,
} from '@/engine/sim/action';
import { Do, Wait } from '@/engine/sim/sequence';
import type { ItemKind } from '@/game/items/item-breeds';
import { NAV, type NavJob } from '@/world/nav-grid';

import type { Facing } from './behaviors';
import { type Npc, type NpcWorld, WALK_SPEED } from './npcs';
import type { Hand } from './presentation';
import { trimPath } from './steering';

const PLAN_WAIT = 3;
const FACE_WITHIN = 0.08;
const FACE_MAX = 2.5;

export type NpcAction = Action<NpcWorld, NpcWorld>;

export const wait = (seconds: number): NpcAction =>
  new Wait<NpcWorld, NpcWorld>(seconds);
export const effect = (run: () => void): NpcAction =>
  new Do<NpcWorld, NpcWorld>(run);

export const attachProp = (
  npc: Npc,
  hand: Hand,
  item: Object3D,
  below = 0,
): NpcAction => effect(() => npc.attach(item, hand, below));

export const releaseProp = (
  npc: Npc,
  item: Object3D,
  into: Object3D | null,
): NpcAction => effect(() => npc.release(item, into));

const snapshot = (at: Facing): Facing =>
  at === null || typeof at === 'number' ? at : at.clone();

export interface WalkToParams {
  readonly npc: Npc;
  readonly to: Vector3;
  readonly speed?: number;
  readonly arrive?: number;
  readonly face?: Facing;
}

export class WalkTo extends Action<NpcWorld, NpcWorld> {
  private job: NavJob | null = null;
  private path: Polyline | null = null;
  private t = 0;

  constructor(readonly p: WalkToParams) {
    super();
  }

  perform(w: NpcWorld, dt: number): Result<NpcAction> {
    const { npc, to } = this.p;
    if (!this.job && !this.path) {
      this.job = w.planner.request(npc.pos, to, NAV.person, {
        blocks: w.walkBlocks(),
      });
    }

    const job = this.job;
    if (job) {
      if (!job.settled) {
        return (this.t += dt) > PLAN_WAIT ? fail('NO ROUTE') : running;
      }

      this.job = null;

      if (!job.path) {
        return fail('NO ROUTE');
      }

      const path = trimPath(job.path, this.p.arrive ?? 0);
      if (!path) {
        return this.arrived();
      }

      this.path = path;
      npc.walk(path, this.p.speed ?? WALK_SPEED, job.hops);
    }

    return npc.walking ? running : this.arrived();
  }

  stop(): void {
    this.job?.cancel();
    this.job = null;

    if (this.path && this.p.npc.walking) {
      this.p.npc.halt(this.path);
    }
  }

  private arrived(): Result<NpcAction> {
    const { npc, face } = this.p;
    if (face !== undefined) {
      return instead(new Face({ npc, at: face }));
    }

    if (npc.held) {
      npc.lookAt(npc.yaw);
    }

    return done;
  }
}

export class Face extends Action<NpcWorld, NpcWorld> {
  private t = -1;

  constructor(
    readonly p: {
      readonly npc: Npc;
      readonly at: Facing;
      readonly within?: number;
    },
  ) {
    super();
  }

  perform(_w: NpcWorld, dt: number): Result<NpcAction> {
    const { npc } = this.p;
    if (this.t < 0) {
      npc.lookAt(snapshot(this.p.at));
      this.t = 0;
    } else {
      this.t += dt;
    }

    return npc.aligned(this.p.within ?? FACE_WITHIN) || this.t >= FACE_MAX
      ? done
      : running;
  }
}

export type GesturePose = 'reach' | 'bend' | 'pour';

const POSES: Readonly<Record<GesturePose, (n: Npc, seconds: number) => void>> =
  {
    reach: (n, s) => n.reach(s),
    bend: (n, s) => n.bend(s),
    pour: (n, s) => n.pour(s),
  };

export interface GestureParams {
  readonly npc: Npc;
  readonly pose: GesturePose;
  readonly seconds: number;
  readonly beat?: { readonly every: number; run(): void };
}

export class Gesture extends Action<NpcWorld, NpcWorld> {
  private t = -1;
  private next = 0;

  constructor(readonly p: GestureParams) {
    super();
  }

  perform(_w: NpcWorld, dt: number): Result<NpcAction> {
    const { npc, pose, seconds, beat } = this.p;
    if (this.t < 0) {
      POSES[pose](npc, seconds);
      this.t = 0;
      this.next = 0;
    } else {
      this.t += dt;
    }

    while (beat && this.next <= this.t && this.next < seconds) {
      beat.run();
      this.next += beat.every;
    }

    return this.t >= seconds ? done : running;
  }

  stop(): void {
    if (this.t >= 0 && this.t < this.p.seconds) {
      POSES[this.p.pose](this.p.npc, 0);
    }
  }
}

export interface ThrowParams {
  readonly npc: Npc;
  readonly kind: ItemKind;
  readonly to: Vector3;
  readonly showPath?: boolean;
  thrown?(seconds: number): void;
}

export class Throw extends Action<NpcWorld, NpcWorld> {
  private started = false;

  constructor(readonly p: ThrowParams) {
    super();
  }

  perform(): Result<NpcAction> {
    const { npc, kind, to, showPath } = this.p;
    const throwing = npc.throwing;
    if (!throwing) {
      return fail('NOTHING TO THROW WITH');
    }

    if (!this.started) {
      this.started = true;
      npc.lookAt(to.clone());
      const seconds = throwing.throw(kind, to, { showPath });
      this.p.thrown?.(seconds);
      return running;
    }

    return throwing.active ? running : done;
  }
}

export interface HandOverParams {
  readonly npc: Npc;
  readonly kind: ItemKind;
  readonly seconds: number;
  readonly at: number;
  give(): void;
}

export class HandOver extends Action<NpcWorld, NpcWorld> {
  private t = -1;
  private given = false;

  constructor(readonly p: HandOverParams) {
    super();
  }

  perform(_w: NpcWorld, dt: number): Result<NpcAction> {
    const { npc, kind, seconds, at } = this.p;
    if (this.t < 0) {
      npc.reach(seconds);
      npc.inHand(kind).visible = true;
      this.t = 0;
    } else {
      this.t += dt;
    }

    if (!this.given && this.t >= at) {
      this.given = true;
      npc.inHand(kind).visible = false;
      this.p.give();
    }

    return this.t >= seconds ? done : running;
  }

  stop(): void {
    if (this.t < 0) {
      return;
    }

    this.p.npc.inHand(this.p.kind).visible = false;
    this.p.npc.reach(0);
  }
}

export interface Home {
  readonly parent: Object3D;
  readonly position: Vector3;
  readonly quaternion: Quaternion;
  readonly scale: Vector3;
}

export function homeOf(item: Object3D): Home | null {
  const parent = item.parent;
  return parent
    ? {
        parent,
        position: item.position.clone(),
        quaternion: item.quaternion.clone(),
        scale: item.scale.clone(),
      }
    : null;
}

export function putBack(item: Object3D, home: Home): void {
  home.parent.add(item);
  item.position.copy(home.position);
  item.quaternion.copy(home.quaternion);
  item.scale.copy(home.scale);
  item.visible = true;
}

export interface TakeParams {
  readonly npc: Npc;
  readonly item: Object3D;
  readonly home: Home;
  readonly seconds: number;
  readonly at: number;
  took(): void;
}

export class Take extends Action<NpcWorld, NpcWorld> {
  private t = -1;
  private taken = false;

  constructor(readonly p: TakeParams) {
    super();
  }

  perform(_w: NpcWorld, dt: number): Result<NpcAction> {
    const { npc, item, home, seconds, at } = this.p;
    if (this.t < 0) {
      npc.reach(seconds);
      this.t = 0;
    } else {
      this.t += dt;
    }

    if (!this.taken && this.t >= at) {
      this.taken = true;
      putBack(item, home);
      this.p.took();
    }

    return this.t >= seconds ? done : running;
  }

  stop(): void {
    if (this.t >= 0) {
      this.p.npc.reach(0);
    }
  }
}

export const walkTo = (
  npc: Npc,
  to: Vector3,
  opts: Omit<WalkToParams, 'npc' | 'to'> = {},
): NpcAction => new WalkTo({ npc, to, ...opts });

export const face = (npc: Npc, at: Facing): NpcAction => new Face({ npc, at });

export const gesture = (
  npc: Npc,
  pose: GesturePose,
  seconds: number,
  beat?: GestureParams['beat'],
): NpcAction => new Gesture({ npc, pose, seconds, beat });
