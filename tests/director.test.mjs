import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadModules } from './modules.mjs';

const [{ Director, steps }] = await loadModules('/src/game/story/director.ts');
const { all, on } = steps();

test('parallel parts retire on completion while their siblings keep running', () => {
  const log = [];
  const scopes = [];
  const part = (name) => ({
    create(s) {
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
    },
  });
  const director = new Director({ both: { parts: [all([part('a'), part('b')])], next: null } }, {}, { prefix: 'test' });
  director.start('both');
  assert.notEqual(scopes[0].key, scopes[1].key, 'each branch owns its outreach');
  director.send({ type: 'a' });
  assert.equal(director.beat, 'both');
  director.tick(1);
  scopes[1].progress();
  director.send({ type: 'b' });
  assert.equal(director.beat, null);
  assert.deepEqual(log, ['a:a', 'a:stop', 'b:a', 'b:tick', 'b:progress', 'b:b', 'b:stop']);
});

test('leaving parallel parts cleans up once in reverse order and ignores late completion', () => {
  const log = [];
  const scopes = [];
  const parts = ['a', 'b'].map((name) => ({
    create(s) {
      scopes.push(s);
      return { stop: () => log.push(name) };
    },
  }));
  const director = new Director(
    { both: { parts: [all(parts), on('skip')], next: 'next' }, next: { parts: [], next: null } },
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
  const part = (name) => ({
    create(s) {
      log.push(`${name}:start`);
      s.done();
      return { stop: () => log.push(`${name}:stop`) };
    },
  });
  const director = new Director({ both: { parts: [all([part('a'), part('b')])], next: null } }, {}, { prefix: 'test' });
  director.start('both');
  assert.equal(director.beat, null);
  assert.deepEqual(log, ['a:start', 'a:stop', 'b:start', 'b:stop']);
});

test('an empty parallel group completes immediately', () => {
  const director = new Director({ empty: { parts: [all([])], next: null } }, {}, { prefix: 'test' });
  director.start('empty');
  assert.equal(director.beat, null);
});
