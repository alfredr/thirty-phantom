import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';

import { loadModules } from './modules.mjs';

const [{ Mixer }, { CUES }] = await loadModules(
  '/src/audio/mixer.ts',
  '/src/audio/cues.ts',
);
const source = CUES.engine.sounds['engine-sedan'];

test('invalid engine metadata skips playback and is not fetched again', async (t) => {
  const invalid = [
    ['null root', null],
    ['missing marks', {}],
    ['null marks', { marks: null }],
    ['non-array marks', { marks: {} }],
    ['null cycle', { marks: [null] }],
    ['incomplete cycle', { marks: [[0, 60, 1]] }],
    ['non-numeric cycle', { marks: [[0, '60', 1, 0.5]] }],
  ];

  for (const [name, payload] of invalid) {
    await t.test(name, async (t) => {
      const fetch = t.mock.method(globalThis, 'fetch', async () => ({
        ok: true,
        json: async () => payload,
      }));
      const warn = t.mock.method(console, 'warn', () => {});
      const mixer = new Mixer();
      const ctx = {
        currentTime: 0,
        createGain: () => ({ gain: {} }),
        createStereoPanner: () => ({ pan: {} }),
      };
      mixer.ctx = ctx;
      mixer.kit = { ctx };
      mixer.buses = {};
      mixer.files.set(source.file, { state: 'ready', value: {} });

      assert.equal(
        mixer.loop('engine', 'engine-sedan', null),
        null,
        'skip playback while metadata loads',
      );
      await setImmediate();

      for (let attempt = 0; attempt < 2; attempt++) {
        assert.equal(
          mixer.loop('engine', 'engine-sedan', null),
          null,
          'skip playback after validation fails',
        );
      }

      assert.deepEqual(mixer.marks.get(source.marks), { state: 'failed' });
      assert.equal(fetch.mock.callCount(), 1);
      assert.equal(warn.mock.callCount(), 1);
    });
  }
});

test('engine metadata is fetched once and cached, including an empty cycle list', async (t) => {
  for (const marks of [
    [],
    [
      [0, 60, 1, 0.5],
      [0.02, 62, 0.5, 0.4],
    ],
  ]) {
    await t.test(`${marks.length} cycles`, async (t) => {
      const fetch = t.mock.method(globalThis, 'fetch', async () => ({
        ok: true,
        json: async () => ({ marks }),
      }));
      const mixer = new Mixer();
      mixer.loadMarks(source.marks);
      mixer.loadMarks(source.marks);
      assert.deepEqual(mixer.marks.get(source.marks), { state: 'loading' });
      await setImmediate();

      assert.deepEqual(mixer.marks.get(source.marks), {
        state: 'ready',
        value: marks,
      });
      mixer.loadMarks(source.marks);
      assert.equal(fetch.mock.callCount(), 1);
    });
  }
});
