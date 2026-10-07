import type { Vector3 } from 'three';

import {
  type EventOf,
  Mind,
  mind,
  type MindEvent,
  type State,
  type StateOf,
} from '@/engine/sim/mind';
import type { ItemAmount } from '@/game/items/trades';

import type { Npc } from './npcs';

export type Facing = Vector3 | number | null;

/** Coat presentation states for proximity, browsing, and scripted scenes. */
export type Pitch =
  /** Wait with the coat closed; `t` tracks the rest timer in seconds. */
  | State<'resting', { t: number }>
  /** Present wares; `t` is elapsed pitch time in seconds. */
  | State<'pitching', { t: number }>
  /** Keep the coat open until browsing ends. */
  | State<'browsing'>
  /**
   * Let a scene control coat opening and facing: a point, a yaw in radians, or
   * null for Cody’s position.
   */
  | State<'directed', { open: boolean; face: Facing }>;

/** Fire-feeding states, independent of the coat presentation. */
export type Work =
  /** Wait for an exchange. */
  | State<'idle'>
  /**
   * Launch items from a fixed hand position, retaining the reward until
   * feeding completes.
   */
  | State<
      'feeding',
      { left: number; reward: ItemAmount; t: number; from: Vector3 }
    >;

/**
 * Events accepted by the pitch and work state machines; each state handles
 * only its declared events.
 */
export type NpcEvent =
  /** Give a scene control of facing and coat presentation. */
  | MindEvent<'held', { face: Facing }>
  /** Set the coat opening requested by the scene. */
  | MindEvent<'flash', { open: boolean }>
  /** Release scene control. */
  | MindEvent<'released'>
  /** Begin browsing the displayed wares. */
  | MindEvent<'browse'>
  /** End browsing. */
  | MindEvent<'browseEnded'>
  /** Start feeding `n` items from the supplied hand position. */
  | MindEvent<'given', { n: number; reward: ItemAmount; from: Vector3 }>;

const directed = (
  _n: Npc,
  _s: Pitch,
  { face }: EventOf<NpcEvent, 'held'>,
): StateOf<Pitch, 'directed'> => ({
  at: 'directed',
  open: false,
  face,
});

/**
 * Cycle proximity-based pitches, hold the coat open during browsing, and defer
 * to directed scenes.
 */
export function proximityPitch(timing: {
  readonly rest: number;
  readonly hold: number;
}) {
  const def = mind<Npc, Pitch, NpcEvent>({
    resting: {
      tick: (n, s, dt) =>
        (s.t += dt) > timing.rest && n.near ? { at: 'pitching', t: 0 } : null,
      on: { held: directed },
    },
    pitching: {
      tick: (n, s, dt) => {
        s.t += dt;

        // Preserve elapsed pitch time when Cody leaves so the next rest can finish sooner.
        if (!n.near) {
          return { at: 'resting', t: s.t };
        }

        return s.t > timing.hold ? { at: 'resting', t: 0 } : null;
      },
      on: { held: directed, browse: () => ({ at: 'browsing' }) },
    },
    browsing: {
      on: { held: directed, browseEnded: () => ({ at: 'resting', t: 0 }) },
    },
    directed: {
      on: {
        held: (_n, s, { face }) => ({ at: 'directed', open: s.open, face }),
        flash: (_n, s, { open }) => ({ at: 'directed', open, face: s.face }),
        released: () => ({ at: 'resting', t: 0 }),
      },
    },
  });
  return (n: Npc): Mind<Npc, Pitch, NpcEvent> =>
    new Mind(def, n, { at: 'resting', t: 0 });
}

/** Process one exchange at a time, launching items before reporting the reward. */
export function feedItems(spec: {
  readonly every: number;
  readonly after: number;
  launch(n: Npc, from: Vector3): void;
  finished(n: Npc, reward: ItemAmount): void;
}) {
  const def = mind<Npc, Work, NpcEvent>({
    idle: {
      // Prime the timer so the first item launches on the next tick.
      on: {
        given: (_n, _s, { n, reward, from }) => ({
          at: 'feeding',
          left: n,
          reward,
          t: spec.every,
          from: from.clone(),
        }),
      },
    },
    feeding: {
      tick: (n, s, dt) => {
        s.t += dt;

        if (s.left > 0) {
          if (s.t < spec.every) {
            return null;
          }

          s.t = 0;
          s.left--;
          spec.launch(n, s.from);
          return null;
        }

        if (s.t < spec.every + spec.after) {
          return null;
        }

        spec.finished(n, s.reward);
        return { at: 'idle' };
      },
    },
  });
  return (n: Npc): Mind<Npc, Work, NpcEvent> =>
    new Mind(def, n, { at: 'idle' });
}
