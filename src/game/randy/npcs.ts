import { type Object3D, Quaternion, type Scene, Vector3 } from 'three';

import { buildJunk } from '@/actors/models/junk';
import { buildRandy, type RandyRig, ROAST_LIFT } from '@/actors/models/randy';
import { buildTrashFire, CAN_TOP } from '@/actors/models/trash-fire';
import { clamp, damp, dampAngle, wrapAngle } from '@/engine/core/math';
import { Mind } from '@/engine/sim/mind';
import { ArcPath } from '@/fx/arc-path';
import { Highlight } from '@/fx/highlight';
import type { NpcDef } from '@/world/level-data';

import { type Pitch, RANDY_PITCH, RANDY_WORK, type RandyEvent, type Work } from './randy-mind';

/** Horizontal attention range and maximum vertical separation, in meters. */
const PITCH_REACH = 5;
const SAME_LEVEL = 2;
/**
 * Left coat flap opening angle in radians and damping rate. Only the left flap opens because the right hand holds the
 * roasting stick.
 */
const FLAP_OPEN = 1.9;
const FLAP_RATE = 9;
/** Local direction from the shoulder toward the hand in the resting pose. */
const DOWN = new Vector3(0, -1, 0);
const _grip = new Vector3();
const _held = new Vector3();
const _aim = new Quaternion();
const _rest = new Quaternion();
/** Turn damping rate and maximum body and head angles in radians. Limit body rotation to keep the stick near the fire. */
const TURN_RATE = 6;
const BODY_TURN = 0.6;
const LOOK = 1.1;
/** Idle sway rate in rad/s and amplitude in meters; glance interval in seconds and angle in radians. */
const SWAY_RATE = 1.3;
const SWAY = 0.02;
const GLANCE_EVERY = 5;
const GLANCE = 0.7;
/** Roasting arm oscillation amplitude in radians and rate in rad/s. */
const TURN_MEAT = 0.06;
const TURN_MEAT_RATE = 2.2;
/** Relative flame height and width variation, driven by two frequencies in rad/s. */
const FLAME_REST = 0.8;
const FLICKER = 0.35;
const FLICKER_RATES: readonly [number, number] = [7.3, 11.1];
const WOBBLE = 0.12;
/**
 * Throw timing, arm angles, arc height, and clearance. Flight duration grows with distance and has a gravity-based
 * minimum. Distances use meters, times use seconds, and gravity uses m/s²; TOSS_LAND is the final path fraction exempt
 * from clearance checks.
 */
const TOSS_WIND = 0.75;
const TOSS_BACK = 1.15;
const TOSS_THROUGH = 1.7;
const TOSS_FLIGHT = 0.8;
const TOSS_SPEED = 14;
const TOSS_ARC = 0.8;
const TOSS_ARC_PER_M = 0.15;
const TOSS_CLEAR = 0.6;
const TOSS_LAND = 0.06;
const TOSS_G = 9.8;
/** Number of intervals used to sample throw clearance. */
const TOSS_SAMPLES = 40;
const TOSS_SPIN = 9;
const ARM_RATE = 8;
/** Fire-feeding flight duration in seconds, arc height in meters, and final depth below the rim in meters. */
const FEED_FLIGHT = 0.7;
const FEED_ARC = 1.2;
const FEED_SINK = 0.3;
/** Additional peak flame scale and plume decay duration in seconds. */
const PLUME_HEIGHT = 2.2;
const PLUME_WIDTH = 0.6;
const PLUME_TIME = 1.6;

/** NPC display names. */
export const NPC_NAMES: Readonly<Record<NpcDef['id'], string>> = { randy: 'RANDY' };

/** Fire rig and its horizontal offset in the NPC’s local coordinates. */
export interface TrashFire {
  root: Object3D;
  flames: readonly Object3D[];
  at: [number, number];
}

/** Active throw, including world-space endpoints, elapsed time, flight duration, and original hand attachment. */
interface Toss {
  item: Object3D;
  to: Vector3;
  from: Vector3;
  flight: number;
  t: number;
  released: boolean;
  hand: { parent: Object3D | null; pos: Vector3; quat: Quaternion };
  highlight: Highlight;
  path: ArcPath | null;
  lift: number;
}

/** An item traveling into the fire, with its completion callback. */
interface Feed {
  item: Object3D;
  from: Vector3;
  t: number;
  done: () => void;
}

/**
 * Randy’s rig, fire, and independent pitch and work state machines. Events coordinate scripted scenes, browsing, and
 * tire feeding; see randy-mind.ts.
 */
export class Npc {
  readonly pitch: Mind<Npc, Pitch, RandyEvent>;
  readonly work: Mind<Npc, Work, RandyEvent>;
  /** Resting and current yaw in radians. Use Npcs.place to move the NPC and fire together. */
  homeYaw: number;
  yaw: number;
  /** Coat opening fraction from zero to one. */
  open = 0;
  t = Math.random() * GLANCE_EVERY;
  /** Whether Cody is on foot within the attention range and level tolerance. */
  near = false;
  toss: Toss | null = null;
  /** Normalized fire plume strength, decaying from one to zero. */
  plume = 0;
  /** Items currently traveling into the fire. */
  feeding: Feed[] = [];

  constructor(
    readonly def: NpcDef,
    readonly rig: RandyRig,
    /** World position. */
    readonly pos: Vector3,
    readonly fire: TrashFire | null,
    readonly npcs: Npcs,
  ) {
    this.homeYaw = this.yaw = def.yaw;
    this.pitch = new Mind<Npc, Pitch, RandyEvent>(RANDY_PITCH, this, { at: 'resting', t: 0 });
    this.work = new Mind<Npc, Work, RandyEvent>(RANDY_WORK, this, { at: 'roasting' });
  }

  /** Whether a scene controls Randy’s facing and coat. */
  get held(): boolean {
    return !!this.pitch.in('directed');
  }

  /** Scene-specified look target, or null to use Cody’s position. */
  get face(): Vector3 | null {
    return this.pitch.in('directed')?.face ?? null;
  }

  /** Whether the current pitch state requests an open coat. */
  get pitching(): boolean {
    const s = this.pitch.state;
    return s.at === 'pitching' || s.at === 'browsing' || (s.at === 'directed' && s.open);
  }

  /** Send the event to both state machines and report whether either transitioned. */
  send(event: RandyEvent): boolean {
    const pitch = this.pitch.send(event);
    const work = this.work.send(event);
    return pitch || work;
  }
}

/** NPC animation callbacks and terrain queries. */
export interface NpcHooks {
  /** Register a landed copy as a pickup at ground height `floor`; the original returns to the hand, hidden. */
  landed(item: Object3D, floor: number): void;
  /** Return the highest surface at or below `below` for throw-clearance checks. */
  ground(x: number, z: number, below: number): number;
  /** Report a tire entering the fire. */
  burned(at: Vector3): void;
  /** Report completion of the tire-feeding sequence. */
  fed(n: number): void;
}

/**
 * Manage NPC placement, idle animation, coat display, and thrown items. Conversation systems control the NPC through
 * state-machine events.
 */
export class Npcs {
  readonly list: Npc[];

  constructor(
    defs: readonly NpcDef[],
    private readonly scene: Scene,
    private readonly hooks: NpcHooks,
  ) {
    this.list = defs.map((def) => {
      const rig = buildRandy();
      const pos = new Vector3(...def.pos);
      rig.root.position.copy(pos);
      rig.root.rotation.y = def.yaw;
      scene.add(rig.root);
      let fire: TrashFire | null = null;
      if (def.fire) {
        const built = buildTrashFire();
        built.root.position.set(...def.fire);
        scene.add(built.root);
        // Store the fire offset in local coordinates so placement can preserve it.
        const dx = def.fire[0] - pos.x;
        const dz = def.fire[2] - pos.z;
        const c = Math.cos(def.yaw);
        const sn = Math.sin(def.yaw);
        fire = { root: built.root, flames: built.flames, at: [dx * c - dz * sn, dx * sn + dz * c] };
      }

      return new Npc(def, rig, pos, fire, this);
    });
  }

  /** Move the NPC and fire together and set the resting yaw. */
  place(n: Npc, pos: Vector3, yaw: number): void {
    n.pos.copy(pos);
    n.homeYaw = n.yaw = yaw;
    n.rig.root.position.copy(pos);
    n.rig.root.rotation.y = yaw;

    if (n.fire) {
      const [x, z] = n.fire.at;
      n.fire.root.position.set(
        pos.x + x * Math.cos(yaw) + z * Math.sin(yaw),
        pos.y,
        pos.z - x * Math.sin(yaw) + z * Math.cos(yaw),
      );
    }
  }

  /**
   * Throw the badge rig to `to`, optionally displaying its path. Return the estimated duration including wind-up, in
   * seconds.
   */
  toss(n: Npc, to: Vector3, opts: { showPath?: boolean } = {}): number {
    const item = n.rig.badge;
    item.visible = true;
    const from = item.getWorldPosition(new Vector3());
    const lift = this.liftFor(from, to);
    const flight = Math.max(TOSS_FLIGHT + from.distanceTo(to) / TOSS_SPEED, fallTime(from, to, lift));
    const hand = { parent: item.parent, pos: item.position.clone(), quat: item.quaternion.clone() };
    // Show the item and destination highlights during wind-up.
    const highlight = new Highlight();
    highlight.place(from, to);
    this.scene.add(highlight.root);

    const path = opts.showPath ? new ArcPath() : null;
    if (path) {
      path.set((u, out) => arcAt(from, to, lift, u, out));
      this.scene.add(path.root);
    }

    n.toss = { item, to: to.clone(), from, flight, t: 0, released: false, hand, highlight, path, lift };
    return TOSS_WIND + flight;
  }

  /**
   * Animate a scene item into the fire, then remove it and call `done`. Without a fire, remove it and call `done`
   * immediately.
   */
  feed(n: Npc, item: Object3D, from: Vector3, done: () => void = () => {}): void {
    if (!n.fire) {
      this.scene.remove(item);
      done();
      return;
    }

    item.position.copy(from);
    n.feeding.push({ item, from: from.clone(), t: 0, done });
  }

  /** Reset the fire plume to full strength. */
  stoke(n: Npc): void {
    n.plume = 1;
  }

  /** Create and throw a tire from `from`, reporting when it enters the fire. */
  feedTire(n: Npc, from: Vector3): void {
    const tire = buildJunk('tire');
    this.scene.add(tire);
    this.feed(n, tire, from, () => {
      if (n.fire) {
        this.hooks.burned(n.fire.root.position);
      }
    });
  }

  /** Notify the game that the tire-feeding sequence has completed. */
  fed(_n: Npc, count: number): void {
    this.hooks.fed(count);
  }

  /**
   * Compute the arc lift needed for the distance and sampled surface clearance. Ignore the final landing fraction and
   * surfaces above the endpoint height allowance.
   */
  private liftFor(from: Vector3, to: Vector3): number {
    const d = from.distanceTo(to);
    let lift = 4 * (TOSS_ARC + d * TOSS_ARC_PER_M);
    const top = Math.max(from.y, to.y) + TOSS_CLEAR;
    const drop = to.y - from.y;
    for (let i = 1; i < TOSS_SAMPLES; i++) {
      const u = i / TOSS_SAMPLES;
      if (u > 1 - TOSS_LAND) {
        break;
      }

      const h = this.hooks.ground(from.x + (to.x - from.x) * u, from.z + (to.z - from.z) * u, top);
      if (!Number.isFinite(h)) {
        continue;
      }

      lift = Math.max(lift, (h + TOSS_CLEAR - from.y - drop * u * u) / (u * (1 - u)));
    }

    return lift;
  }

  /** Released trajectory displays that are fading out. */
  private trails: ArcPath[] = [];

  /** Return the NPC with the requested ID, or null. */
  find(id: NpcDef['id']): Npc | null {
    return this.list.find((n) => n.def.id === id) ?? null;
  }

  /** Return the nearest NPC within the horizontal reach and level tolerance, or null. */
  talkable(p: Vector3, reach: number): Npc | null {
    let best: Npc | null = null;
    let bd = reach;
    for (const n of this.list) {
      const d = Math.hypot(n.pos.x - p.x, n.pos.z - p.z);
      if (d < bd && Math.abs(n.pos.y - p.y) < SAME_LEVEL) {
        bd = d;
        best = n;
      }
    }

    return best;
  }

  /** Advance animation and behavior. Supply Cody’s on-foot position, or null to disable proximity responses. */
  update(dt: number, cody: Vector3 | null): void {
    const fading: ArcPath[] = [];
    for (const tr of this.trails) {
      if (tr.update(dt)) {
        fading.push(tr);
      } else {
        tr.dispose();
      }
    }

    this.trails = fading;

    for (const n of this.list) {
      n.toss?.path?.update(dt);
      n.t += dt;
      n.near =
        cody !== null &&
        Math.hypot(cody.x - n.pos.x, cody.z - n.pos.z) < PITCH_REACH &&
        Math.abs(cody.y - n.pos.y) < SAME_LEVEL;
      n.pitch.tick(dt);
      n.work.tick(dt);
      const r = n.rig;
      // Limit torso rotation so the roasting stick remains near the fire.
      const at = n.held && n.face ? n.face : cody;
      const toCody = at ? Math.atan2(at.x - n.pos.x, at.z - n.pos.z) : n.homeYaw;
      const turn = n.pitching || n.held ? clamp(wrapAngle(toCody - n.homeYaw), -BODY_TURN, BODY_TURN) : 0;
      n.yaw = dampAngle(n.yaw, n.homeYaw + turn, TURN_RATE, dt);
      r.root.rotation.y = n.yaw;
      // Open only the left flap; the right arm remains occupied by the stick.
      n.open = damp(n.open, n.pitching ? 1 : 0, FLAP_RATE, dt);
      const [left, right] = r.flaps;
      left.rotation.y = -FLAP_OPEN * n.open;
      right.rotation.y = 0;
      this.throwing(n, dt);

      if (!n.toss) {
        this.holdFlap(n);
      }

      r.armR.rotation.x = -ROAST_LIFT + Math.sin(n.t * TURN_MEAT_RATE) * TURN_MEAT;
      r.body.position.y = Math.sin(n.t * SWAY_RATE) * SWAY;
      // Track the nearby conversation target; otherwise animate an occasional glance.
      const look =
        n.near || n.held || n.face
          ? clamp(wrapAngle(toCody - n.yaw), -LOOK, LOOK)
          : Math.max(0, Math.sin((n.t / GLANCE_EVERY) * Math.PI * 2)) ** 4 * GLANCE;
      r.head.rotation.y = damp(r.head.rotation.y, look, TURN_RATE, dt);

      this.feedFire(n, dt);
      n.plume = Math.max(0, n.plume - dt / PLUME_TIME);
      const roar = n.plume * n.plume;
      n.fire?.flames.forEach((f, i) => {
        const a = Math.sin(n.t * FLICKER_RATES[0] + i * 1.7) * 0.6 + Math.sin(n.t * FLICKER_RATES[1] + i * 2.9) * 0.4;
        const wide = 1 + roar * PLUME_WIDTH;
        f.scale.set(
          (1 + a * WOBBLE) * wide,
          (FLAME_REST + a * FLICKER) * (1 + roar * PLUME_HEIGHT),
          (1 - a * WOBBLE) * wide,
        );
      });
    }
  }

  /** Aim the left arm at the flap grip and blend from rest according to the coat opening. */
  private holdFlap(n: Npc): void {
    if (n.open < 0.01) {
      return;
    }

    const arm = n.rig.armL;
    const parent = arm.parent;
    if (!parent) {
      return;
    }

    n.rig.grips[0].getWorldPosition(_grip);
    parent.worldToLocal(_grip);
    _aim.setFromUnitVectors(DOWN, _grip.sub(arm.position).normalize());
    arm.quaternion.slerpQuaternions(_rest.identity(), _aim, n.open);
  }

  /** Advance items into the fire and invoke their callbacks after removal. */
  private feedFire(n: Npc, dt: number): void {
    const fire = n.fire;
    if (!fire) {
      return;
    }

    const flying: Feed[] = [];
    const landed: Feed[] = [];
    for (const f of n.feeding) {
      f.t += dt;
      const u = Math.min(1, f.t / FEED_FLIGHT);
      const to = fire.root.position;
      f.item.position.lerpVectors(f.from, to, u);
      // Finish below the rim so the item disappears inside the can.
      const rim = to.y + CAN_TOP - FEED_SINK * u - f.from.y;
      f.item.position.y = f.from.y + rim * u + 4 * FEED_ARC * u * (1 - u);
      f.item.rotation.x += TOSS_SPIN * dt;
      (u < 1 ? flying : landed).push(f);
    }

    n.feeding = flying;

    for (const f of landed) {
      this.scene.remove(f.item);
      this.stoke(n);
      f.done();
    }
  }

  /** Animate wind-up, release, flight, and restoration of the reusable badge rig. */
  private throwing(n: Npc, dt: number): void {
    const arm = n.rig.armL;
    const tw = n.toss;
    if (!tw) {
      arm.rotation.x = damp(arm.rotation.x, 0, ARM_RATE, dt);
      return;
    }

    tw.t += dt;
    tw.highlight.update(dt);
    tw.highlight.place(tw.item.getWorldPosition(_held), tw.to);

    if (!tw.released) {
      const k = tw.t / TOSS_WIND;
      arm.rotation.x = k < 0.5 ? TOSS_BACK * (k / 0.5) : TOSS_BACK - (TOSS_BACK + TOSS_THROUGH) * ((k - 0.5) / 0.5);

      if (k < 1) {
        return;
      }

      // Detach while preserving the item’s world transform.
      tw.released = true;
      tw.item.getWorldPosition(tw.from);
      this.scene.attach(tw.item);
      tw.t = 0;
      // Recalculate clearance from the hand’s actual release position.
      tw.lift = this.liftFor(tw.from, tw.to);
      tw.path?.set((u, out) => arcAt(tw.from, tw.to, tw.lift, u, out));
    }

    arm.rotation.x = damp(arm.rotation.x, 0, ARM_RATE, dt);
    const u = Math.min(1, tw.t / tw.flight);
    arcAt(tw.from, tw.to, tw.lift, u, tw.item.position);
    tw.item.rotation.x += TOSS_SPIN * dt;
    tw.item.rotation.z += TOSS_SPIN * 0.6 * dt;

    if (u >= 1) {
      // Create a landed copy and restore the original for subsequent throws.
      tw.item.rotation.set(-Math.PI / 2, 0, tw.item.rotation.z);
      n.toss = null;
      // The pickup system supplies the persistent highlight; fade the trajectory separately.
      tw.highlight.dispose();

      if (tw.path) {
        tw.path.fadeOut();
        this.trails.push(tw.path);
      }

      const lying = tw.item.clone();
      this.scene.add(lying);
      this.hooks.landed(lying, tw.to.y);
      tw.item.visible = false;
      tw.hand.parent?.add(tw.item);
      tw.item.position.copy(tw.hand.pos);
      tw.item.quaternion.copy(tw.hand.quat);
    }
  }
}

/**
 * Evaluate a throw at normalized time `u` into `out`. Horizontal motion is linear; height combines a lift parabola with
 * a quadratic endpoint drop.
 */
function arcAt(from: Vector3, to: Vector3, lift: number, u: number, out: Vector3): Vector3 {
  out.lerpVectors(from, to, u);
  out.y = from.y + lift * u * (1 - u) + (to.y - from.y) * u * u;
  return out;
}

/** Estimate ascent plus descent time under TOSS_G using the arc’s peak height, in seconds. */
function fallTime(from: Vector3, to: Vector3, lift: number): number {
  const drop = to.y - from.y;
  // Find the peak of the quadratic height curve within the flight interval.
  const u = Math.min(1, Math.max(0, lift / (2 * (lift - drop))));
  const peak = from.y + lift * u * (1 - u) + drop * u * u;
  return Math.sqrt((2 * Math.max(0, peak - from.y)) / TOSS_G) + Math.sqrt((2 * Math.max(0, peak - to.y)) / TOSS_G);
}
