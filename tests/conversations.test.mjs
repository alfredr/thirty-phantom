import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Vector3 } from 'three';

import { loadModules } from './modules.mjs';

const [{ Focus }, { KEYS }, { Leases }, { RandyTalk }, { ValetTalk }] = await loadModules(
  '/src/engine/input/input.ts',
  '/src/game/controls.ts',
  '/src/engine/sim/leases.ts',
  '/src/game/randy/talk.ts',
  '/src/game/valets/talk.ts',
);

function randyTalk(tires = 1) {
  const focus = new Focus(KEYS);
  const randy = { pos: new Vector3(), breed: { name: 'RANDY' }, attention: new Leases() };
  const talk = new RandyTalk(focus, {}, { tires: () => tires, give: () => true });
  return { focus, randy, talk };
}

for (const close of ['explicit', 'distance', 'timeout', 'last line']) {
  test(`Randy's conversation releases focus and attention on ${close}`, () => {
    const { focus, randy, talk } = randyTalk(close === 'last line' ? 0 : 1);
    const outside = { face: new Vector3(1, 0, 0) };
    const releaseOutside = randy.attention.take(outside);
    talk.start(randy);
    assert.notEqual(randy.attention.top, outside);
    assert.equal(focus.owns('interact'), close !== 'last line');

    if (close === 'explicit') {
      talk.close();
    } else {
      talk.update(close === 'timeout' ? 13 : 3, new Vector3(close === 'distance' ? 10 : 0, 0, 0));
    }

    assert.equal(talk.active, false);
    assert.equal(focus.owns('interact'), false);
    assert.equal(randy.attention.top, outside);
    talk.close();
    assert.equal(randy.attention.top, outside);
    releaseOutside();
  });
}

test('replacing a conversation releases the old session without releasing a newer scene', () => {
  const { focus, randy, talk } = randyTalk();
  talk.start(randy);
  const scene = { face: new Vector3(5, 0, 0) };
  const shot = randy.attention.take(scene);
  talk.start(randy);
  talk.close();
  assert.equal(randy.attention.top, scene);
  assert.equal(focus.owns('interact'), false);
  shot();
  assert.equal(randy.attention.top, null, 'expired conversation attention must not return');
});

test('failed focus acquisition releases conversation attention', () => {
  const { focus, randy, talk } = randyTalk();
  focus.add = () => {
    throw new Error('focus failed');
  };

  assert.throws(() => talk.start(randy), /focus failed/);
  assert.equal(talk.active, false);
  assert.equal(randy.attention.top, null);
});

test('reopening a valet conversation ends its previous attention before acquiring the next', () => {
  const focus = new Focus(KEYS);
  const events = [];
  const valet = { walker: { pos: new Vector3() }, state: 'idle', send: (e) => events.push(e.type) };
  const talk = new ValetTalk({ setPrompt() {} }, {}, {}, {}, focus, { me: () => new Vector3(), onShift: () => false });
  talk.start(valet);
  talk.start(valet);
  assert.deepEqual(events, ['talk', 'talkEnded', 'talk']);
  talk.update(0, new Vector3());
  assert.deepEqual(events, ['talk', 'talkEnded', 'talk', 'talkEnded']);
  assert.equal(focus.owns('interact'), false);
});
