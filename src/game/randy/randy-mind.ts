import type { Vector3 } from 'three';

import { type EventOf, mind, type MindEvent, type State, type StateOf } from '@/engine/sim/mind';

import type { Npc } from './npcs';

/** Coat-open duration and delay between pitches, in seconds. */
const PITCH_HOLD = 3.5;
const PITCH_REST = 4;
/** Interval between tire launches and additional delay before returning to roasting, in seconds. */
const FEED_EVERY = 0.35;
const FEED_AFTER = 0.5;

/** Coat presentation states for proximity, browsing, and scripted scenes. */
export type Pitch =
  /** Wait with the coat closed; `t` tracks the rest timer in seconds. */
  | State<'resting', { t: number }>
  /** Present wares; `t` is elapsed pitch time in seconds. */
  | State<'pitching', { t: number }>
  /** Keep the coat open until browsing ends. */
  | State<'browsing'>
  /** Let a scene control coat opening and facing; null `face` uses Cody’s position. */
  | State<'directed', { open: boolean; face: Vector3 | null }>;

/** Fire-feeding states, independent of the coat presentation. */
export type Work =
  /** Wait for a tire handover. */
  | State<'roasting'>
  /** Launch tires from a fixed hand position, tracking remaining and total quantities plus the launch timer. */
  | State<'feeding', { left: number; of: number; t: number; from: Vector3 }>;

/** Events accepted by the pitch and work state machines; each state handles only its declared events. */
export type RandyEvent =
  /** Give a scene control of facing and coat presentation. */
  | MindEvent<'held', { face: Vector3 | null }>
  /** Set the coat opening requested by the scene. */
  | MindEvent<'flash', { open: boolean }>
  /** Release scene control. */
  | MindEvent<'released'>
  /** Begin browsing the displayed wares. */
  | MindEvent<'browse'>
  /** End browsing. */
  | MindEvent<'browseEnded'>
  /** Start feeding `n` tires from the supplied hand position. */
  | MindEvent<'given', { n: number; from: Vector3 }>;

const directed = (_n: Npc, _s: Pitch, { face }: EventOf<RandyEvent, 'held'>): StateOf<Pitch, 'directed'> => ({
  at: 'directed',
  open: false,
  face,
});

/** Cycle proximity-based pitches, hold the coat open during browsing, and defer to directed scenes. */
export const RANDY_PITCH = mind<Npc, Pitch, RandyEvent>({
  resting: {
    tick: (n, s, dt) => ((s.t += dt) > PITCH_REST && n.near ? { at: 'pitching', t: 0 } : null),
    on: { held: directed },
  },
  pitching: {
    tick: (n, s, dt) => {
      s.t += dt;

      // Preserve elapsed pitch time when Cody leaves so the next rest can finish sooner.
      if (!n.near) {
        return { at: 'resting', t: s.t };
      }

      return s.t > PITCH_HOLD ? { at: 'resting', t: 0 } : null;
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

/** Accept one tire batch at a time and report completion after the final launch delay. */
export const RANDY_WORK = mind<Npc, Work, RandyEvent>({
  roasting: {
    // Prime the timer so the first tire launches on the next tick.
    on: { given: (_n, _s, { n, from }) => ({ at: 'feeding', left: n, of: n, t: FEED_EVERY, from: from.clone() }) },
  },
  feeding: {
    tick: (n, s, dt) => {
      s.t += dt;

      if (s.left > 0) {
        if (s.t < FEED_EVERY) {
          return null;
        }

        s.t = 0;
        s.left--;
        n.npcs.feedTire(n, s.from);
        return null;
      }

      if (s.t < FEED_EVERY + FEED_AFTER) {
        return null;
      }

      n.npcs.fed(n, s.of);
      return { at: 'roasting' };
    },
  },
});
