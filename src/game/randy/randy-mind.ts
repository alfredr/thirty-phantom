import type { Vector3 } from 'three';
import { type EventOf, mind, type MindEvent, type State, type StateOf } from '@/engine/sim/mind';
import type { Npc } from './npcs';

/** He holds the coat open this long (s), then closes it and waits this long before the next pitch. */
const PITCH_HOLD = 3.5;
const PITCH_REST = 4;
/** Tires go into the fire one after another, this far apart (s); then a beat before he's back to the stick. */
const FEED_EVERY = 0.35;
const FEED_AFTER = 0.5;

/** His sales routine: coat shut between pitches, open while he pitches to Cody close by. */
export type Pitch =
  /** Between pitches: coat shut, back to the fire. Seconds since the last pitch. */
  | State<'resting', { t: number }>
  /** Coat open on his wares, turned to Cody. Seconds into the pitch. */
  | State<'pitching', { t: number }>
  /** Cody's at his wares: the coat stays open till he goes. */
  | State<'browsing'>
  /** A scene has him: he faces what it says (or Cody, given nothing), and opens his coat when it says. */
  | State<'directed', { open: boolean; face: Vector3 | null }>;

/** His fire. */
export type Work =
  /** Roasting on the stick, as always. */
  | State<'roasting'>
  /** Tires going into the fire one by one: how many are still to go of how many, the time since the last, and where they come from (Cody's hands). */
  | State<'feeding', { left: number; of: number; t: number; from: Vector3 }>;

/** What can happen to Randy. Either of his minds can be sent any of these; each moves only on the ones its state lists. */
export type RandyEvent =
  /** A scene takes him, to face `face` (or Cody). */
  | MindEvent<'held', { face: Vector3 | null }>
  /** The scene opens or shuts his coat. */
  | MindEvent<'flash', { open: boolean }>
  /** The scene's done with him. */
  | MindEvent<'released'>
  /** Cody's come up to his wares. */
  | MindEvent<'browse'>
  /** Cody's gone from them. */
  | MindEvent<'browseEnded'>
  /** Cody's handed him `n` tires, from his hands at `from`. */
  | MindEvent<'given', { n: number; from: Vector3 }>;

const directed = (_n: Npc, _s: Pitch, { face }: EventOf<RandyEvent, 'held'>): StateOf<Pitch, 'directed'> => ({ at: 'directed', open: false, face });

/** The pitch: open for a while when Cody's close, shut for a while, again; held open while he browses, and as a scene says while it has him. */
export const RANDY_PITCH = mind<Npc, Pitch, RandyEvent>({
  resting: {
    tick: (n, s, dt) => ((s.t += dt) > PITCH_REST && n.near ? { at: 'pitching', t: 0 } : null),
    on: { held: directed },
  },
  pitching: {
    tick: (n, s, dt) => {
      s.t += dt;
      // Cody's gone: shut, but the rest counts from the pitch's start, so he's soon at it again if Cody's back
      if (!n.near) return { at: 'resting', t: s.t };
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

/** The fire. Tires go in only while he's just roasting: one hand-over at a time. */
export const RANDY_WORK = mind<Npc, Work, RandyEvent>({
  roasting: {
    // the first goes in straight away
    on: { given: (_n, _s, { n, from }) => ({ at: 'feeding', left: n, of: n, t: FEED_EVERY, from: from.clone() }) },
  },
  feeding: {
    tick: (n, s, dt) => {
      s.t += dt;
      if (s.left > 0) {
        if (s.t < FEED_EVERY) return null;
        s.t = 0;
        s.left--;
        n.npcs.feedTire(n, s.from);
        return null;
      }
      if (s.t < FEED_EVERY + FEED_AFTER) return null;
      n.npcs.fed(n, s.of);
      return { at: 'roasting' };
    },
  },
});
