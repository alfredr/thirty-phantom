import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadModules } from './modules.mjs';

const [{ Fade }, { GameClock }, { TUNING }] = await loadModules(
  '/src/fx/fade.ts',
  '/src/game/game-clock.ts',
  '/src/config.ts',
);

for (const [start, event, phase] of [
  [12, 'nightfall', 'night'],
  [22, 'sunrise', 'day'],
]) {
  test(`the fade skips to ${phase} once at the end of its dark hold`, () => {
    const clock = new GameClock();
    clock.hours = start;
    let skips = 0;
    const fade = new Fade({ down: 1.4, hold: 0.6, up: 1.6, dim: 0.04 }, () => {
      skips++;
      clock.skipToNextPhase();
    });
    assert.equal(fade.update(1), 1);
    assert.equal(fade.start(), true);
    assert.equal(fade.start(), false);
    assert.ok(Math.abs(fade.update(1.5) - 0.04) < 1e-10);
    assert.equal(clock.hours, start);
    fade.update(0.5);
    assert.equal(skips, 1);
    const events = clock.update(0.03 * TUNING.clock.secondsPerGameHour);
    assert.equal(events[event], true);
    assert.equal(clock.phase, phase);
    assert.equal(fade.update(1.6), 1);
    assert.equal(fade.active, false);
    fade.update(10);
    assert.equal(skips, 1);
  });
}

test('a long frame completes the fade and still invokes its operation exactly once', () => {
  let calls = 0;
  const fade = new Fade({ down: 1, hold: 1, up: 1, dim: 0 }, () => calls++);
  fade.start();
  assert.equal(fade.update(5), 1);
  assert.equal(calls, 1);
  assert.equal(fade.active, false);
  fade.update(5);
  assert.equal(calls, 1);
});
