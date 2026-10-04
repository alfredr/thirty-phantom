import type { Vehicle } from '@/actors/vehicles/vehicle';
import { TUNING } from '@/config';
import { clamp } from '@/engine/core/math';
import { KEYS, keyName } from '@/game/controls';
import type { Game, GameEvents } from '@/game/game';
import { ITEM_BREEDS } from '@/game/items/item-breeds';

import type { SoundOf } from './cues';
import { soundLog } from './flags';
import { Loops } from './loops';
import { Mixer } from './mixer';

const I = TUNING.audio.impact;

/** Driver anger threshold for selecting the louder horn variant. */
const ANGRY = 0.6;
/** Map prop kinds to impact sounds; unknown kinds use the fence sound. */
const PROPS: Readonly<Record<string, SoundOf<'prop'>>> = {
  lamp: 'prop-lamp',
  fence: 'prop-fence',
  guardrail: 'prop-guardrail',
  railing: 'prop-railing',
  'gate-arm': 'prop-gate-arm',
  bench: 'prop-bench',
  tree: 'prop-tree',
  hedge: 'prop-hedge',
  shelter: 'prop-shelter',
};
const MUTED_KEY = '30pc.muted';

/** Read the saved mute preference; default to unmuted if storage is unavailable. */
function savedMuted(): boolean {
  try {
    return localStorage.getItem(MUTED_KEY) === '1';
  } catch {
    return false;
  }
}

function saveMuted(on: boolean): void {
  try {
    localStorage.setItem(MUTED_KEY, on ? '1' : '0');
  } catch {
    // Keep the current setting even if browser storage is unavailable.
  }
}

const SCREAMS: readonly [SoundOf<'scream'>, ...SoundOf<'scream'>[]] = ['scream-high', 'scream-mid', 'scream-low'];

declare global {
  interface Window {
    /** Audio controller exposed for console debugging and browser tests. */
    __sound?: Sound;
  }
}

/**
 * Translate game events into sound cues and update continuous sounds each frame. Audio starts after a user gesture,
 * suspends while the page is hidden, and remembers the mute setting across reloads.
 */
export class Sound {
  readonly mixer = new Mixer();
  private readonly loops = new Loops(this.mixer);
  /** When each vehicle last made an impact sound (game seconds). */
  private readonly lastHit = new WeakMap<Vehicle, number>();
  private time = 0;
  /** Keep the ringtone active between phone ring and hangup events. */
  private calling = false;

  constructor(private readonly game: Game) {
    this.listen();
    const ev = game.events;
    ev.on('frame', (dt) => this.frame(dt));
    ev.on('honk', (e) => this.honk(e));
    ev.on('impact', (e) => this.impact(e));
    ev.on('prop', ({ kind, at, how }) =>
      this.mixer.play('prop', how === 'landed' ? 'prop-lamp-down' : (PROPS[kind.name] ?? 'prop-fence'), { at }),
    );
    ev.on('smashed', ({ at }) => this.mixer.play('smash', 'smash-parapet', { at }));
    ev.on('crushed', ({ car }) => this.mixer.play('crush', 'crush-car', { at: car.pos }));
    ev.on('stoked', ({ at }) => this.mixer.play('stoke', 'fire-whoomph', { at }));
    ev.on('puff', ({ at }) => this.mixer.play('puff', 'puff-smoke', { at }));
    ev.on('swallowed', ({ n, tank }) =>
      this.mixer.play('swallow', 'ghast-slurp', {
        gain: Math.min(1.3, 0.8 + 0.15 * n),
        note: `${n} ghost${n > 1 ? 's' : ''}, tank ${Math.round(tank * 100)}%`,
      }),
    );
    ev.on('boosted', () => this.mixer.play('ignite', 'boost-ignite'));
    ev.on('money', ({ kind, amount }) =>
      this.mixer.play(
        'money',
        kind === 'wallet' ? 'coin-wallet' : kind === 'glovebox' ? 'coin-glovebox' : 'coin-cash',
        { note: `$${amount}` },
      ),
    );
    ev.on('item', (d) => {
      if (d.how === 'got') {
        this.mixer.play('item', ITEM_BREEDS[d.kind].sound, { note: d.kind });
      }
    });
    ev.on('phone', (what) => {
      if (what === 'text') {
        this.mixer.play('text', 'phone-text');
      } else {
        this.calling = what === 'ring';
      }
    });
    ev.on('nightfall', () => this.mixer.play('moonrise', 'stinger-moonrise'));
    ev.on('sunrise', () => {
      this.mixer.play('dawn', 'stinger-dawn');

      // Play the reverse transformation for trucks changing back at sunrise.
      for (const v of game.vehicles) {
        if (v.status === 'transforming' && v.form === 'truck') {
          this.mixer.play('morph', 'morph-car', { at: v.pos });
        }
      }
    });
    ev.on('outfit', ({ form, at }) =>
      this.mixer.play('outfit', form === 'night' ? 'outfit-phantom' : 'outfit-day', { at }),
    );
    ev.on('entered', ({ v, possessed }) => {
      if (possessed) {
        this.mixer.play('morph', 'morph-truck', { at: v.pos });
      }
    });
    ev.on('phantom', () => this.mixer.play('phantom', 'phantom-imprint'));
    ev.on('fright', ({ at }) =>
      this.mixer.play('scream', SCREAMS[Math.floor(Math.random() * SCREAMS.length)] ?? SCREAMS[0], { at }),
    );
    ev.on('crossing', ({ vehicle, kind }) => {
      if (kind === 'logged-in' || kind === 'logged-out') {
        this.mixer.play('badge', 'badge-beep', { at: vehicle.pos });
      } else if (kind === 'snuck-in') {
        this.mixer.play('badge', 'badge-buzz', { at: vehicle.pos });
      }
    });
    window.__sound = this;
    soundLog(`on: audio starts with the first key, click or tap; ${keyName('mute')} mutes`);
  }

  /** Register user gestures, page visibility changes, and the mute shortcut. */
  private listen(): void {
    this.mixer.setMuted(savedMuted());
    const wake = (): void => this.mixer.unlock();
    for (const type of ['pointerdown', 'keydown', 'touchend'] as const) {
      window.addEventListener(type, wake, { capture: true });
    }

    document.addEventListener('visibilitychange', () => (document.hidden ? this.mixer.suspend() : this.mixer.unlock()));
    const mute: readonly string[] = KEYS.mute;
    window.addEventListener('keydown', (e) => {
      if (e.repeat || !mute.includes(e.code)) {
        return;
      }

      const on = !this.mixer.isMuted;
      this.mixer.setMuted(on);
      this.game.hud.toast(on ? 'SOUND OFF' : 'SOUND ON', '', '', 1);
      saveMuted(on);
      soundLog(on ? 'muted' : 'unmuted');
    });
  }

  private frame(dt: number): void {
    this.time += dt;
    const g = this.game;
    const ride = g.vehicles.find((v) => v.role === 'player' && !v.status) ?? null;
    // Listen from the cutscene focus or Cody's position; pan sounds using the active camera.
    this.mixer.ear.copy(g.cutscene?.focus ?? ride?.pos ?? g.player.pos);
    const cam = g.gfx.chaseView ? g.chase.camera : g.iso.camera;
    this.mixer.right.set(1, 0, 0).applyQuaternion(cam.quaternion).setY(0).normalize();
    // Stop ringing when dialogue opens, even while the phone still shows the call screen.
    this.loops.ringing = this.calling && !document.body.classList.contains('dialogue-open');
    this.loops.update(dt, {
      cars: g.vehicles,
      ride,
      throttle: ride ? g.input.axis('back', 'forward') : 0,
      burning: g.burning,
      npcs: g.npcs.list,
      gates: g.world.gates.list,
      hours: g.clock.hours,
    });
    this.mixer.update();
  }

  /** Select a horn variant and volume from the driver's anger. */
  private honk({ car, at, anger }: GameEvents['honk']): void {
    const horn = car.breed.horn;
    if (!horn) {
      return;
    }

    const [calm, angry] = horn;
    this.mixer.play('honk', anger >= ANGRY ? angry : calm, {
      at,
      gain: 0.85 + 0.3 * anger,
      note: `car ${car.id}, anger ${anger.toFixed(2)}`,
    });
  }

  /** Select an impact cue from collision severity and surface, rate-limited per vehicle. */
  private impact({ v, at, dv, against }: GameEvents['impact']): void {
    if (dv < (against === 'ground' ? I.land : I.bump)) {
      return;
    }

    if (this.time - (this.lastHit.get(v) ?? -Infinity) < I.again) {
      return;
    }

    this.lastHit.set(v, this.time);
    const note = `${dv.toFixed(1)} m/s`;
    if (against === 'ground') {
      this.mixer.play('land', v.form === 'truck' ? 'land-truck' : 'land-car', {
        at,
        gain: clamp(dv / 15, 0.5, 1.2),
        note,
      });
    } else if (dv < I.crash) {
      this.mixer.play('bump', against === 'car' ? 'bump-car' : 'bump-wall', {
        at,
        gain: 0.6 + (0.4 * (dv - I.bump)) / (I.crash - I.bump),
        note,
      });
    } else {
      const sound = dv >= I.hard ? 'crash-hard' : against === 'car' ? 'crash-car' : 'crash-wall';
      this.mixer.play('crash', sound, { at, gain: clamp(dv / I.hard, 0.6, 1.2), note });
    }
  }
}
