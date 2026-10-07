import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadModules } from './modules.mjs';

const [
  { Director },
  { all, on, hold, run, when },
  { Action, done, fail, instead, running },
  { Sequence, Wait },
  { releaseOnce },
] = await loadModules(
  '/src/game/story/director.ts',
  '/src/game/story/behaviors.ts',
  '/src/engine/sim/action.ts',
  '/src/engine/sim/sequence.ts',
  '/src/engine/core/disposable.ts',
);

test('reusing a behavior definition keeps elapsed time separate for each execution', () => {
  const beats = {
    waiting: { parts: [when((c) => c.ready, { for: 2 })], next: null },
  };
  const first = new Director(beats, { ready: true }, { prefix: 'first' });
  const second = new Director(beats, { ready: true }, { prefix: 'second' });
  first.start('waiting');
  second.start('waiting');
  first.tick(1);
  second.tick(1);
  assert.equal(first.beat, 'waiting');
  assert.equal(second.beat, 'waiting');
  first.tick(1);
  assert.equal(first.beat, null);
  assert.equal(second.beat, 'waiting');
  second.tick(1);
  assert.equal(second.beat, null);
});

test('parallel parts retire on completion while their siblings keep running', () => {
  const log = [];
  const scopes = [];
  const part = (name) => (s) => {
    scopes.push(s);
    return {
      tick: () => log.push(`${name}:tick`),
      on: (e) => {
        log.push(`${name}:${e.type}`);

        if (e.type === name) {
          s.done();
        }
      },
      progressed: () => log.push(`${name}:progress`),
      stop: () => log.push(`${name}:stop`),
    };
  };

  const director = new Director(
    { both: { parts: [all([part('a'), part('b')])], next: null } },
    {},
    { prefix: 'test' },
  );
  director.start('both');
  assert.notEqual(
    scopes[0].key,
    scopes[1].key,
    'each branch owns its outreach',
  );
  director.send({ type: 'a' });
  assert.equal(director.beat, 'both');
  director.tick(1);
  scopes[1].progress();
  director.send({ type: 'b' });
  assert.equal(director.beat, null);
  assert.deepEqual(log, [
    'a:a',
    'a:stop',
    'b:a',
    'b:tick',
    'b:progress',
    'b:b',
    'b:stop',
  ]);
});

test('leaving parallel parts cleans up once in reverse order and ignores late completion', () => {
  const log = [];
  const scopes = [];
  const parts = ['a', 'b'].map((name) => (s) => {
    scopes.push(s);
    return { stop: () => log.push(name) };
  });
  const director = new Director(
    {
      both: { parts: [all(parts), on('skip')], next: 'next' },
      next: { parts: [], next: null },
    },
    {},
    { prefix: 'test' },
  );
  director.start('both');
  director.send({ type: 'skip' });
  scopes.forEach((s) => s.done());
  director.tick(1);
  assert.equal(director.beat, 'next');
  assert.deepEqual(log, ['b', 'a']);
});

test('parallel parts can complete during creation and still release their resources once', () => {
  const log = [];
  const part = (name) => (s) => {
    log.push(`${name}:start`);
    s.done();
    return { stop: () => log.push(`${name}:stop`) };
  };

  const director = new Director(
    { both: { parts: [all([part('a'), part('b')])], next: null } },
    {},
    { prefix: 'test' },
  );
  director.start('both');
  assert.equal(director.beat, null);
  assert.deepEqual(log, ['a:start', 'a:stop', 'b:start', 'b:stop']);
});

test('an empty parallel group completes immediately', () => {
  const director = new Director(
    { empty: { parts: [all([])], next: null } },
    {},
    { prefix: 'test' },
  );
  director.start('empty');
  assert.equal(director.beat, null);
});

test('beat resources stay held without an action and release in reverse order on exit', () => {
  const log = [];
  const resource = (name) => () => {
    log.push(`take:${name}`);
    return releaseOnce(() => log.push(`release:${name}`));
  };

  const director = new Director(
    {
      scene: {
        parts: [hold(resource('camera'), resource('attention')), on('leave')],
        next: null,
      },
    },
    {},
    { prefix: 'test' },
  );
  director.start('scene');
  director.tick(100);
  assert.equal(director.beat, 'scene');
  assert.deepEqual(log, ['take:camera', 'take:attention']);
  director.send({ type: 'leave' });
  assert.deepEqual(log, [
    'take:camera',
    'take:attention',
    'release:attention',
    'release:camera',
  ]);
});

test('failed acquisition releases earlier beat resources', () => {
  const log = [];
  const part = hold(
    () => releaseOnce(() => log.push('released')),
    () => {
      throw new Error('unavailable');
    },
  );
  assert.throws(() => part({}, {}), /unavailable/);
  assert.deepEqual(log, ['released']);
});

test('a resource cleanup failure does not prevent the remaining beat resources from releasing', () => {
  const log = [];
  const active = hold(
    () => releaseOnce(() => log.push('released')),
    () =>
      releaseOnce(() => {
        throw new Error('cleanup failed');
      }),
  )({}, {});
  assert.throws(() => active.stop(), AggregateError);
  active.stop();
  assert.deepEqual(log, ['released']);
});

test('a running action is cancelled when its beat ends, including its generator resources', () => {
  const log = [];
  const action = () =>
    new Sequence(function* () {
      const held = releaseOnce(() => log.push('release'));
      try {
        yield new Wait(5);
        log.push('finished');
        return done;
      } finally {
        held();
      }
    });
  const director = new Director(
    { scene: { parts: [run(action), on('leave')], next: null } },
    {},
    { prefix: 'test' },
  );
  director.start('scene');
  director.tick(1);
  director.send({ type: 'leave' });
  director.tick(10);
  assert.deepEqual(log, ['release']);
  assert.equal(director.beat, null);
});

test('the director resolves and replaces actions before advancing the beat', () => {
  const log = [];
  class Finish extends Action {
    perform() {
      log.push('finish');
      return done;
    }
    stop() {
      log.push('stop:finish');
    }
  }
  class Begin extends Action {
    perform(_w, dt) {
      return dt > 0 ? instead(new Finish()) : running;
    }
    stop() {
      log.push('stop:begin');
    }
  }
  class Choose extends Action {
    resolve() {
      return new Begin();
    }
    perform() {
      assert.fail('a resolved action must not run');
    }
  }
  const director = new Director(
    { scene: { parts: [run(() => new Choose())], next: null } },
    {},
    { prefix: 'test' },
  );
  director.start('scene');
  assert.equal(director.beat, 'scene');
  director.tick(1);
  assert.equal(director.beat, null);
  assert.deepEqual(log, ['stop:begin', 'finish', 'stop:finish']);
});

test('an immediate action advances the beat and releases resources acquired before it', () => {
  let releases = 0;
  const director = new Director(
    {
      scene: {
        parts: [
          hold(() => releaseOnce(() => releases++)),
          run(() => new Wait(0)),
        ],
        next: null,
      },
    },
    {},
    { prefix: 'test' },
  );
  director.start('scene');
  assert.equal(director.beat, null);
  assert.equal(releases, 1);
});

test('an action failure reports struggle once and leaves the beat pending', () => {
  let struggles = 0;
  class Refused extends Action {
    perform() {
      return fail('NO ROUTE');
    }
  }
  const active = run(() => new Refused())(
    {
      struggle: () => struggles++,
      done: () => assert.fail('failed beat advanced'),
    },
    {},
  );
  active.tick(1);
  active.tick(1);
  active.stop();
  assert.equal(struggles, 1);
});
