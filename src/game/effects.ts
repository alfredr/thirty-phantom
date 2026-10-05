import { Color, Vector3 } from 'three';

import type { Vehicle } from '@/actors/vehicles/vehicle';
import type { Emitter } from '@/engine/core/events';
import { lerp, TAU } from '@/engine/core/math';
import { SLIME, WHITE } from '@/fx/colors';
import type { CubeParticles } from '@/fx/cube-particles';
import type { SpriteFx } from '@/fx/sprite-fx';
import type { ToastTone } from '@/ui/hud';

import type { GameEvents } from './game';

/** Rendering and HUD services used by event effects. */
export interface Stage {
  /** Return Cody’s current vehicle to identify impacts that should shake the camera. */
  ride(): Vehicle | null;
  shake(trauma: number): void;
  flash(amount: number, color: string): void;
  toast(title: string, sub: string, tone: ToastTone, seconds: number): void;
  readonly slime: CubeParticles;
  readonly debris: CubeParticles;
  readonly sprites: SpriteFx;
  /** Return the ground height at or below `y` for particle collisions. */
  groundAt(x: number, z: number, y: number): number;
}

const CONCRETE = new Color('#8f889c');
/** Fallback debris color for props without PropKind.debris. */
const METAL = new Color('#5a5266');
/** Lamp spark brightness multiplier, size range in meters, and lifetime range in seconds. */
const SPARK = { glow: 2.5, size: [0.05, 0.12], life: [0.3, 0.7] } as const;
/** Debris density per cubic meter, bounded particle count, size in meters, lifetime in seconds, and launch speed in m/s. */
const SHATTER = { perM3: 3, count: [12, 36], size: [0.1, 0.32], life: 2.2, out: 5, up: [2, 6] } as const;
/** Smoke appearance and emission settings. Distances use meters, velocities use m/s, and lifetimes use seconds. */
const PUFF = {
  color: new Color('#5a4e66'),
  puffs: 18,
  spread: 1.4,
  up: [0.5, 2.2],
  size: [0.8, 2.8],
  life: [0.9, 1.7],
} as const;
/** Money notification duration in seconds. */
const MONEY_TOAST = 1.1;
/** Camera trauma added by each effect. */
const SHAKE = {
  smash: 0.45,
  knock: 0.2,
  shatter: 0.35,
  crush: 0.35,
  puff: 0.05,
  swallow: 0.08,
  flare: 0.5,
  cough: 0.06,
  roar: 0.25,
} as const;
const FLAME = new Color(3.2, 1.4, 0.35);
const FLARE_FLASH = 0.75;
const SOOT = new Color('#2a2026');

const _at = new Vector3();
const _v = new Vector3();
const _w = new Vector3();
const _tint = new Color();

type Rows = { readonly [K in keyof GameEvents]?: (e: GameEvents[K], s: Stage) => void };

/**
 * Map game events to particles, camera shake, and HUD notifications. Vehicle collision feedback is restricted to Cody’s
 * ride. Audio is handled by src/audio/sound.ts.
 */
export const EFFECTS: Rows = {
  keysFound: ({ plate }, s) => s.toast(`KEYS FOR ${plate}`, '', '', 2.5),
  hotwired: (_e, s) => s.toast('HOTWIRED!', '', '', 1.8),
  // Debris inherits half the vehicle’s horizontal velocity.
  smashed: ({ at, by }, s) => {
    for (let i = 0; i < 26; i++) {
      _v.set(at.x + (Math.random() - 0.5) * 3, at.y, at.z + (Math.random() - 0.5) * 3);
      _w.set(
        by.vel.x * 0.5 + (Math.random() - 0.5) * 8,
        3 + Math.random() * 6,
        by.vel.z * 0.5 + (Math.random() - 0.5) * 8,
      );
      s.debris.spawn(_v, _w, 0.25 + Math.random() * 0.45, 2.5, CONCRETE, s.groundAt(_v.x, _v.z, at.y - 0.5));
    }

    s.slime.burst(at, 24, 7, [0.12, 0.3], [1, 2], SLIME, 0.8, at.y - 0.6);

    if (by !== s.ride()) {
      return;
    }

    s.shake(SHAKE.smash);
    s.toast('SMASH!', '', 'purple', 0.9);
  },
  prop: (e, s) => {
    if (e.how === 'landed') {
      // Tint sparks with the lamp’s light color.
      _tint.copy(e.light).multiplyScalar(SPARK.glow);
      s.slime.burst(e.at, 16, 6, SPARK.size, SPARK.life, _tint, 0.8, s.groundAt(e.at.x, e.at.z, e.at.y + 0.5));
      return;
    }

    const colors = e.kind.debris ?? [METAL];
    const mine = !!e.by && e.by === s.ride();
    if (e.how === 'knocked') {
      // Emit impact debris only when a vehicle caused the knock.
      if (e.by) {
        for (const c of colors) {
          s.debris.burst(e.at, Math.ceil(6 / colors.length), 5, [0.08, 0.2], [0.8, 1.4], c, 0.6, e.by.pos.y);
        }
      }

      if (mine) {
        s.shake(SHAKE.knock);
      }

      return;
    }

    // Distribute debris throughout the prop’s bounds.
    const { min: lo, max: hi } = e;
    const n = Math.min(
      SHATTER.count[1],
      Math.max(SHATTER.count[0], Math.round((hi.x - lo.x) * (hi.y - lo.y) * (hi.z - lo.z) * SHATTER.perM3)),
    );
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

    if (mine) {
      s.shake(SHAKE.shatter);
    }
  },

  crushed: ({ car, by }, s) => {
    s.slime.burst(car.pos, 30, 8, [0.15, 0.35], [1, 2], SLIME, 0.7, car.pos.y);
    s.debris.burst(
      _at.copy(car.pos).setY(car.pos.y + 0.8),
      10,
      6,
      [0.15, 0.3],
      [1, 2],
      _tint.set(car.color),
      0.6,
      car.pos.y,
    );

    if (by === s.ride()) {
      s.shake(SHAKE.crush);
    }
  },
  vanished: ({ at }, s) => {
    _at.copy(at).setY(at.y + 1.5);
    s.slime.burst(_at, 50, 9, [0.15, 0.45], [1, 2], SLIME, 1, at.y);
    s.sprites.spray(_at, 8, 5, [3, 6], WHITE, 1.5, 3, 1.6, 'ghost', 0.9);
  },

  impact: ({ v, took, against }, s) => {
    if (v !== s.ride()) {
      return;
    }

    if (against === 'car') {
      if (took > 3) {
        s.shake(Math.min(0.5, took * 0.05));
      }

      return;
    }

    if (against === 'wall') {
      if (took > 6) {
        s.shake(Math.min(0.5, took * 0.03));
      }

      return;
    }

    if (took <= 8) {
      return;
    }

    s.shake(Math.min(0.8, took * 0.03));
    s.slime.burst(v.pos, Math.min(50, Math.round(took * 2)), took * 0.4, [0.15, 0.4], [0.8, 1.6], SLIME, 0.7, v.pos.y);

    if (v.form === 'truck') {
      s.debris.burst(v.pos, 12, 6, [0.15, 0.35], [1, 2], CONCRETE, 0.5, v.pos.y);
    }
  },
  swallowed: ({ n, at }, s) => {
    s.sprites.spray(at, 4 * n, 1.2, [0.5, 1.5], WHITE, 1, 0.2, 0.5, 'ghost', 0.8);
    s.shake(SHAKE.swallow * n);
  },
  sfx: ({ name, at }, s) => {
    if (name === 'engine-cough') {
      s.sprites.spray(at, 5, 0.35, [0.4, 1], SOOT, 0.4, 1.2, [0.6, 1.1], 'puff', 0.8);
      s.shake(SHAKE.cough);
      return;
    }

    if (name === 'engine-roar') {
      s.sprites.spray(at, 10, 0.6, [0.6, 1.6], SOOT, 0.6, 1.8, [0.8, 1.4], 'puff', 0.85);
      s.shake(SHAKE.roar);
      return;
    }

    if (name !== 'fire-flare') {
      return;
    }

    _at.copy(at).setY(at.y + 1.2);
    s.sprites.spray(_at, 24, 1.4, [4, 9], FLAME, 1.6, 4.2, [0.6, 1.3], 'puff', 1);
    s.sprites.spray(_at.setY(at.y + 4), 16, 2.2, [1, 3], FLAME, 2.4, 5, [0.5, 1], 'puff', 1);
    s.sprites.spray(_at.setY(at.y + 2), 18, 2, [2, 5], SOOT, 2, 4.6, [2.4, 4], 'puff', 0.85);
    s.debris.burst(_at.setY(at.y + 1.2), 40, 7, [0.03, 0.09], [1, 2.2], FLAME, 2.4, at.y);
    s.flash(FLARE_FLASH, '#ffb347');
    s.shake(SHAKE.flare);
  },
  puff: ({ at }, s) => {
    _at.copy(at).setY(at.y + 0.9);
    s.sprites.spray(
      _at,
      PUFF.puffs,
      PUFF.spread,
      PUFF.up,
      PUFF.color,
      PUFF.size[0],
      PUFF.size[1],
      PUFF.life,
      'puff',
      0.9,
    );
    s.shake(SHAKE.puff);
  },
  money: ({ kind, amount }, s) => {
    if (kind === 'wallet') {
      s.toast('WALLET!', `+$${amount}`, '', MONEY_TOAST);
    } else if (kind === 'glovebox') {
      s.toast('GLOVEBOX', `+$${amount}`, '', MONEY_TOAST);
    } else {
      s.toast(`+$${amount}`, '', '', MONEY_TOAST);
    }
  },
};

function hasRow(name: string): name is keyof GameEvents {
  return Object.hasOwn(EFFECTS, name);
}

/** Subscribe the stage to the events defined in EFFECTS. */
export function playEffects(events: Emitter<GameEvents>, stage: Stage): void {
  const hook = <K extends keyof GameEvents>(name: K): void => {
    const row = EFFECTS[name];
    if (row) {
      events.on(name, (e) => row(e, stage));
    }
  };

  for (const name of Object.keys(EFFECTS)) {
    if (hasRow(name)) {
      hook(name);
    }
  }
}
