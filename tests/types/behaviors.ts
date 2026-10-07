import type { MindEvent } from '@/engine/sim/mind';
import {
  act,
  after,
  all,
  on,
  progressOn,
  react,
  when,
  type BeatBehavior,
} from '@/game/story/behaviors';
import type { Beats } from '@/game/story/director';

type Context = { score: number };
type Event = MindEvent<'scored', { points: number }> | MindEvent<'left'>;
type Id = 'start' | 'finish';
type Behavior = BeatBehavior<Context, Event, Id>;

export const beats: Beats<Context, Event, Id> = {
  start: {
    parts: [
      act((c, s) => {
        c.score += 1;
        // @ts-expect-error The context has no missing property.
        void c.missing;
        // @ts-expect-error Transitions must name a declared beat.
        s.done('missing');
      }),
      on('scored', (c, e) => c.score + e.points > 10, 'finish'),
      progressOn('scored', (_c, e) => e.points > 0),
      react('left', (c, e) => {
        c.score = 0;
        // @ts-expect-error Only scored events carry points.
        void e.points;
      }),
      when((c) => c.score > 10, { next: 'finish' }),
      all([
        on('left'),
        after(2),
        react('scored', (c, e) => {
          c.score += e.points;
          // @ts-expect-error Event payloads keep their types inside a composition.
          e.points.toUpperCase();
        }),
      ]),
    ],
    next: 'finish',
  },
  finish: { parts: [], next: null },
};

export const invalid: readonly Behavior[] = [
  // @ts-expect-error Event names must belong to the enclosing beat's event union.
  on('missing'),
  // @ts-expect-error A transition cannot expand the enclosing beat's ID union.
  on('left', undefined, 'missing'),
  // @ts-expect-error A condition cannot transition to an unknown beat.
  when(() => true, { next: 'missing' }),
  // @ts-expect-error A timer cannot transition to an unknown beat.
  after(1, 'missing'),
];
