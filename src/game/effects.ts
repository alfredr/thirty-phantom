import { Color, Vector3 } from 'three';
import type { Vehicle } from '../actors/vehicle';
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
}

const CONCRETE = new Color('#8f889c');
/** A puff of smoke round someone vanishing or turning up: its colour, how many, how wide and high, how big, how long. */
const PUFF = { color: new Color('#5a4e66'), puffs: 18, spread: 1.4, up: [0.5, 2.2], size: [0.8, 2.8], life: [0.9, 1.7] } as const;
/** How long a money toast stays up (s). */
const MONEY_TOAST = 1.1;
/** Shakes, by what Cody's ride did: broke through a parapet, knocked a prop over, smashed one to bits, flattened a car. */
const SHAKE = { smash: 0.45, knock: 0.2, shatter: 0.35, crush: 0.35, puff: 0.05, swallow: 0.08 } as const;

const _at = new Vector3();

type Rows = { readonly [K in keyof GameEvents]?: (e: GameEvents[K], s: Stage) => void };

/**
 * How each game event looks and feels: the shakes, toasts and bursts that go with it (what it
 * sounds like is src/audio/sound.ts's). Whoever did it, the world shows it; the view shakes and
 * the HUD says so only when it was Cody.
 */
export const EFFECTS: Rows = {
  smashed: ({ by }, s) => {
    if (by !== s.ride()) return;
    s.shake(SHAKE.smash);
    s.toast('SMASH!', '', 'purple', 0.9);
  },
  prop: ({ how, by }, s) => {
    if (!by || by !== s.ride()) return;
    if (how === 'knocked') s.shake(SHAKE.knock);
    else if (how === 'shattered') s.shake(SHAKE.shatter);
  },
  crushed: ({ by }, s) => {
    if (by === s.ride()) s.shake(SHAKE.crush);
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
