import { Object3D, Raycaster, Vector3 } from 'three';

import { effect, face, HandOver, type NpcAction, Throw, walkTo } from '@/actors/npcs/npc-actions';
import type { NpcRun } from '@/actors/npcs/npcs';
import { driverDoor } from '@/actors/vehicles/doors';
import type { Vehicle } from '@/actors/vehicles/vehicle';
import { TUNING } from '@/config';
import type { CamView } from '@/game/camera-controller';
import { ScriptedOffer } from '@/game/cody/cody-actions';
import type { Garage, SpotRuntime } from '@/game/deck/garage';
import type { Pose } from '@/game/driving/reset';
import type { Game } from '@/game/game';
import { ISO_ELEVATION } from '@/render/iso-camera';
import { ITEM_ICONS } from '@/ui/item-icons';
import type { GateDef, LevelData, RampDef } from '@/world/level-data';

import { type Active, Leases, type Part, type Scope } from './director';
import type { Cast, TutorialEvent } from './tutorial-beats';

const MIN_RUN = 9;
const RUN_UP = 14;
const RANDY_AHEAD = 1.1;
const RANDY_SIDE = 1.2;
const TOSS_PAST = 12;
const DOOR = 2.6;
const DOOR_GAP = 1;
const TALK_HEIGHT = 1.2;
const VIEW_TURNS = [0.45, -0.45, 0.2, -0.2];
const THROW_HOLD = 1.5;
const HAND_OVER = 0.7;
const REACH_TIME = 1.4;
const RUN_SPEED = 4.2;
const OUT_OF_VIEW = 0.8;
const RUN_MAX = 10;
const RECOVERIES = 2;
const EXIT_OUT = 1;
const NOTICE = 4.5;
const IMPRINT_LAND = 3;
const IMPRINT_ZOOM = 16;
const IMPRINT_SIGN = 2.4;
const IMPRINT_HOLD = 15;
const IMPRINT_ABOVE = 5;
const BASEMENT_ZOOM = 10;
const TALK_REACH = 3.6;
const ENTER_HEIGHT = 1.8;
const AIR_ABOVE = 0.5;
const IDLE_SPEED = 0.5;
const COUGH_EVERY = 0.9;
const TAILPIPE = 0.5;

const _side = new Vector3();
const _toCamera = new Vector3();

export interface Stage {
  readonly spot: SpotRuntime;
  readonly truck: Vector3;
  readonly yaw: number;
  readonly turn: 'LEFT' | 'RIGHT';
  readonly randy: Vector3;
  readonly randyYaw: number;
  readonly window: Vector3;
  readonly toss: Vector3;
  readonly ramp: RampDef;
  readonly start: Pose;
  readonly lip: Vector3;
  readonly roof: number;
}

export interface Imprint {
  readonly at: Vector3;
  readonly title: string;
  readonly meta: string;
}

type ScenePart = Part<Cast, TutorialEvent, string>;

export interface Chapter {
  imprint: Imprint | null;
  smelled: boolean;
  readonly views: Set<CamView>;
}

export class Scenes {
  gone = false;
  private exit: { run: NpcRun; t: number } | null = null;
  private readonly staging = new Leases<true>((on) => this.stage(on !== null));

  constructor(
    private readonly game: Game,
    readonly send: (e: TutorialEvent) => void,
    private readonly cast: () => Cast | null,
  ) {}

  tick(dt: number): void {
    this.runOff(dt);
  }

  hold(): () => void {
    return this.staging.take(true);
  }

  throwBadge(): void {
    const c = this.cast();
    if (!c) {
      return;
    }

    const r = c.randy;
    const flying = new Vector3();
    c.randy.direct([
      new Throw({
        npc: r,
        kind: 'badge',
        to: c.stage.toss,
        showPath: true,
        thrown: (seconds) =>
          c.camera.track(seconds + THROW_HOLD, () =>
            r.throwing?.active ? r.prop('badge').getWorldPosition(flying) : flying.copy(c.stage.toss),
          ),
      }),
    ]);
  }

  coat(open: boolean): void {
    const c = this.cast();
    if (!c) {
      return;
    }

    c.randy.send({ type: 'flash', open });
    this.game.waresShown = open ? c.randy : null;
  }

  leave(): void {
    const c = this.cast();
    if (!c) {
      return;
    }

    const r = c.randy;
    this.gone = false;
    r.send({ type: 'held', face: null });
    this.exit = { run: r.direct([walkTo(r, roofExit(c.level, r.pos), { speed: RUN_SPEED })]), t: 0 };
  }

  doorOf(v: Vehicle): Pose {
    return { pos: driverDoor(v, DOOR_GAP, new Vector3()), yaw: v.yaw };
  }

  gateAt(gate: GateDef): Vector3 {
    return new Vector3((gate.min[0] + gate.max[0]) / 2, gate.min[1], (gate.min[2] + gate.max[2]) / 2);
  }

  private stage(on: boolean): void {
    const c = this.cast();
    if (!c) {
      return;
    }

    if (on) {
      c.randy.send({ type: 'held', face: c.stage.window });
    } else {
      c.randy.send({ type: 'released' });
      this.game.waresShown = null;
    }
  }

  private runOff(dt: number): void {
    const e = this.exit;
    const c = this.cast();
    if (!e || !c) {
      return;
    }

    const r = c.randy;
    const g = this.game;
    e.t += dt;
    const seen = g.toScreen(r.pos);
    const out = !seen || seen.x < 0 || seen.y < 0 || seen.x > window.innerWidth || seen.y > window.innerHeight;
    if (e.run.running && !(out && e.t > OUT_OF_VIEW) && e.t < RUN_MAX) {
      return;
    }

    this.exit = null;
    this.gone = true;
    g.puff(r.pos);

    if (r.fire) {
      g.puff(r.fire.root.position);
    }

    r.send({ type: 'released' });
    r.place(new Vector3(...r.def.pos), r.def.yaw);
  }
}

export function moltenKeys(c: Cast): void {
  const r = c.randy;
  c.pickup.ignition.heat = 'molten';
  c.game.hud.toast('MOLTEN KEYS', `${ITEM_ICONS.moltenKeys}RANDY ADDS MOLTEN KEYS TO INVENTORY`, 'warn', NOTICE);

  if (!r.stock?.slotOf('moltenKeys')) {
    r.stock?.slots.push({ id: 'molten-keys', kind: 'moltenKeys', count: 1 });
  }

  if (r.fire) {
    r.fire.plume = 1;
  }
}

export function meltedKeys(c: Cast): void {
  const r = c.randy;
  const slots = r.stock?.slots;
  const i = slots?.findIndex((s) => s.kind === 'moltenKeys') ?? -1;
  if (slots && i >= 0) {
    slots.splice(i, 1);
  }

  const keys = c.pickup.ignition;
  keys.heat = 'melted';
  keys.transfer(r.keys, c.game.inventory.keys);
  r.reach(REACH_TIME);
  c.game.hud.toast('+ MELTED KEYS', 'ONE USELESS CLUMP', '', 2.6);
}

export const roofScene = (): ScenePart => ({
  create: (_s, c) => {
    const shot = c.camera.hold();
    const staged = c.scenes.hold();
    return {
      stop: () => {
        staged();
        shot();
      },
    };
  },
});

export const ledgerOnJump = (): ScenePart => ({
  create: (_s, c) => ({
    tick: () => {
      const v = c.pickup;
      if (!v.grounded && v.pos.y > c.stage.roof + AIR_ABOVE) {
        c.game.hud.showLedger(true);
      }
    },
  }),
});

class ImprintSign implements Active<TutorialEvent> {
  private shownAt: number | null = null;
  private release: (() => void) | null = null;
  private readonly sign = new Vector3();

  constructor(
    private readonly s: Scope<string>,
    private readonly c: Cast,
  ) {}

  tick(): void {
    const { s, c } = this;
    const im = c.chapter.imprint;
    if (!im) {
      s.done();
      return;
    }

    this.sign.copy(im.at).setY(im.at.y + IMPRINT_SIGN);

    if (this.shownAt !== null) {
      if (!c.sign.open) {
        return;
      }

      c.sign.place(c.game.toScreen(this.sign));

      if (s.t - this.shownAt > IMPRINT_HOLD) {
        c.sign.dismiss();
      }

      return;
    }

    if (!c.pickup.grounded && s.t < IMPRINT_LAND) {
      return;
    }

    const g = c.game;
    const focus = im.at.clone().setY(im.at.y + IMPRINT_ABOVE);
    const sights = [-2, 0, 2].map((d) => im.at.clone().add(_side.set(d, 1, d * 0.3)));
    g.iso.azimuth = g.iso.azimuthTarget = clearView(g.world.root, sights, g.iso.azimuth);
    this.shownAt = s.t;
    this.release = c.camera.cut({ focus, zoom: IMPRINT_ZOOM });
    g.hud.clearToasts();
    c.sign.show(im.title, im.meta, `FILL ALL ${TUNING.garage.spots} SPOTS WITH PHANTOMS.`, () =>
      c.scenes.send({ type: 'signed' }),
    );
    c.sign.place(null);
  }

  stop(): void {
    this.release?.();
    this.c.sign.cancel();
  }
}

export const imprintSign = (): ScenePart => ({ create: (s, c) => new ImprintSign(s, c) });

export const seatAtFire = (): ScenePart => ({
  create: (_s, c) => {
    const r = c.randy;
    const focus = new Vector3()
      .addVectors(r.pos, c.game.player.pos)
      .multiplyScalar(0.5)
      .setY(r.pos.y + TALK_HEIGHT);
    const shot = c.camera.cut({ focus, zoom: BASEMENT_ZOOM });
    r.send({ type: 'held', face: null });
    return {
      stop: () => {
        shot();
        r.send({ type: 'released' });
        c.game.waresShown = null;
      },
    };
  },
});

export const faceCody = (): ScenePart => ({
  create: (_s, c) => {
    c.randy.send({ type: 'held', face: null });
    return { stop: () => c.randy.send({ type: 'released' }) };
  },
});

export const watchViews = (): ScenePart => ({
  create: (s, c) => {
    c.chapter.views.clear();
    return {
      tick: () => {
        if (c.pickup.role !== 'player') {
          return;
        }

        const view: CamView = c.game.cameraMode === 'iso' ? 'iso' : 'chase';
        if (!c.chapter.views.has(view)) {
          c.chapter.views.add(view);
          s.progress();
        }
      },
    };
  },
});

export const getIn = (mode: 'refuse' | 'board'): ScenePart => ({
  create: (s, c) => {
    const g = c.game;
    return {
      stop: g.addOffer(() => {
        const p = g.player.pos;
        const v = c.pickup;
        if (
          !g.player.visible ||
          v.status ||
          Math.abs(v.pos.y - p.y) > ENTER_HEIGHT ||
          v.pos.distanceTo(p) > v.breed.enterReach
        ) {
          return null;
        }

        return new ScriptedOffer({
          label: 'GET IN',
          start: () => {
            if (mode === 'board') {
              s.progress();
              g.board(v, true);
            } else if (c.outreach.free) {
              c.outreach.speak([{ who: 'right', say: 'NO KEYS.', solo: true }], () => undefined);
            }
          },
        });
      }),
    };
  },
});

export const talkToRandy = (): ScenePart => ({
  create: (_s, c) => {
    const g = c.game;
    return {
      stop: g.addOffer(() => {
        if (!g.player.visible || !c.outreach.free || g.npcs.talkable(g.player.pos, TALK_REACH) !== c.randy) {
          return null;
        }

        return new ScriptedOffer({
          label: 'TALK TO RANDY',
          start: () => c.scenes.send({ type: 'talk', tires: g.inventory.count('tire') }),
        });
      }),
    };
  },
});

export type Recover = (c: Cast, reason: string) => NpcAction[];

export const perform = (build: (c: Cast) => NpcAction[], recover: Recover): ScenePart => ({
  create: (s, c) => {
    let run = c.randy.direct(build(c));
    let recoveries = 0;
    return {
      tick: () => {
        switch (run.status) {
          case 'done':
            s.done();
            break;
          case 'failed':
            if (recoveries < RECOVERIES) {
              recoveries++;
              run = c.randy.direct(recover(c, run.reason ?? ''));
            }

            break;
          case 'cancelled':
          case 'running':
            break;
        }
      },
      stop: () => c.randy.stopDirecting(run),
    };
  },
});

export function handPhone(c: Cast): NpcAction[] {
  const r = c.randy;
  return [
    face(r, null),
    new HandOver({ npc: r, kind: 'burner', seconds: REACH_TIME, at: HAND_OVER, give: () => givePhone(c) }),
  ];
}

export function skipPhone(c: Cast): NpcAction[] {
  return [effect(() => givePhone(c))];
}

function givePhone(c: Cast): void {
  if (!c.game.inventory.count('burner')) {
    c.game.handOver(c.randy, 'burner');
  }
}

export const facing = (): ScenePart => ({
  create: (_s, c) => {
    c.randy.send({ type: 'held', face: null });
    return {};
  },
});

export const coughing = (after = 0): ScenePart => ({
  create: (s, c) => {
    let wait = 0;
    return {
      tick: (dt) => {
        const v = c.pickup;
        wait = Math.max(0, wait - dt);

        if (s.t < after || !v.ignition.stalled || v.role !== 'player' || !c.game.input.isDown('forward') || wait > 0) {
          return;
        }

        wait = COUGH_EVERY;
        c.game.events.emit('sfx', { name: 'engine-cough', at: tailpipe(v) });

        if (!c.chapter.smelled) {
          c.chapter.smelled = true;
          c.outreach.later([{ who: 'right', say: '...WHY DOES IT SMELL LIKE BARBECUE?', solo: true }]);
        }
      },
    };
  },
});

export function tailpipe(v: Vehicle): Vector3 {
  const back = v.params.length / 2;
  return new Vector3(v.pos.x - Math.sin(v.yaw) * back, v.pos.y + TAILPIPE, v.pos.z - Math.cos(v.yaw) * back);
}

export const settled = (c: Cast): boolean => {
  const v = c.pickup;
  return v.grounded && Math.hypot(v.vel.x, v.vel.z) < IDLE_SPEED;
};

export function nearestCar(c: Cast, at: Vector3, test: (v: Vehicle) => boolean): Vehicle | null {
  let best: Vehicle | null = null;
  let d = Infinity;
  for (const v of c.game.vehicles) {
    if (v === c.pickup || v.gone || v.form !== 'car' || !test(v)) {
      continue;
    }

    const dv = v.pos.distanceToSquared(at);
    if (dv < d) {
      d = dv;
      best = v;
    }
  }

  return best;
}

export function stageOn(level: LevelData, garage: Garage, ground: (x: number, z: number) => number): Stage | null {
  const exit = level.gates.find((g) => g.kind === 'exit');
  const { min, max } = level.deck;
  const ex = exit ? exit.hinge[0] : max[0];
  const ez = exit ? exit.hinge[2] : (min[2] + max[2]) / 2;
  const kickers = level.ramps.filter((r) => r.kicker);
  const roof = Math.max(...kickers.map((r) => r.low));
  let kicker: RampDef | null = null;
  let best = Infinity;
  for (const r of kickers) {
    if (r.low < roof - 0.5) {
      continue;
    }

    const d = Math.hypot((r.min[0] + r.max[0]) / 2 - ex, (r.min[2] + r.max[2]) / 2 - ez);
    if (d < best) {
      best = d;
      kicker = r;
    }
  }

  if (!kicker) {
    return null;
  }

  const k = kicker;
  const ax = k.axis === 'x' ? 0 : 2;
  const across = ax === 0 ? 2 : 0;
  const low = k.dir > 0 ? k.min[ax] : k.max[ax];
  const high = k.dir > 0 ? k.max[ax] : k.min[ax];
  let spot: SpotRuntime | null = null;
  let along = 0;
  best = Infinity;

  for (const s of garage.spots) {
    if (Math.abs(s.center.y - k.low) > 0.6 || !garage.isFree(s)) {
      continue;
    }

    const reach = Math.max(...s.def.size) / 2 + 1.5;
    const ox = s.center.x + Math.sin(s.def.yaw) * reach;
    const oz = s.center.z + Math.cos(s.def.yaw) * reach;
    const side = across === 0 ? ox : oz;
    if (side < k.min[across] - 1 || side > k.max[across] + 1) {
      continue;
    }

    const at = ax === 0 ? ox : oz;
    const run = (low - at) * k.dir;
    if (run < MIN_RUN) {
      continue;
    }

    const door = new Vector3(
      s.center.x + Math.cos(s.def.yaw) * DOOR,
      s.center.y,
      s.center.z - Math.sin(s.def.yaw) * DOOR,
    );
    const crowded = garage.spots.some((o) => o !== s && o.occupant && o.center.distanceTo(door) < 1.5);
    const score = Math.abs(run - RUN_UP) + (crowded ? 100 : 0);
    if (score < best) {
      best = score;
      spot = s;
      along = at;
    }
  }

  if (!spot) {
    return null;
  }

  const yaw = spot.def.yaw;
  const truck = spot.center.clone();
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  const sx = -Math.cos(yaw);
  const sz = Math.sin(yaw);
  const launch = ax === 0 ? [k.dir, 0] : [0, k.dir];
  const turn = sx * (launch[0] ?? 0) + sz * (launch[1] ?? 0) > 0 ? 'RIGHT' : 'LEFT';
  const ahead = Math.max(...spot.def.size) / 2 + RANDY_AHEAD;
  const randy = new Vector3(truck.x + fx * ahead - sx * RANDY_SIDE, truck.y, truck.z + fz * ahead - sz * RANDY_SIDE);
  const randyYaw = Math.atan2(-sx * 0.87 - fx * 0.5, -sz * 0.87 - fz * 0.5);
  const window = new Vector3(truck.x - sx + fx * 0.4, truck.y, truck.z - sz + fz * 0.4);
  const edges: [number, number, number][] = [
    [randy.x - min[0], -1, 0],
    [max[0] - randy.x, 1, 0],
    [randy.z - min[2], 0, -1],
    [max[2] - randy.z, 0, 1],
  ];
  edges.sort((a, b) => a[0] - b[0]);
  const [gap, ox, oz] = edges[0] ?? [0, 1, 0];
  const tx = randy.x + ox * (gap + TOSS_PAST);
  const tz = randy.z + oz * (gap + TOSS_PAST);
  const mid = (k.min[across] + k.max[across]) / 2;
  const startAt = new Vector3(ax === 0 ? along : mid, k.low, ax === 0 ? mid : along);
  const lip = new Vector3(ax === 0 ? high : mid, k.max[1], ax === 0 ? mid : high);
  return {
    spot,
    truck,
    yaw,
    turn,
    randy,
    randyYaw,
    window,
    toss: new Vector3(tx, ground(tx, tz), tz),
    ramp: k,
    start: { pos: startAt, yaw: Math.atan2(launch[0] ?? 0, launch[1] ?? 0) },
    lip,
    roof: k.low,
  };
}

export function stagedView(root: Object3D, sights: readonly Vector3[], yaw: number): number {
  const meshes = meshesOf(root);
  const side = Math.atan2(Math.cos(yaw), -Math.sin(yaw));
  let best = side;
  let fewest = Infinity;
  for (const turn of VIEW_TURNS) {
    const hidden = hiddenFrom(meshes, sights, side + turn);
    if (hidden < fewest) {
      fewest = hidden;
      best = side + turn;
    }
  }

  return best;
}

export function clearView(root: Object3D, sights: readonly Vector3[], azimuth: number): number {
  const meshes = meshesOf(root);
  let best = azimuth;
  let fewest = Infinity;
  for (let k = 0; k < 4 && fewest > 0; k++) {
    const a = azimuth + (k * Math.PI) / 2;
    const hidden = hiddenFrom(meshes, sights, a);
    if (hidden < fewest) {
      fewest = hidden;
      best = a;
    }
  }

  return best;
}

function meshesOf(root: Object3D): Object3D[] {
  const meshes: Object3D[] = [];
  root.traverseVisible((o) => {
    if ('isMesh' in o && o.isMesh === true && o.layers.isEnabled(0)) {
      meshes.push(o);
    }
  });
  return meshes;
}

function hiddenFrom(meshes: Object3D[], sights: readonly Vector3[], azimuth: number): number {
  const ray = new Raycaster();
  ray.far = 80;
  const c = Math.cos(ISO_ELEVATION);
  _toCamera.set(Math.sin(azimuth) * c, Math.sin(ISO_ELEVATION), Math.cos(azimuth) * c);
  let hidden = 0;
  for (const p of sights) {
    ray.set(p, _toCamera);

    if (ray.intersectObjects(meshes, false).length) {
      hidden++;
    }
  }

  return hidden;
}

export function roofExit(level: LevelData, from: Vector3): Vector3 {
  let best: Vector3 | null = null;
  for (const e of level.elevators) {
    for (const stop of e.stops) {
      if (Math.abs(stop.y - from.y) > 0.6) {
        continue;
      }

      const at = new Vector3((e.min[0] + e.max[0]) / 2, stop.y, (e.min[2] + e.max[2]) / 2);
      if (stop.facing === 'z+') {
        at.z = e.max[2] + EXIT_OUT;
      } else if (stop.facing === 'z-') {
        at.z = e.min[2] - EXIT_OUT;
      } else if (stop.facing === 'x+') {
        at.x = e.max[0] + EXIT_OUT;
      } else {
        at.x = e.min[0] - EXIT_OUT;
      }

      if (!best || at.distanceTo(from) < best.distanceTo(from)) {
        best = at;
      }
    }
  }

  return best ?? from.clone();
}
