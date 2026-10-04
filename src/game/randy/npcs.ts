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

/** Cody this close (m, on his level) gets Randy's attention: he looks over, and between pitches turns to him and opens his coat. */
const PITCH_REACH = 5;
const SAME_LEVEL = 2;
/**
 * He flashes one side of the coat, the left (his right hand has the stick):
 * how wide that flap swings (rad: past a right angle, so the lining and the
 * goods face whoever's in front) and how fast (damp rate). His left hand
 * holds it by its front edge the whole way.
 */
const FLAP_OPEN = 1.9;
const FLAP_RATE = 9;
/** A hanging arm points down its own -y. */
const DOWN = new Vector3(0, -1, 0);
const _grip = new Vector3();
const _held = new Vector3();
const _aim = new Quaternion();
const _rest = new Quaternion();
/** Turning (damp rate); how far his body turns from the fire toward Cody (rad, so the meat stays over it), and his head the rest of the way. */
const TURN_RATE = 6;
const BODY_TURN = 0.6;
const LOOK = 1.1;
/** Idle: a slow weight shift (rad/s, m), and a glance over his shoulder every so often (s, rad). */
const SWAY_RATE = 1.3;
const SWAY = 0.02;
const GLANCE_EVERY = 5;
const GLANCE = 0.7;
/** Turning the meat over the fire: the stick dips and rises this much (rad) at this rate (rad/s). */
const TURN_MEAT = 0.06;
const TURN_MEAT_RATE = 2.2;
/** Flames lick up and down: each one's height swings by FLICKER around FLAME_REST of its own, at two rates, and its width by WOBBLE. */
const FLAME_REST = 0.8;
const FLICKER = 0.35;
const FLICKER_RATES: readonly [number, number] = [7.3, 11.1];
const WOBBLE = 0.12;
/**
 * Tossing something from his left hand: the arm winds back and swings
 * through in TOSS_WIND seconds, letting go at the end. It flies a gravity
 * arc at least TOSS_ARC high (more for a long throw), lobbed higher if it
 * must, to pass TOSS_CLEAR over every surface under its path (the roof, a
 * parapet) till the last TOSS_LAND of the way, where it comes down; for
 * TOSS_FLIGHT plus a second per TOSS_SPEED metres, or as long as a fall
 * from its peak takes under TOSS_G. It tumbles, and lies flat where it lands.
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
/** Points along the throw checked against what's under it. */
const TOSS_SAMPLES = 40;
const TOSS_SPIN = 9;
const ARM_RATE = 8;
/** Feeding the fire: something lobbed in flies FEED_FLIGHT seconds over an arc FEED_ARC high, tumbling, and drops in below the rim. */
const FEED_FLIGHT = 0.7;
const FEED_ARC = 1.2;
const FEED_SINK = 0.3;
/** Fed, the fire plumes up: flames this much taller and wider at the peak, dying back over PLUME_TIME seconds. */
const PLUME_HEIGHT = 2.2;
const PLUME_WIDTH = 0.6;
const PLUME_TIME = 1.6;

/** What each is called on the HUD. */
export const NPC_NAMES: Readonly<Record<NpcDef['id'], string>> = { randy: 'RANDY' };

/** His trash can fire, and where it sits in his own frame (x to his left, z ahead). */
export interface TrashFire {
  root: Object3D;
  flames: readonly Object3D[];
  at: [number, number];
}

/** Something he's throwing: from his hand to `to` (world), its flight time, how far into the throw, and where in his hand it came from. */
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

/** Something on its way into his fire. */
interface Feed {
  item: Object3D;
  from: Vector3;
  t: number;
  done: () => void;
}

/**
 * Randy: his body and fire, and his two minds (randy-mind.ts), the pitch
 * (his coat, and a scene holding him) and his work at the fire. Tell him
 * things with send(): a scene holds and releases him and flashes his coat,
 * the shop has Cody browsing, and Cody hands him tires.
 */
export class Npc {
  readonly pitch: Mind<Npc, Pitch, RandyEvent>;
  readonly work: Mind<Npc, Work, RandyEvent>;
  /** The way he faces when nobody's about (at his fire), and the way he's facing. Move him with Npcs.place. */
  homeYaw: number;
  yaw: number;
  /** Coat open, 0..1. */
  open = 0;
  t = Math.random() * GLANCE_EVERY;
  /** Cody's close on foot, on his level, this frame. */
  near = false;
  toss: Toss | null = null;
  /** How hard his fire's roaring from being fed, 1 just fed down to 0. */
  plume = 0;
  /** Things on their way into his fire. */
  feeding: Feed[] = [];

  constructor(
    readonly def: NpcDef,
    readonly rig: RandyRig,
    /** Where he stands. */
    readonly pos: Vector3,
    readonly fire: TrashFire | null,
    readonly npcs: Npcs,
  ) {
    this.homeYaw = this.yaw = def.yaw;
    this.pitch = new Mind<Npc, Pitch, RandyEvent>(RANDY_PITCH, this, { at: 'resting', t: 0 });
    this.work = new Mind<Npc, Work, RandyEvent>(RANDY_WORK, this, { at: 'roasting' });
  }

  /** A scene has him: he turns toward Cody (as far as his fire allows), roasts on, and opens his coat only when told to. */
  get held(): boolean {
    return !!this.pitch.in('directed');
  }

  /** While a scene has him, what he turns to instead of Cody (a car window, say), or null. */
  get face(): Vector3 | null {
    return this.pitch.in('directed')?.face ?? null;
  }

  /** His coat's open on his wares, facing Cody. */
  get pitching(): boolean {
    const s = this.pitch.state;
    return s.at === 'pitching' || s.at === 'browsing' || (s.at === 'directed' && s.open);
  }

  /** Sends `event` to both his minds. True if either moved. */
  send(event: RandyEvent): boolean {
    const pitch = this.pitch.send(event);
    const work = this.work.send(event);
    return pitch || work;
  }
}

/** What Randy's doings tell the game. */
export interface NpcHooks {
  /** A thing he threw has landed: a copy lies at the ground height `floor` (the one in his hand goes back, hidden). */
  landed(item: Object3D, floor: number): void;
  /** The highest surface at (x, z) no higher than `below`, so a throw can clear what's under it. */
  ground(x: number, z: number, below: number): number;
  /** A tire went into his fire at `at`. */
  burned(at: Vector3): void;
  /** The last of `n` tires Cody gave him has gone in. */
  fed(n: number): void;
}

/**
 * Randy's placement, idle animation, coat display, and thrown items.
 * Dialogue is managed by the tutorial, which uses talkable() and holds
 * the NPC during conversations.
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
        // where it sits in his frame, so it moves with him
        const dx = def.fire[0] - pos.x;
        const dz = def.fire[2] - pos.z;
        const c = Math.cos(def.yaw);
        const sn = Math.sin(def.yaw);
        fire = { root: built.root, flames: built.flames, at: [dx * c - dz * sn, dx * sn + dz * c] };
      }
      return new Npc(def, rig, pos, fire, this);
    });
  }

  /** Move him (and his fire, which goes where he goes) to stand at `pos` facing `yaw` when idle. */
  place(n: Npc, pos: Vector3, yaw: number): void {
    n.pos.copy(pos);
    n.homeYaw = n.yaw = yaw;
    n.rig.root.position.copy(pos);
    n.rig.root.rotation.y = yaw;
    if (n.fire) {
      const [x, z] = n.fire.at;
      n.fire.root.position.set(pos.x + x * Math.cos(yaw) + z * Math.sin(yaw), pos.y, pos.z - x * Math.sin(yaw) + z * Math.cos(yaw));
    }
  }

  /**
   * He throws what's in his left hand (Cody's badge, rig.badge: it's shown
   * if it wasn't) over an arc to land and lie at `to`. Returns the seconds
   * until it lands.
   */
  toss(n: Npc, to: Vector3, opts: { showPath?: boolean } = {}): number {
    const item = n.rig.badge;
    item.visible = true;
    const from = item.getWorldPosition(new Vector3());
    const lift = this.liftFor(from, to);
    const flight = Math.max(TOSS_FLIGHT + from.distanceTo(to) / TOSS_SPEED, fallTime(from, to, lift));
    const hand = { parent: item.parent, pos: item.position.clone(), quat: item.quaternion.clone() };
    // marked from the wind-up on: a halo round it, and a ring where it'll come down
    const highlight = new Highlight();
    highlight.place(from, to);
    this.scene.add(highlight.root);
    // and, if asked, the arc it'll fly, dotted out ahead of it
    const path = opts.showPath ? new ArcPath() : null;
    if (path) {
      path.set((u, out) => arcAt(from, to, lift, u, out));
      this.scene.add(path.root);
    }
    n.toss = { item, to: to.clone(), from, flight, t: 0, released: false, hand, highlight, path, lift };
    return TOSS_WIND + flight;
  }

  /**
   * Lob `item` (already in the scene) from `from` into his fire: it arcs in,
   * the fire plumes up, and `done` runs as it goes in. Without a fire it just
   * goes, and `done` runs at once.
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

  /** The fire roars up for a moment, as if fed. */
  stoke(n: Npc): void {
    n.plume = 1;
  }

  /** One of the tires Cody gave him goes into the fire, from Cody's hands at `from`. */
  feedTire(n: Npc, from: Vector3): void {
    const tire = buildJunk('tire');
    this.scene.add(tire);
    this.feed(n, tire, from, () => {
      if (n.fire) this.hooks.burned(n.fire.root.position);
    });
  }

  /** The last of `count` tires has gone in. */
  fed(_n: Npc, count: number): void {
    this.hooks.fed(count);
  }

  /**
   * How hard a throw from `from` to `to` is lobbed (the arc's `lift`, see
   * arcAt): enough for its usual height, and to clear everything under it
   * (no higher than the throw) till it comes down at the end.
   */
  private liftFor(from: Vector3, to: Vector3): number {
    const d = from.distanceTo(to);
    let lift = 4 * (TOSS_ARC + d * TOSS_ARC_PER_M);
    const top = Math.max(from.y, to.y) + TOSS_CLEAR;
    const drop = to.y - from.y;
    for (let i = 1; i < TOSS_SAMPLES; i++) {
      const u = i / TOSS_SAMPLES;
      if (u > 1 - TOSS_LAND) break;
      const h = this.hooks.ground(from.x + (to.x - from.x) * u, from.z + (to.z - from.z) * u, top);
      if (!Number.isFinite(h)) continue;
      lift = Math.max(lift, (h + TOSS_CLEAR - from.y - drop * u * u) / (u * (1 - u)));
    }
    return lift;
  }

  /** Throw arcs fading out after their throw. */
  private trails: ArcPath[] = [];

  /** The NPC with this id, if the level has one. */
  find(id: NpcDef['id']): Npc | null {
    return this.list.find((n) => n.def.id === id) ?? null;
  }

  /** Nearest NPC within `reach` of p, on its level, or null. */
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

  /** `cody`: where Cody is on foot, or null (driving, or off somewhere else). */
  update(dt: number, cody: Vector3 | null): void {
    const fading: ArcPath[] = [];
    for (const tr of this.trails) {
      if (tr.update(dt)) fading.push(tr);
      else tr.dispose();
    }
    this.trails = fading;
    for (const n of this.list) {
      n.toss?.path?.update(dt);
      n.t += dt;
      n.near = cody !== null && Math.hypot(cody.x - n.pos.x, cody.z - n.pos.z) < PITCH_REACH && Math.abs(cody.y - n.pos.y) < SAME_LEVEL;
      n.pitch.tick(dt);
      n.work.tick(dt);
      const r = n.rig;
      // he never leaves his fire: the body turns partway toward Cody (or whatever he's told to face) to pitch or talk, the head does the rest
      const at = n.held && n.face ? n.face : cody;
      const toCody = at ? Math.atan2(at.x - n.pos.x, at.z - n.pos.z) : n.homeYaw;
      const turn = n.pitching || n.held ? clamp(wrapAngle(toCody - n.homeYaw), -BODY_TURN, BODY_TURN) : 0;
      n.yaw = dampAngle(n.yaw, n.homeYaw + turn, TURN_RATE, dt);
      r.root.rotation.y = n.yaw;
      // coat: the left flap swings open in his left hand; the right stays shut over the stick arm
      n.open = damp(n.open, n.pitching ? 1 : 0, FLAP_RATE, dt);
      const [left, right] = r.flaps;
      left.rotation.y = -FLAP_OPEN * n.open;
      right.rotation.y = 0;
      this.throwing(n, dt);
      if (!n.toss) this.holdFlap(n);
      // always roasting: the stick held out, turned now and then
      r.armR.rotation.x = -ROAST_LIFT + Math.sin(n.t * TURN_MEAT_RATE) * TURN_MEAT;
      r.body.position.y = Math.sin(n.t * SWAY_RATE) * SWAY;
      // looking: at Cody when he's about (head only, unless he's turned to him), else the odd glance
      const look = n.near || n.held || n.face ? clamp(wrapAngle(toCody - n.yaw), -LOOK, LOOK) : Math.max(0, Math.sin((n.t / GLANCE_EVERY) * Math.PI * 2)) ** 4 * GLANCE;
      r.head.rotation.y = damp(r.head.rotation.y, look, TURN_RATE, dt);
      // the fire, roaring up for a moment when fed
      this.feedFire(n, dt);
      n.plume = Math.max(0, n.plume - dt / PLUME_TIME);
      const roar = n.plume * n.plume;
      n.fire?.flames.forEach((f, i) => {
        const a = Math.sin(n.t * FLICKER_RATES[0] + i * 1.7) * 0.6 + Math.sin(n.t * FLICKER_RATES[1] + i * 2.9) * 0.4;
        const wide = 1 + roar * PLUME_WIDTH;
        f.scale.set((1 + a * WOBBLE) * wide, (FLAME_REST + a * FLICKER) * (1 + roar * PLUME_HEIGHT), (1 - a * WOBBLE) * wide);
      });
    }
  }

  /** His left arm reaching to the open flap's front edge (as far as it's open), so arm and flap move as one. */
  private holdFlap(n: Npc): void {
    if (n.open < 0.01) return;
    const arm = n.rig.armL;
    const parent = arm.parent;
    if (!parent) return;
    n.rig.grips[0].getWorldPosition(_grip);
    parent.worldToLocal(_grip);
    _aim.setFromUnitVectors(DOWN, _grip.sub(arm.position).normalize());
    arm.quaternion.slerpQuaternions(_rest.identity(), _aim, n.open);
  }

  /** Things lobbed into the fire: over an arc into the can, where they're gone and the fire roars. */
  private feedFire(n: Npc, dt: number): void {
    const fire = n.fire;
    if (!fire) return;
    const flying: Feed[] = [];
    const landed: Feed[] = [];
    for (const f of n.feeding) {
      f.t += dt;
      const u = Math.min(1, f.t / FEED_FLIGHT);
      const to = fire.root.position;
      f.item.position.lerpVectors(f.from, to, u);
      // from the hand up over the arc, down to the rim, then in
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

  /** The left arm's throw, and the thing in flight once he lets go. */
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
      // wind back, then swing through
      const k = tw.t / TOSS_WIND;
      arm.rotation.x = k < 0.5 ? TOSS_BACK * (k / 0.5) : TOSS_BACK - (TOSS_BACK + TOSS_THROUGH) * ((k - 0.5) / 0.5);
      if (k < 1) return;
      // let go: into the world where it is
      tw.released = true;
      tw.item.getWorldPosition(tw.from);
      this.scene.attach(tw.item);
      tw.t = 0;
      // it leaves from where the hand ended up: the arc (and the dots) from there
      tw.lift = this.liftFor(tw.from, tw.to);
      tw.path?.set((u, out) => arcAt(tw.from, tw.to, tw.lift, u, out));
    }
    arm.rotation.x = damp(arm.rotation.x, 0, ARM_RATE, dt);
    const u = Math.min(1, tw.t / tw.flight);
    arcAt(tw.from, tw.to, tw.lift, u, tw.item.position);
    tw.item.rotation.x += TOSS_SPIN * dt;
    tw.item.rotation.z += TOSS_SPIN * 0.6 * dt;
    if (u >= 1) {
      // lands flat where it was thrown, and stays there to be found; his hand keeps one to throw next time
      tw.item.rotation.set(-Math.PI / 2, 0, tw.item.rotation.z);
      n.toss = null;
      // the one lying there takes its own mark (Junk keeps it highlighted till it's picked up); the arc fades
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
 * Where something thrown from `from` to `to` is a share u (0..1) of the way
 * through its flight: straight across, and a gravity arc up and down, lobbed
 * by `lift` (its rise is lift * u * (1 - u) over the plain drop, which comes
 * late, as a falling thing's does).
 */
function arcAt(from: Vector3, to: Vector3, lift: number, u: number, out: Vector3): Vector3 {
  out.lerpVectors(from, to, u);
  out.y = from.y + lift * u * (1 - u) + (to.y - from.y) * u * u;
  return out;
}

/** How long a throw's arc takes as a real fall: up to its peak and down from it under TOSS_G (s). */
function fallTime(from: Vector3, to: Vector3, lift: number): number {
  const drop = to.y - from.y;
  // the peak: where the rise and the drop balance
  const u = Math.min(1, Math.max(0, lift / (2 * (lift - drop))));
  const peak = from.y + lift * u * (1 - u) + drop * u * u;
  return Math.sqrt((2 * Math.max(0, peak - from.y)) / TOSS_G) + Math.sqrt((2 * Math.max(0, peak - to.y)) / TOSS_G);
}
