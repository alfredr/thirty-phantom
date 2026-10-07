import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadModules } from './modules.mjs';

const [{ OutreachQueue, OUTREACH_GAP }, { Outreach, nudge, call }, { Director }, { on }] = await loadModules(
  '/src/ui/phone/outreach.ts',
  '/src/game/story/story-outreach.ts',
  '/src/game/story/director.ts',
  '/src/game/story/behaviors.ts',
);

function harness() {
  const spoken = [];
  let done = null;
  const queue = new OutreachQueue({ show() {}, hide() {}, fly() {}, land() {}, ring() {} });
  const phone = {
    text: (msg, opts) => queue.text(msg, opts),
    drop: (key) => queue.drop(key),
    queueCall: (start, opts) => queue.queueCall(start, opts),
    endCall: () => queue.endCall(),
    get calling() {
      return queue.calling;
    },
    get popupVisible() {
      return queue.visible;
    },
  };
  const outreach = new Outreach(
    phone,
    {
      get open() {
        return done !== null;
      },
      play(lines, finish) {
        spoken.push(lines.map((l) => l.say));
        done = finish;
      },
      cancel() {
        done = null;
      },
    },
    { show() {} },
    { left: 'RANDY', right: 'CODY' },
    () => 0.1,
    { add() {} },
    { ring() {}, answered() {} },
  );
  return {
    queue,
    outreach,
    spoken,
    step(dt) {
      queue.update(dt, false);
      outreach.tick(dt);
    },
    finish() {
      const finish = done;
      done = null;
      finish?.();
    },
  };
}

for (const state of ['queued', 'ringing', 'talking']) {
  for (const cleanup of ['progressed', 'stop']) {
    test(`${cleanup} cancels a ${state} nudge without leaving a stale call`, () => {
      const h = harness();
      const active = nudge('HOTWIRE THAT PICKUP')({ key: 'beat:hotwire', idle: 31 }, h);
      active.tick(0.1);
      active.tick(0.1);

      if (state !== 'queued') {
        h.step(0.1);
        h.queue.acknowledge();
        h.step(0.6);
        h.queue.update(OUTREACH_GAP, false);
        assert.equal(h.queue.calling, true);
      }

      if (state === 'talking') {
        h.outreach.answer();
        assert.equal(h.outreach.free, false);
      }

      const spoken = h.spoken.length;
      active[cleanup]();
      h.step(60);
      assert.equal(h.queue.calling, false);
      assert.equal(h.queue.pending, 0);
      assert.equal(h.outreach.free, true);
      assert.equal(h.spoken.length, spoken, 'the cancelled nudge never starts speaking later');
    });
  }
}

test('a new beat call waits for the outreach gap after cancelling an old nudge', () => {
  const h = harness();
  const director = new Director(
    {
      hotwire: { parts: [nudge('HOTWIRE THAT PICKUP'), on('hotwired')], next: 'drive' },
      drive: { parts: [call([{ who: 'left', say: 'DRIVE OFF.' }])], next: null },
    },
    h,
    { prefix: 'beat' },
  );
  director.start('hotwire');
  director.tick(31);
  director.tick(0.1);
  h.step(0.1);
  h.queue.acknowledge();
  h.step(0.6);
  h.queue.update(OUTREACH_GAP, false);
  assert.equal(h.queue.calling, true);
  director.send({ type: 'hotwired' });
  assert.equal(h.queue.calling, false);
  h.step(OUTREACH_GAP - 1);
  assert.deepEqual(h.spoken, []);
  h.queue.update(1, false);
  assert.equal(h.queue.calling, true);
  h.outreach.answer();
  assert.deepEqual(h.spoken, [['DRIVE OFF.']]);
  h.finish();
  assert.equal(director.beat, null);
});

test('a completed call can remain open across beats for its continuation', () => {
  const h = harness();
  const director = new Director(
    {
      first: { parts: [call([{ who: 'left', say: 'TAKE A LOOK.' }], { keep: true })], next: 'second' },
      second: { parts: [call([{ who: 'left', say: "TRUCK'S YOURS TONIGHT." }])], next: null },
    },
    h,
    { prefix: 'beat' },
  );
  director.start('first');
  h.step(0.1);
  h.outreach.answer();
  h.finish();
  assert.equal(director.beat, 'second');
  h.step(0.1);
  assert.equal(h.queue.calling, true);
  assert.deepEqual(h.spoken, [['TAKE A LOOK.'], ["TRUCK'S YOURS TONIGHT."]]);
  assert.equal(h.queue.history.length, 1, 'the continuation uses the existing call');
  h.finish();
  assert.equal(h.queue.calling, false);
  assert.equal(director.beat, null);
});
