import { Color, Vector3 } from 'three';
import type { Vehicle } from '../actors/vehicle';
import { lerp, TAU } from '../engine/core/math';
import type { Emitter } from '../engine/core/events';
import { SLIME, WHITE } from '../fx/colors';
import type { CubeParticles } from '../fx/cube-particles';
import type { SpriteFx } from '../fx/sprite-fx';
import type { ToastTone } from '../ui/hud';
import type { GameEvents } from './game';

/** What effects play on: the view, the HUD's toasts, the particles. */
export interface Stage {
  /** What Cody's driving, if anything: only what it does shakes the view or gets a toast. */
  ride(): Vehicle | null;
  shake(trauma: number): void;
  toast(title: string, sub: string, tone: ToastTone, seconds: number): void;
  readonly slime: CubeParticles;
  readonly debris: CubeParticles;
  readonly sprites: SpriteFx;
  /** The ground under (x, z) at or below `y`: where bits come to rest. */
  groundAt(x: number, z: number, y: number): number;
}

const CONCRETE = new Color('#8f889c');
/** Street furniture's bits when its kind doesn't say (PropKind.debris). */
const METAL = new Color('#5a5266');
/** A lamp hitting the ground throws sparks of its light, this much brighter, this big (m) and lasting this long (s). */
const SPARK = { glow: 2.5, size: [0.05, 0.12], life: [0.3, 0.7] } as const;
/**
 * A prop smashed to bits (a hedge, a bus shelter): pieces of its debris per cubic metre it filled,
 * within `count`, their size, life (s), and how fast they fly out and up (m/s).
 */
const SHATTER = { perM3: 3, count: [12, 36], size: [0.1, 0.32], life: 2.2, out: 5, up: [2, 6] } as const;
/** A puff of smoke round someone vanishing or turning up: its colour, how many, how wide and high, how big, how long. */
const PUFF = { color: new Color('#5a4e66'), puffs: 18, spread: 1.4, up: [0.5, 2.2], size: [0.8, 2.8], life: [0.9, 1.7] } as const;
/** How long a money toast stays up (s). */
const MONEY_TOAST = 1.1;
/** Shakes, by what Cody's ride did: broke through a parapet, knocked a prop over, smashed one to bits, flattened a car. */
const SHAKE = { smash: 0.45, knock: 0.2, shatter: 0.35, crush: 0.35, puff: 0.05, swallow: 0.08 } as const;

const _at = new Vector3();
const _v = new Vector3();
const _w = new Vector3();
const _tint = new Color();

type Rows = { readonly [K in keyof GameEvents]?: (e: GameEvents[K], s: Stage) => void };

/**
 * How each game event looks and feels: the shakes, toasts and bursts that go with it (what it
 * sounds like is src/audio/sound.ts's). Whoever did it, the world shows it; the view shakes and
 * the HUD says so only when it was Cody.
 */
export const EFFECTS: Rows = {
  // concrete flying on with the truck, and a splash of slime
  smashed: ({ at, by }, s) => {
    for (let i = 0; i < 26; i++) {
      _v.set(at.x + (Math.random() - 0.5) * 3, at.y, at.z + (Math.random() - 0.5) * 3);
      _w.set(by.vel.x * 0.5 + (Math.random() - 0.5) * 8, 3 + Math.random() * 6, by.vel.z * 0.5 + (Math.random() - 0.5) * 8);
      s.debris.spawn(_v, _w, 0.25 + Math.random() * 0.45, 2.5, CONCRETE, s.groundAt(_v.x, _v.z, at.y - 0.5));
    }
    s.slime.burst(at, 24, 7, [0.12, 0.3], [1, 2], SLIME, 0.8, at.y - 0.6);
    if (by !== s.ride()) return;
    s.shake(SHAKE.smash);
    s.toast('SMASH!', '', 'purple', 0.9);
  },
  prop: (e, s) => {
    if (e.how === 'landed') {
      // a lamp head hitting the ground: sparks of its light
      _tint.copy(e.light).multiplyScalar(SPARK.glow);
      s.slime.burst(e.at, 16, 6, SPARK.size, SPARK.life, _tint, 0.8, s.groundAt(e.at.x, e.at.z, e.at.y + 0.5));
      return;
    }
    const colors = e.kind.debris ?? [METAL];
    const mine = !!e.by && e.by === s.ride();
    if (e.how === 'knocked') {
      // a vehicle's knock chips bits off it (a gate arm snapping doesn't)
      if (e.by) for (const c of colors) s.debris.burst(e.at, Math.ceil(6 / colors.length), 5, [0.08, 0.2], [0.8, 1.4], c, 0.6, e.by.pos.y);
      if (mine) s.shake(SHAKE.knock);
      return;
    }
    // flies apart from all through the room it filled
    const { min: lo, max: hi } = e;
    const n = Math.min(SHATTER.count[1], Math.max(SHATTER.count[0], Math.round((hi.x - lo.x) * (hi.y - lo.y) * (hi.z - lo.z) * SHATTER.perM3)));
    const floor = s.groundAt((lo.x + hi.x) / 2, (lo.z + hi.z) / 2, lo.y + 0.5);
    colors.forEach((c, k) => {
      for (let i = k; i < n; i += colors.length) {
        _v.set(lerp(lo.x, hi.x, Math.random()), lerp(lo.y, hi.y, Math.random()), lerp(lo.z, hi.z, Math.random()));
        const a = Math.random() * TAU;
        const out = Math.random() * SHATTER.out;
        _w.set(Math.cos(a) * out, lerp(SHATTER.up[0], SHATTER.up[1], Math.random()), Math.sin(a) * out);
        s.debris.spawn(_v, _w, lerp(SHATTER.size[0], SHATTER.size[1], Math.random()), SHATTER.life, c, floor);
      }
    });
    if (mine) s.shake(SHAKE.shatter);
  },
  // flattened: slime, and bits of it in its own paint
  crushed: ({ car, by }, s) => {
    s.slime.burst(car.pos, 30, 8, [0.15, 0.35], [1, 2], SLIME, 0.7, car.pos.y);
    s.debris.burst(_at.copy(car.pos).setY(car.pos.y + 0.8), 10, 6, [0.15, 0.3], [1, 2], _tint.set(car.color), 0.6, car.pos.y);
    if (by === s.ride()) s.shake(SHAKE.crush);
  },
  vanished: ({ at }, s) => {
    _at.copy(at).setY(at.y + 1.5);
    s.slime.burst(_at, 50, 9, [0.15, 0.45], [1, 2], SLIME, 1, at.y);
    s.sprites.spray(_at, 8, 5, [3, 6], WHITE, 1.5, 3, 1.6, 'ghost', 0.9);
  },
  // Cody's ride hitting things, coming down hard (a splash of slime, and concrete off the truck)
  impact: ({ v, took, against }, s) => {
    if (v !== s.ride()) return;
    if (against === 'car') {
      if (took > 3) s.shake(Math.min(0.5, took * 0.05));
      return;
    }
    if (against === 'wall') {
      if (took > 6) s.shake(Math.min(0.5, took * 0.03));
      return;
    }
    if (took <= 8) return;
    s.shake(Math.min(0.8, took * 0.03));
    s.slime.burst(v.pos, Math.min(50, Math.round(took * 2)), took * 0.4, [0.15, 0.4], [0.8, 1.6], SLIME, 0.7, v.pos.y);
    if (v.form === 'truck') s.debris.burst(v.pos, 12, 6, [0.15, 0.35], [1, 2], CONCRETE, 0.5, v.pos.y);
  },
  swallowed: ({ n, at }, s) => {
    s.sprites.spray(at, 4 * n, 1.2, [0.5, 1.5], WHITE, 1, 0.2, 0.5, 'ghost', 0.8);
    s.shake(SHAKE.swallow * n);
  },
  puff: ({ at }, s) => {
    _at.copy(at).setY(at.y + 0.9);
    s.sprites.spray(_at, PUFF.puffs, PUFF.spread, PUFF.up, PUFF.color, PUFF.size[0], PUFF.size[1], PUFF.life, 'puff', 0.9);
    s.shake(SHAKE.puff);
  },
  money: ({ kind, amount }, s) => {
    if (kind === 'wallet') s.toast('WALLET!', `+$${amount}`, '', MONEY_TOAST);
    else if (kind === 'glovebox') s.toast('GLOVEBOX', `+$${amount}`, '', MONEY_TOAST);
    else s.toast(`+$${amount}`, '', '', MONEY_TOAST);
  },
};

function hasRow(name: string): name is keyof GameEvents {
  return Object.hasOwn(EFFECTS, name);
}

/** Plays the effects of every event on `stage` from now on. */
export function playEffects(events: Emitter<GameEvents>, stage: Stage): void {
  const hook = <K extends keyof GameEvents>(name: K): void => {
    const row = EFFECTS[name];
    if (row) events.on(name, (e) => row(e, stage));
  };
  for (const name of Object.keys(EFFECTS)) if (hasRow(name)) hook(name);
}
