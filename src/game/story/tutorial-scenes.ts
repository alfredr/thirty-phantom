import { Object3D, Raycaster, Vector3 } from 'three';

import { type NpcAction, Throw, wait } from '@/actors/npcs/npc-actions';
import type { Npc } from '@/actors/npcs/npcs';
import { driverDoor } from '@/actors/vehicles/doors';
import type { Vehicle } from '@/actors/vehicles/vehicle';
import { TUNING } from '@/config';
import { Disposables, releaseOnce } from '@/engine/core/disposable';
import { done } from '@/engine/sim/action';
import { Sequence, WaitUntil } from '@/engine/sim/sequence';
import type { CamView } from '@/game/camera-controller';
import { ScriptedOffer } from '@/game/cody/cody-actions';
import type { Garage, SpotRuntime } from '@/game/deck/garage';
import type { Pose } from '@/game/driving/reset';
import type { Game } from '@/game/game';
import { ISO_ELEVATION } from '@/render/iso-camera';
import { ITEM_ICONS } from '@/ui/item-icons';
import type { GateDef, LevelData, RampDef } from '@/world/level-data';

import { type Part, steps } from './director';
import { inView, npcScenes, player, type NpcSceneBindings } from './npc-scene';
import type { StoryCamera } from './story-camera';
import type { RoofStage, TutorialContext, TutorialEvent } from './tutorial-context';

const MIN_RUN = 9;
const RUN_UP = 14;
const RANDY_AHEAD = 1.1;
const RANDY_SIDE = 1.2;
const TOSS_PAST = 12;
const DOOR = 2.6;
const DOOR_GAP = 1;
const VIEW_TURNS = [0.45, -0.45, 0.2, -0.2];
const EXIT_OUT = 1;
const NOTICE = 4.5;
const TALK_REACH = 3.6;
const ENTER_HEIGHT = 1.8;
const AIR_ABOVE = 0.5;
const IDLE_SPEED = 0.5;
const COUGH_EVERY = 0.9;
const TAILPIPE = 0.5;

const _side = new Vector3();
const _toCamera = new Vector3();

type ScenePart = Part<TutorialContext, TutorialEvent, string>;

const { hold } = steps<TutorialContext, TutorialEvent, string>();

export function coat(game: Pick<Game, 'waresShown'>, npc: Npc, open: boolean): void {
  npc.send({ type: 'flash', open });
  game.waresShown = open ? npc : null;
}

export function doorOf(v: Vehicle): Pose {
  return { pos: driverDoor(v, DOOR_GAP, new Vector3()), yaw: v.yaw };
}

export function gateAt(gate: GateDef): Vector3 {
  return new Vector3((gate.min[0] + gate.max[0]) / 2, gate.min[1], (gate.min[2] + gate.max[2]) / 2);
}

export function tossBadge(npc: Npc, to: Vector3, camera: Pick<StoryCamera, 'track'>): NpcAction {
  const lingerSeconds = 1.5;
  const flying = new Vector3();
  return new Sequence(function* () {
    using shots = new Disposables();
    const result = yield new Throw({
      npc,
      kind: 'badge',
      to,
      showPath: true,
      thrown: (seconds) =>
        shots.use(
          camera.track(seconds + lingerSeconds, () =>
            npc.throwing?.active ? npc.prop('badge').getWorldPosition(flying) : flying.copy(to),
          ),
        ),
    });
    if ('fail' in result) {
      return result;
    }

    return yield wait(lingerSeconds);
  });
}

export function moltenKeys(game: Pick<Game, 'hud'>, randy: Npc, pickup: Vehicle): void {
  pickup.ignition.heat = 'molten';
  game.hud.toast('MOLTEN KEYS', `${ITEM_ICONS.moltenKeys}RANDY ADDS MOLTEN KEYS TO INVENTORY`, 'warn', NOTICE);

  if (!randy.stock?.slotOf('moltenKeys')) {
    randy.stock?.slots.push({ id: 'molten-keys', kind: 'moltenKeys', count: 1 });
  }

  if (randy.fire) {
    randy.fire.plume = 1;
  }
}

export function meltedKeys(game: Pick<Game, 'hud' | 'inventory'>, randy: Npc, pickup: Vehicle): void {
  const slots = randy.stock?.slots;
  const i = slots?.findIndex((s) => s.kind === 'moltenKeys') ?? -1;
  if (slots && i >= 0) {
    slots.splice(i, 1);
  }

  const keys = pickup.ignition;
  keys.heat = 'melted';
  keys.transfer(randy.keys, game.inventory.keys);
  randy.reach(1.4);
  game.hud.toast('+ MELTED KEYS', 'ONE USELESS CLUMP', '', 2.6);
}

export const roofScene = (): ScenePart =>
  hold(
    (c) => c.camera.hold(),
    (c) => c.randy.attention.take({ face: c.stage.window }),
    (c) =>
      releaseOnce(() => {
        c.game.waresShown = null;
      }),
  );

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

export const imprintSign = (c: TutorialContext): Sequence<TutorialContext, TutorialContext> =>
  new Sequence(function* () {
    const im = c.progress.firstPhantom;
    if (!im) {
      return done;
    }

    yield new WaitUntil<TutorialContext, TutorialContext>(() => c.pickup.grounded, { timeoutSeconds: 3 });
    const signHeight = 2.4;
    const cameraHeight = 5;
    const sign = im.at.clone().setY(im.at.y + signHeight);
    const focus = im.at.clone().setY(im.at.y + cameraHeight);
    const sights = [-2, 0, 2].map((d) => im.at.clone().add(_side.set(d, 1, d * 0.3)));
    const g = c.game;
    g.iso.azimuth = g.iso.azimuthTarget = clearView(g.world.root, sights, g.iso.azimuth);
    using _shot = c.camera.cut({ focus, zoom: 16 });
    using _sign = releaseOnce(() => c.sign.cancel());
    g.hud.clearToasts();
    c.sign.show(im.title, im.meta, `FILL ALL ${TUNING.garage.spots} SPOTS WITH PHANTOMS.`, () => undefined);
    c.sign.place(null);
    yield new WaitUntil<TutorialContext, TutorialContext>(() => !c.sign.open, {
      timeoutSeconds: 15,
      update: () => c.sign.place(g.toScreen(sign)),
    });
    c.sign.dismiss();
    return done;
  });

export const seatAtFire = (): ScenePart =>
  hold(
    (c) => {
      const r = c.randy;
      const cameraHeight = 1.2;
      const focus = new Vector3()
        .addVectors(r.pos, c.game.player.pos)
        .multiplyScalar(0.5)
        .setY(r.pos.y + cameraHeight);
      return c.camera.cut({ focus, zoom: 10 });
    },
    (c) => c.randy.attention.take({ face: null }),
    (c) =>
      releaseOnce(() => {
        c.game.waresShown = null;
      }),
  );

export const faceCody = (): ScenePart => hold((c) => c.randy.attention.take({ face: null }));

export const watchViews = (): ScenePart => ({
  create: (s, c) => {
    c.progress.viewsSeen.clear();
    return {
      tick: () => {
        if (c.pickup.role !== 'player') {
          return;
        }

        const view: CamView = c.game.cameraMode === 'iso' ? 'iso' : 'chase';
        if (!c.progress.viewsSeen.has(view)) {
          c.progress.viewsSeen.add(view);
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
          start: () => c.send({ type: 'talk', tires: g.inventory.count('tire') }),
        });
      }),
    };
  },
});

export const directRandy = (build: (c: TutorialContext) => NpcAction): ScenePart => ({
  create: (s, c) => {
    const run = c.randy.direct([build(c)]);
    let finished = false;
    return {
      tick: () => {
        if (finished || run.running) {
          return;
        }

        finished = true;

        if (run.status === 'done') {
          s.done();
        } else {
          s.struggle();
        }
      },
      stop: () => {
        finished = true;
        c.randy.stopDirecting(run);
      },
    };
  },
});

const handoff = npcScenes<'randy', never, 'roof'>();
const departure = npcScenes<'randy', 'roofExit', never>();

export const PHONE_HANDOFF = handoff.holding(
  [handoff.attention('randy', player), handoff.camera('roof')],
  handoff.orElse(
    handoff.sequence([handoff.face('randy', player), handoff.handOver('randy', 'burner', { seconds: 1.4, at: 0.7 })]),
    handoff.give('randy', 'burner'),
  ),
);

export const ROOF_DEPARTURE = departure.holding(
  [departure.attention('randy', player)],
  departure.until(
    departure.offscreen('randy', { after: 0.8, timeout: 10 }),
    departure.walkTo('randy', 'roofExit', { speed: 4.2 }),
  ),
);

function sceneBindings(
  game: Pick<Game, 'inventory' | 'handOver'>,
  randy: Npc,
  camera: Pick<StoryCamera, 'shot' | 'cut'>,
): NpcSceneBindings<'randy', never, 'roof'> {
  return {
    actors: { randy },
    actions: {},
    points: {},
    shots: { roof: camera.shot },
    camera,
    items: {
      has: (item) => game.inventory.count(item) > 0,
      give: (from, item) => void game.handOver(from, item),
    },
  };
}

export function handPhone(
  game: Pick<Game, 'inventory' | 'handOver'>,
  randy: Npc,
  camera: Pick<StoryCamera, 'shot' | 'cut'>,
): NpcAction {
  return handoff.play(PHONE_HANDOFF, sceneBindings(game, randy, camera));
}

export const leaveRoof = (): ScenePart => ({
  create: (s, c) => {
    const r = c.randy;
    const run = r.direct([
      departure.play(ROOF_DEPARTURE, {
        actors: { randy: r },
        points: { roofExit: roofExit(c.level, r.pos) },
        shots: {},
        actions: {},
        visible: (actor) => inView(c.game, actor.pos),
      }),
    ]);
    return {
      tick: () => {
        if (run.running) {
          return;
        }

        c.game.puff(r.pos);

        if (r.fire) {
          c.game.puff(r.fire.root.position);
        }

        r.place(new Vector3(...r.def.pos), r.def.yaw);
        s.done();
      },
      stop: () => r.stopDirecting(run),
    };
  },
});

export const facing = (): ScenePart => ({
  create: (_s, c) => {
    c.randy.lookAt(null);
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

        if (!c.progress.noticedSmell) {
          c.progress.noticedSmell = true;
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

export const settled = (v: Vehicle): boolean => v.grounded && Math.hypot(v.vel.x, v.vel.z) < IDLE_SPEED;

export function nearestCar(vehicles: readonly Vehicle[], at: Vector3, test: (v: Vehicle) => boolean): Vehicle | null {
  let best: Vehicle | null = null;
  let d = Infinity;
  for (const v of vehicles) {
    if (v.gone || v.form !== 'car' || !test(v)) {
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

export function stageOn(level: LevelData, garage: Garage, ground: (x: number, z: number) => number): RoofStage | null {
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
