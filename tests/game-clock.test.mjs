import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadModules } from './modules.mjs';

const [{ GameClock }, { TUNING }] = await loadModules('/src/game/game-clock.ts', '/src/config.ts');

const { sunrise, nightfall, secondsPerGameHour } = TUNING.clock;
const ahead = (from, to) => (((to - from) % 24) + 24) % 24;

function run(clock, seconds, dt, each) {
  const events = { nightfall: 0, sunrise: 0 };
  const n = Math.round(seconds / dt);
  for (let i = 1; i <= n; i++) {
    const ev = clock.update(dt);
    events.nightfall += ev.nightfall ? 1 : 0;
    events.sunrise += ev.sunrise ? 1 : 0;
    each?.(clock, i * dt);
  }

  return events;
}

test('a hold eases toward its limit and never reaches it, even over hours of play', () => {
  for (const [dt, rate] of [
    [1 / 60, 1],
    [0.05, TUNING.clock.fastForward],
    [5, TUNING.clock.fastForward],
  ]) {
    const clock = new GameClock();
    clock.hours = nightfall - 2;
    clock.rate = rate;
    clock.hold(nightfall);
    let closest = Infinity;
    const events = run(clock, 4 * 3600, dt, (c) => {
      const gap = ahead(c.hours, nightfall);
      assert.ok(gap > 0 && gap < 2.01, `dt ${dt}: the clock stays short of the limit (gap ${gap})`);
      closest = Math.min(closest, gap);
    });
    assert.equal(events.nightfall, 0, 'nightfall never fires while held at it');
    assert.equal(clock.phase, 'day');
    assert.ok(closest < 0.01, `the clock gets close (within ${closest} h)`);
    assert.equal(GameClock.format(clock.hours), '6:59 PM');
  }
});

test('a hold runs at normal speed until 30 game-minutes before the limit', () => {
  const clock = new GameClock();
  clock.hours = 12;
  clock.hold(15);
  run(clock, 2 * secondsPerGameHour, 1 / 60);
  assert.ok(Math.abs(clock.hours - 14) < 1e-6, `two normal hours elapsed (${clock.hours})`);
  assert.equal(clock.pace, 1);
  run(clock, 0.5 * secondsPerGameHour - 0.5, 1 / 60);
  assert.equal(clock.pace, 1, 'still outside the slow zone');
  run(clock, 1, 1 / 60);
  assert.ok(clock.pace < 1, 'inside the slow zone');
});

test('pace falls through the nudge thresholds within a few minutes of entering the slow zone', () => {
  const clock = new GameClock();
  clock.hours = 9.5;
  clock.hold(10);
  assert.equal(clock.pace, 1);
  const crossed = {};
  let last = 1;
  run(clock, 600, 1 / 30, (c, t) => {
    assert.ok(c.pace <= last + 1e-12, 'pace never rises');
    last = c.pace;

    for (const mark of [1, 0.25, 0.05]) {
      if (c.pace < mark && crossed[mark] === undefined) {
        crossed[mark] = t;
      }
    }
  });
  assert.ok(crossed[1] < 0.1, `below 1 at once (${crossed[1]} s)`);
  assert.ok(crossed[0.25] > 40 && crossed[0.25] < 90, `below 0.25 after about a minute (${crossed[0.25]} s)`);
  assert.ok(crossed[0.05] > 100 && crossed[0.05] < 180, `below 0.05 after about two minutes (${crossed[0.05]} s)`);
  clock.hold(null);
  assert.equal(clock.pace, 1, 'releasing the hold restores full pace');
});

test('a hold wraps past midnight', () => {
  const clock = new GameClock();
  clock.hours = 22.5;
  clock.hold(4.5);
  const events = run(clock, 3 * 3600, 1 / 30, (c) => {
    const gap = ahead(c.hours, 4.5);
    assert.ok(gap > 0 && gap <= 6.01, `short of 4:30 AM (gap ${gap})`);
  });
  assert.ok(clock.hours > 4.4 && clock.hours < 4.5, `eased in after midnight (${clock.hours})`);
  assert.equal(clock.day, 1, 'sunrise was never reached');
  assert.deepEqual(events, { nightfall: 0, sunrise: 0 });
});

test('a sweep emits nightfall once, lands on its hour and runs done once', () => {
  const clock = new GameClock();
  clock.hours = 18.5;
  clock.hold(18.9);
  clock.paused = true;
  let done = 0;
  clock.sweep(19, 3, () => done++);
  assert.equal(clock.sweeping, true);
  assert.equal(clock.pace, 1, 'pace reads 1 during a sweep');
  const events = run(clock, 4, 1 / 60, (c, t) => {
    if (t < 2.9) {
      assert.equal(c.sweeping, true);
    }
  });
  assert.deepEqual(events, { nightfall: 1, sunrise: 0 });
  assert.equal(done, 1);
  assert.equal(clock.sweeping, false);
  assert.equal(clock.hours, 19);
  assert.equal(clock.pace, 1, 'the sweep passed the hold limit, so the hold is gone');
});

test('a sweep across midnight emits sunrise once and starts the next day', () => {
  const clock = new GameClock();
  clock.hours = 22;
  let done = 0;
  let landed = null;
  clock.sweep(sunrise + 0.5, 2.5, () => {
    done++;
    landed = clock.hours;
  });
  const events = run(clock, 3, 1 / 60);
  assert.deepEqual(events, { nightfall: 0, sunrise: 1 });
  assert.equal(clock.day, 2);
  assert.equal(landed, sunrise + 0.5);
  assert.equal(done, 1);
});

test('a hold set below the current hour means tomorrow, and eases in after midnight', () => {
  const clock = new GameClock();
  clock.hours = 21;
  clock.hold(1);
  const events = run(clock, 3 * 3600, 0.05);
  assert.ok(clock.hours > 0.9 && clock.hours < 1, `just short of 1 AM (${clock.hours})`);
  assert.deepEqual(events, { nightfall: 0, sunrise: 0 });
});

test('a sweep through midnight into the morning emits each boundary once', () => {
  const clock = new GameClock();
  clock.hours = 18;
  const seen = [];
  clock.sweep(sunrise + 1, 3);

  for (let i = 0; i < 400; i++) {
    const ev = clock.update(1 / 60);
    if (ev.nightfall) {
      seen.push(['nightfall', clock.hours]);
    }

    if (ev.sunrise) {
      seen.push(['sunrise', clock.day]);
    }
  }

  assert.deepEqual(
    seen.map(([k]) => k),
    ['nightfall', 'sunrise'],
  );
  assert.equal(clock.day, 2);
});

test('cancelSweep, a new hold, or a new sweep stops a sweep where it is without its done', () => {
  for (const stop of [(c) => c.cancelSweep(), (c) => c.hold(23.5), (c) => c.sweep(c.hours, 0.001, () => {})]) {
    const clock = new GameClock();
    clock.hours = 18;
    let done = 0;
    clock.sweep(21, 3, () => done++);
    const events = run(clock, 2, 1 / 60);
    assert.equal(events.nightfall, 1, 'nightfall already emitted on the way');
    const at = clock.hours;
    assert.ok(at > nightfall && at < 21);
    stop(clock);
    const later = run(clock, 3, 1 / 60);
    assert.equal(clock.sweeping, false);
    assert.equal(done, 0, 'the cancelled sweep never runs done');
    assert.equal(later.nightfall, 0, 'and nothing is emitted twice');
    assert.ok(clock.hours < 21, 'the sweep did not finish');
  }
});

test('one long step can cross both boundaries, and each fires once', () => {
  const clock = new GameClock();
  clock.hours = 17;
  clock.sweep(9, 1);
  const ev = clock.update(2);
  assert.equal(ev.nightfall, true);
  assert.equal(ev.sunrise, true);
  assert.equal(clock.hours, 9);
  assert.equal(clock.day, 2);
});

test('a sweep that stops short of the hold keeps it, and holds and sweeps ignore phase skips', () => {
  const clock = new GameClock();
  clock.hours = 20;
  clock.hold(23);
  let landed = null;
  clock.sweep(21, 1, () => (landed = clock.hours));
  run(clock, 1.5, 1 / 60);
  assert.equal(landed, 21);
  const before = clock.hours;
  clock.skipToNextPhase();
  assert.equal(clock.hours, before, 'no skip during a hold');
  run(clock, 600, 1 / 30);
  assert.ok(clock.hours < 23 && clock.hours > 22.9, `still held short of 11 PM (${clock.hours})`);
  clock.hold(null);
  clock.skipToNextPhase();
  assert.equal(clock.hours, sunrise - 0.02);
});
