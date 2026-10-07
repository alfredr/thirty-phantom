import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadModules } from './modules.mjs';

const [
  { scenes, playScene },
  { Action, Doing, done, fail, instead, running },
  { releaseOnce },
  { Sequence, Wait },
] = await loadModules(
  '/src/engine/sim/scene.ts',
  '/src/engine/sim/action.ts',
  '/src/engine/core/disposable.ts',
  '/src/engine/sim/sequence.ts',
);
const { action, sequence, holding, orElse, until } = scenes();

function setup(definition, name = 'scene') {
  const log = [];
  const world = { name };
  const context = { name, log };
  const acts = [];
  class Step extends Action {
    left;

    constructor(spec) {
      super();
      this.spec = spec;
      this.left = spec.seconds ?? 0;
      acts.push(this);
    }

    perform(w, dt) {
      assert.equal(w, world, 'the action receives its execution world');
      log.push(`${name}:${this.spec.id}:${dt}`);
      this.left -= dt;

      if (this.left > 0) {
        return running;
      }

      if (this.spec.throw) {
        throw new Error(this.spec.throw);
      }

      if (this.spec.cancel) {
        script.stop();
      }

      if (this.spec.cancelRunner) {
        runner.cancel(script);
      }

      if (this.spec.instead) {
        return instead(new Step(this.spec.instead));
      }

      return this.spec.fail ? fail(this.spec.fail) : done;
    }

    stop() {
      log.push(`stop:${this.spec.id}`);

      if (this.spec.cancelOnStop) {
        script.stop();
      }

      if (this.spec.stopThrows) {
        throw new Error('stop failed');
      }
    }
  }
  const script = playScene(definition, context, {
    action: (c, spec) => {
      assert.equal(c, context, 'every leaf receives the scene context');
      return new Step(spec);
    },
    until: (c, seconds, elapsed) => {
      assert.equal(c, context);
      return elapsed >= seconds;
    },
    acquire: (c, resource) => {
      assert.equal(c, context, 'every acquisition receives the scene context');

      if (resource === 'broken') {
        throw new Error('acquisition failed');
      }

      if (resource === 'cancel') {
        runner.cancel(script);
      }

      log.push(`hold:${resource}`);
      return releaseOnce(() => log.push(`release:${resource}`));
    },
  });
  const outcomes = [];
  const runner = new Doing({
    lost: () => false,
    end: (owner) => assert.equal(owner, script),
    performed: () => outcomes.push('done'),
    failed: (_action, why) => outcomes.push(why),
  });
  return { log, acts, outcomes, script, world, runner };
}

test('a serialized scene runs with independent state and explicit bindings', () => {
  const definition = holding(
    ['attention'],
    sequence([
      action({ id: 'walk', seconds: 1 }),
      holding(['shot'], action({ id: 'handoff', seconds: 0.5 })),
      action({ id: 'leave' }),
    ]),
  );
  const saved = JSON.stringify(definition);
  const a = setup(JSON.parse(saved), 'a');
  const b = setup(definition, 'b');
  assert.deepEqual(a.log, [], 'construction does not acquire resources');
  a.runner.do(a.world, a.script);
  b.runner.do(b.world, b.script);
  a.runner.update(a.world, 1);
  assert.deepEqual(a.log.slice(-3), ['stop:walk', 'hold:shot', 'a:handoff:0']);
  assert.deepEqual(b.log, ['hold:attention', 'b:walk:0']);
  a.runner.update(a.world, 0.5);
  assert.deepEqual(a.log.slice(-6), [
    'a:handoff:0.5',
    'stop:handoff',
    'release:shot',
    'a:leave:0',
    'stop:leave',
    'release:attention',
  ]);
  assert.deepEqual(a.outcomes, ['done']);
  assert.equal(
    JSON.stringify(definition),
    saved,
    'execution leaves the definition unchanged',
  );
  assert.ok(a.acts.every((step) => step.owner === a.script));
  b.runner.cancel(b.script);
  assert.deepEqual(b.log.slice(-2), ['stop:walk', 'release:attention']);
  assert.deepEqual(b.outcomes, ['cancelled']);
});

test('cancelling stops the active child before releasing leases, once', () => {
  const s = setup(
    holding(
      ['attention', 'shot'],
      sequence([action({ id: 'walk', seconds: 10 }), action({ id: 'later' })]),
    ),
  );
  s.runner.do(s.world, s.script);
  s.runner.cancel(s.script);
  s.script.stop();
  s.runner.update(s.world, 10);
  assert.deepEqual(s.log, [
    'hold:attention',
    'hold:shot',
    'scene:walk:0',
    'stop:walk',
    'release:shot',
    'release:attention',
  ]);
});

test('cancelling before startup acquires nothing', () => {
  const s = setup(holding(['shot'], action({ id: 'never' })));
  s.script.stop();
  assert.deepEqual(s.script.perform(s.world, 1), fail('cancelled'));
  assert.deepEqual(s.log, []);
});

test('cancellation inside an action stops the sequence without resuming the closed generator', () => {
  const s = setup(
    holding(
      ['shot'],
      sequence([
        action({ id: 'cancel', cancel: true }),
        action({ id: 'never' }),
      ]),
    ),
  );
  assert.deepEqual(s.runner.do(s.world, s.script), fail('cancelled'));
  assert.deepEqual(s.log, [
    'hold:shot',
    'scene:cancel:0',
    'stop:cancel',
    'release:shot',
  ]);
});

test('cancellation through the runner during an update closes the sequence and its leases', () => {
  const s = setup(
    holding(
      ['shot'],
      sequence([
        action({ id: 'cancel', cancelRunner: true, seconds: 1 }),
        action({ id: 'never' }),
      ]),
    ),
  );
  s.runner.do(s.world, s.script);
  s.runner.update(s.world, 1);
  s.runner.update(s.world, 1);
  assert.deepEqual(s.outcomes, ['cancelled']);
  assert.deepEqual(s.log, [
    'hold:shot',
    'scene:cancel:0',
    'scene:cancel:1',
    'stop:cancel',
    'release:shot',
  ]);
});

for (const when of ['startup', 'resume', 'cleanup']) {
  test(`cancellation from a nested generator during ${when} releases it before its parent`, () => {
    const log = [];
    const outcomes = [];
    const runner = new Doing({
      lost: () => false,
      end: () => undefined,
      failed: (_action, reason) => outcomes.push(reason),
      performed: () => assert.fail('cancelled sequence completed'),
    });
    const child = new Sequence(function* () {
      log.push('child acquired');

      try {
        if (when !== 'startup') {
          yield new Wait(1);
        }

        if (when !== 'cleanup') {
          runner.cancel(parent);
          yield new (class extends Action {
            perform() {
              assert.fail('cancelled generator started its next action');
            }
          })();
        }

        return done;
      } finally {
        if (when === 'cleanup') {
          runner.cancel(parent);
        }

        log.push('child released');
      }
    });
    const parent = new Sequence(function* () {
      log.push('parent acquired');

      try {
        yield child;
        assert.fail('cancelled parent resumed');
        return done;
      } finally {
        log.push('parent released');
      }
    });
    runner.do({}, parent);
    runner.update({}, 1);
    runner.update({}, 1);
    parent.stop();
    assert.deepEqual(parent.perform({}, 0), fail('cancelled'));
    assert.deepEqual(outcomes, ['cancelled']);
    assert.deepEqual(log, [
      'parent acquired',
      'child acquired',
      'child released',
      'parent released',
    ]);
  });
}

test('cancellation during acquisition releases the returned lease without starting its action', () => {
  const s = setup(holding(['attention', 'cancel'], action({ id: 'never' })));
  assert.deepEqual(s.runner.do(s.world, s.script), fail('cancelled'));
  s.runner.update(s.world, 1);
  assert.deepEqual(s.outcomes, ['cancelled']);
  assert.deepEqual(s.log, [
    'hold:attention',
    'hold:cancel',
    'release:cancel',
    'release:attention',
  ]);
});

test('partial acquisition failure releases earlier leases', () => {
  const s = setup(holding(['attention', 'broken'], action({ id: 'never' })));
  assert.throws(() => s.runner.do(s.world, s.script), /acquisition failed/);
  s.script.stop();
  assert.deepEqual(s.log, ['hold:attention', 'release:attention']);
});

test('failure closes a held branch before starting recovery', () => {
  const s = setup(
    orElse(
      holding(
        ['shot'],
        sequence([
          action({ id: 'walk', fail: 'NO ROUTE' }),
          action({ id: 'never' }),
        ]),
      ),
      action({ id: 'recover' }),
    ),
  );
  s.runner.do(s.world, s.script);
  assert.deepEqual(s.log, [
    'hold:shot',
    'scene:walk:0',
    'stop:walk',
    'release:shot',
    'scene:recover:0',
    'stop:recover',
  ]);
  assert.deepEqual(s.outcomes, ['done']);
});

test('a failed fallback reaches the existing runner without retrying effects', () => {
  const s = setup(
    orElse(
      action({ id: 'first', fail: 'NO ROUTE' }),
      action({ id: 'fallback', fail: 'BLOCKED' }),
    ),
  );
  s.runner.do(s.world, s.script);
  assert.equal(s.acts.length, 2);
  assert.deepEqual(s.outcomes, ['BLOCKED']);
});

test('replacement actions retain the scene owner and its resources', () => {
  const s = setup(
    holding(
      ['shot'],
      action({ id: 'first', instead: { id: 'replacement', seconds: 1 } }),
    ),
  );
  s.runner.do(s.world, s.script);
  assert.deepEqual(s.log, [
    'hold:shot',
    'scene:first:0',
    'stop:first',
    'scene:replacement:0',
  ]);
  assert.ok(s.acts.every((step) => step.owner === s.script));
  s.runner.update(s.world, 1);
  assert.deepEqual(s.log.slice(-2), ['stop:replacement', 'release:shot']);
  assert.deepEqual(s.outcomes, ['done']);
});

test('an action exception still stops its work and releases the scene', () => {
  const s = setup(
    holding(['shot'], action({ id: 'broken', throw: 'action failed' })),
  );
  assert.throws(() => s.runner.do(s.world, s.script), /action failed/);
  assert.deepEqual(s.log, [
    'hold:shot',
    'scene:broken:0',
    'stop:broken',
    'release:shot',
  ]);
});

test('a child cleanup exception does not prevent lease cleanup', () => {
  const s = setup(
    holding(['shot'], action({ id: 'broken', seconds: 10, stopThrows: true })),
  );
  s.runner.do(s.world, s.script);
  assert.throws(() => s.script.stop(), /stop failed/);
  assert.equal(s.log.at(-1), 'release:shot');
});

test('long immediate sequences yield to the frame loop without losing steps', () => {
  const s = setup(
    sequence(Array.from({ length: 200 }, (_, id) => action({ id }))),
  );
  s.runner.do(s.world, s.script);
  assert.deepEqual(s.outcomes, []);

  for (let i = 0; i < 10 && !s.outcomes.length; i++) {
    s.runner.update(s.world, 1 / 30);
  }

  assert.equal(s.acts.length, 200);
  assert.deepEqual(s.outcomes, ['done']);
  assert.equal(s.log.filter((entry) => entry.startsWith('stop:')).length, 200);
});

test('cancellation also closes nested generator resource scopes', () => {
  const log = [];
  class Waiting extends Action {
    perform() {
      return running;
    }

    stop() {
      log.push('stop');
    }
  }

  function* child() {
    try {
      return yield new Waiting();
    } finally {
      log.push('child');
    }
  }

  const script = new Sequence(function* () {
    try {
      return yield* child();
    } finally {
      log.push('parent');
    }
  });
  script.perform({}, 0);
  script.stop();
  assert.deepEqual(log, ['stop', 'child', 'parent']);
});

test('a stop condition closes only its branch before advancing the parent', () => {
  const s = setup(
    holding(
      ['attention'],
      sequence([
        until(1, holding(['shot'], action({ id: 'walk', seconds: 10 }))),
        action({ id: 'next', seconds: 2 }),
      ]),
    ),
  );
  s.runner.do(s.world, s.script);
  s.runner.update(s.world, 1);
  assert.deepEqual(s.log.slice(-3), [
    'stop:walk',
    'release:shot',
    'scene:next:0',
  ]);
  assert.ok(!s.log.includes('release:attention'));
  s.runner.update(s.world, 2);
  assert.deepEqual(s.log.slice(-2), ['stop:next', 'release:attention']);
  assert.deepEqual(s.outcomes, ['done']);
});

test('cancellation from child cleanup does not stop the child twice or start the next step', () => {
  const s = setup(
    holding(
      ['shot'],
      sequence([
        action({ id: 'cancel', cancelOnStop: true }),
        action({ id: 'never' }),
      ]),
    ),
  );
  assert.deepEqual(s.runner.do(s.world, s.script), fail('cancelled'));
  assert.deepEqual(s.log, [
    'hold:shot',
    'scene:cancel:0',
    'stop:cancel',
    'release:shot',
  ]);
});

test('repeated completion polls neither resume the generator nor repeat cleanup', () => {
  const s = setup(holding(['shot'], action({ id: 'once' })));
  assert.deepEqual(s.script.perform(s.world, 0), done);
  s.script.stop();
  assert.deepEqual(s.script.perform(s.world, 1), done);
  assert.deepEqual(s.log, [
    'hold:shot',
    'scene:once:0',
    'stop:once',
    'release:shot',
  ]);
});
