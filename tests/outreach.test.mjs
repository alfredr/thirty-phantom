import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadModules } from './modules.mjs';

const [{ OutreachQueue, OUTREACH_GAP, FLY_TIME }] = await loadModules('/src/ui/phone/outreach.ts');

function harness() {
  const log = [];
  const q = new OutreachQueue({
    show: (msg) => log.push(['show', msg]),
    hide: () => log.push(['hide']),
    fly: (msg) => log.push(['fly', msg]),
    land: (msg) => log.push(['land', msg]),
    ring: () => log.push(['ring']),
  });
  let quiet = false;
  const h = {
    q,
    log,
    set quiet(on) {
      quiet = on;
    },
    step(seconds, dt = 0.1) {
      for (let t = 0; t < seconds - 1e-9; t += dt) {
        q.update(dt, quiet);
      }
    },
    events: (kind) => log.filter(([k]) => k === kind).map(([, msg]) => msg),
  };
  return h;
}

function assertGaps(history) {
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1];
    assert.ok(prev.end !== null, 'outreaches never overlap');
    assert.ok(
      history[i].start - prev.end >= OUTREACH_GAP - 1e-6,
      `${history[i].kind} started ${history[i].start - prev.end} s after the previous ${prev.kind} ended`,
    );
  }
}

test('texts show one at a time in order, at least 30 s apart from landing to the next showing', () => {
  const h = harness();
  h.q.text('ONE');
  h.q.text('TWO');
  h.q.text('THREE');
  h.step(0.1);
  assert.deepEqual(h.events('show'), ['ONE'], 'the first shows at once');
  assert.equal(h.q.visible, true);
  assert.equal(h.q.awaitingKey, true);
  h.step(12);
  assert.deepEqual(h.events('show'), ['ONE'], 'the next waits for the acknowledgement');
  assert.equal(h.q.acknowledge(), true);
  assert.equal(h.q.visible, false, 'flying is not visible');
  h.step(FLY_TIME + 0.05);
  assert.deepEqual(h.events('land'), ['ONE']);
  h.step(OUTREACH_GAP - 1);
  assert.deepEqual(h.events('show'), ['ONE'], 'still inside the gap');
  h.step(1.2);
  assert.deepEqual(h.events('show'), ['ONE', 'TWO']);
  h.q.acknowledge();
  h.step(OUTREACH_GAP + 1);
  h.q.acknowledge();
  h.step(1);
  assert.deepEqual(h.events('land'), ['ONE', 'TWO', 'THREE']);
  assert.equal(h.q.pending, 0);
  assertGaps(h.q.history);
  assert.deepEqual(
    h.q.history.map((o) => o.kind),
    ['text', 'text', 'text'],
  );
});

test('quiet holds new pop-ups back and hides one already showing until it ends', () => {
  const h = harness();
  h.quiet = true;
  h.q.text('WAIT');
  h.step(40);
  assert.deepEqual(h.events('show'), [], 'nothing shows while quiet');
  h.quiet = false;
  h.step(0.1);
  assert.deepEqual(h.events('show'), ['WAIT']);
  h.quiet = true;
  h.step(0.1);
  assert.equal(h.q.visible, false);
  assert.equal(h.q.awaitingKey, false, 'a hidden pop-up gives the interact key back');
  assert.equal(h.q.acknowledge(), false, 'a hidden pop-up cannot be acknowledged');
  h.quiet = false;
  h.step(0.1);
  assert.deepEqual(h.events('show'), ['WAIT', 'WAIT'], 'it comes back after the quiet');
  assert.ok(h.q.acknowledge());
});

test('until acknowledges by doing, and lands silently when already done at the front', () => {
  const h = harness();
  let drove = false;
  let parked = false;
  const landed = [];
  h.q.text('DRIVE OFF', { until: () => drove, landed: () => landed.push('drive') });
  h.q.text('PARK IT', { until: () => parked, landed: () => landed.push('park') });
  h.step(1);
  assert.equal(h.q.awaitingKey, false, 'an action text never takes the interact key');
  assert.equal(h.q.acknowledge(), false, 'nor a tap');
  drove = true;
  parked = true;
  h.step(FLY_TIME + 0.2);
  assert.deepEqual(h.events('land'), ['DRIVE OFF', 'PARK IT'], 'the second was already done, so it lands at once');
  assert.deepEqual(h.events('show'), ['DRIVE OFF'], 'without a pop-up');
  assert.deepEqual(landed, ['drive', 'park']);
  assert.equal(h.q.history.length, 1, 'a silent landing is not an outreach');
});

test('brief texts land on their own after their time, which does not run while quiet', () => {
  const h = harness();
  const landed = [];
  h.q.text('HA! SOUL POWER.', { brief: 3, landed: () => landed.push(h.q.elapsed) });
  h.step(1);
  assert.equal(h.q.awaitingKey, false, 'brief texts do not take the interact key');
  h.quiet = true;
  h.step(10);
  h.quiet = false;
  h.step(1.9);
  assert.deepEqual(h.events('fly'), []);
  h.step(0.2);
  assert.deepEqual(h.events('fly'), ['HA! SOUL POWER.']);
  h.step(FLY_TIME + 0.1);
  assert.equal(landed.length, 1);
  assert.ok(Math.abs(landed[0] - (13 + FLY_TIME)) < 0.25, `landed at ${landed[0]}`);
});

test('drop removes queued texts and calls by key and force-acknowledges the showing one', () => {
  const h = harness();
  const landed = [];
  let rang = 0;
  h.q.text('CAMS', { key: 'hint', landed: () => landed.push('cams') });
  h.q.text('GHOSTS', { key: 'hint', landed: () => landed.push('ghosts') });
  h.q.queueCall(() => rang++, { key: 'hint' });
  h.q.text('KEEP', { landed: () => landed.push('keep') });
  h.step(0.1);
  h.q.drop('hint');
  h.step(FLY_TIME + 0.1);
  assert.deepEqual(h.events('land'), ['CAMS']);
  assert.deepEqual(landed, ['cams'], 'the showing text lands; never-shown ones are just dropped');
  h.step(OUTREACH_GAP + 1);
  assert.deepEqual(h.events('show'), ['CAMS', 'KEEP']);
  assert.equal(rang, 0);
});

test('landed fires exactly once on every landing path', () => {
  const h = harness();
  const count = {};
  const landed = (name) => () => (count[name] = (count[name] ?? 0) + 1);
  let done = false;
  h.q.text('KEY', { landed: landed('key') });
  h.q.text('TAP', { landed: landed('tap') });
  h.q.text('UNTIL', { until: () => done, landed: landed('until') });
  h.q.text('BRIEF', { brief: 2, landed: landed('brief') });
  h.q.text('DROP', { key: 'x', landed: landed('drop') });
  h.step(0.1);
  h.q.acknowledge();
  h.q.acknowledge();
  h.step(OUTREACH_GAP + 1);
  h.q.acknowledge();
  h.step(OUTREACH_GAP + 1);
  done = true;
  h.step(OUTREACH_GAP + 1);
  h.step(OUTREACH_GAP + 3);
  h.q.drop('x');
  h.q.drop('x');
  h.step(5);
  h.q.text('SILENT', { until: () => true, landed: landed('silent') });
  h.step(1);
  assert.deepEqual(count, { key: 1, tap: 1, until: 1, brief: 1, drop: 1, silent: 1 });
  assertGaps(h.q.history);
});

test('calls share the 30 s gap with texts, wait their turn, and end on endCall', () => {
  const h = harness();
  let started = 0;
  h.q.text('FIRST');
  h.q.queueCall(() => started++);
  h.q.text('AFTER THE CALL');
  h.step(5);
  h.q.acknowledge();
  h.step(FLY_TIME + 0.1);
  h.step(OUTREACH_GAP - 2);
  assert.equal(started, 0, 'the call waits out the gap');
  h.quiet = true;
  h.step(5);
  assert.equal(started, 0, 'and the quiet');
  h.quiet = false;
  h.step(0.1);
  assert.equal(started, 1);
  assert.equal(h.events('ring').length, 1, 'it rings when it starts');
  assert.equal(h.q.calling, true);
  h.step(60);
  assert.deepEqual(h.events('show'), ['FIRST'], 'texts wait while the call is on');
  h.q.endCall();
  assert.equal(h.q.calling, false);
  h.step(OUTREACH_GAP - 0.5);
  assert.deepEqual(h.events('show'), ['FIRST']);
  h.step(1);
  assert.deepEqual(h.events('show'), ['FIRST', 'AFTER THE CALL']);
  assert.deepEqual(
    h.q.history.map((o) => o.kind),
    ['text', 'call', 'text'],
  );
  assertGaps(h.q.history);
});

test('a first call rings at once, and later outreaches wait for it to end', () => {
  const h = harness();
  let started = 0;
  h.q.queueCall(() => started++);
  h.q.text('LATER');
  h.step(0.1);
  assert.equal(started, 1, 'nothing came before, so there is no gap to wait out');
  h.step(40);
  assert.deepEqual(h.events('show'), []);
  h.q.endCall();
  h.step(OUTREACH_GAP + 0.2);
  assert.deepEqual(h.events('show'), ['LATER']);
  assertGaps(h.q.history);
});

test('dropping a beat prefix cancels its stale texts, calls and nudges but not other beats', () => {
  const h = harness();
  const landed = [];
  let rang = 0;
  h.q.text('RAMP HINT', { key: 'beat:ramp', landed: () => landed.push('hint') });
  h.q.text('RAMP NUDGE 1', { key: 'beat:ramp:nudge1', landed: () => landed.push('nudge1') });
  h.q.queueCall(() => rang++, { key: 'beat:ramp:call' });
  h.q.text('RAMPAGE', { key: 'beat:rampage', landed: () => landed.push('rampage') });
  h.q.text('CAMERA', { key: 'beat:camera', landed: () => landed.push('camera') });
  h.step(0.1);
  assert.deepEqual(h.events('show'), ['RAMP HINT']);
  h.q.drop('beat:ramp:');
  h.q.drop('beat:ramp');
  h.step(FLY_TIME + 0.1);
  h.step(OUTREACH_GAP + 0.5);
  h.q.acknowledge();
  h.step(OUTREACH_GAP + 1);
  assert.equal(rang, 0, 'the dropped call never rings');
  assert.deepEqual(h.events('show'), ['RAMP HINT', 'CAMERA'], 'prefix drop takes beat:ramp and beat:rampage alike');
  assert.deepEqual(landed, ['hint', 'camera']);
  assert.equal(h.q.pending, 0);
});

test('a hint whose action is done before it reaches the front never shows', () => {
  const h = harness();
  let boosted = false;
  h.q.text('INFO');
  h.q.text('HOLD {boost} TO BURN IT', { until: () => boosted, key: 'beat:boost' });
  h.step(1);
  boosted = true;
  h.q.acknowledge();
  h.step(FLY_TIME + OUTREACH_GAP + 1);
  assert.deepEqual(h.events('show'), ['INFO']);
  assert.deepEqual(h.events('land'), ['INFO', 'HOLD {boost} TO BURN IT']);
});

test('mixed texts and calls never come within 30 s of each other', () => {
  const h = harness();
  const calls = [];
  for (let i = 0; i < 4; i++) {
    h.q.text(`T${i}`, { brief: 1 + i });
    h.q.queueCall(() => calls.push(h.q.elapsed));
  }

  let quietFor = 0;
  for (let t = 0; t < 600; t += 0.05) {
    if (h.q.calling && h.q.elapsed - (calls.at(-1) ?? 0) > 7) {
      h.q.endCall();
    }

    if (h.q.awaitingKey) {
      h.q.acknowledge();
    }

    quietFor = Math.max(0, quietFor - 0.05);

    if (Math.floor(t) % 47 === 0) {
      quietFor = 3;
    }

    h.quiet = quietFor > 0;
    h.q.update(0.05, quietFor > 0);
  }

  assert.equal(h.q.pending, 0);
  assert.equal(h.q.history.length, 8);
  assertGaps(h.q.history);
});

test('a reply skips the 30 s gap and jumps the queue, and only replies may break the gap', () => {
  const h = harness();
  h.q.queueCall(() => undefined, { key: 'call' });
  h.step(0.1);
  h.q.endCall();
  h.q.text('LATER');
  h.step(1);
  h.q.text('SORRY', { reply: true });
  h.step(0.2);
  assert.deepEqual(h.events('show'), ['SORRY'], 'the reply shows at once, ahead of the waiting text');
  h.q.acknowledge();
  h.step(FLY_TIME + 0.05);
  h.step(OUTREACH_GAP + 1);
  assert.deepEqual(h.events('show'), ['SORRY', 'LATER'], 'the waiting text still keeps its gap');
  const history = h.q.history;
  assert.deepEqual(
    history.map((o) => o.reply),
    [false, true, false],
  );
  assertGaps(history.filter((o) => !o.reply));
});
