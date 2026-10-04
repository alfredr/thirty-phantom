// Randy at his fire: his pitch, his shop, and the tire trade. Each case runs in the page (see tools/scenarios.mjs).

/** Cody walks up to Randy on foot. Returns Randy, with Cody standing `meters` in front of him. */
const standBy = (meters) => {
  const g = window.__game;
  const sim = window.__sim;
  g.start();
  sim.run(30);
  const r = g.npcs.find('randy');
  if (!r) return null;
  const P = g.player.pos.constructor;
  g.player.place(new P(r.pos.x + Math.sin(r.homeYaw) * meters, r.pos.y, r.pos.z + Math.cos(r.homeYaw) * meters), r.homeYaw + Math.PI);
  return r;
};

/** Close by, Randy pitches; while Cody browses his wares the coat stays open past a pitch's length; when Cody walks off, it shuts. */
export function keepsHisCoatOpenWhileCodyBrowses() {
  const g = window.__game;
  const sim = window.__sim;
  const r = sim.standBy(2);
  if (!r) return { ok: false, why: 'no Randy' };
  const pitched = sim.until(() => r.pitch.state.at === 'browsing', 15, []);
  sim.run(30 * 6);
  const stillOpen = r.pitch.state.at === 'browsing' && r.pitching;
  const P = g.player.pos.constructor;
  g.player.place(new P(r.pos.x + 12, r.pos.y, r.pos.z), 0);
  sim.run(10);
  return { ok: pitched.ok && stillOpen && !r.pitching, browsedAfter: pitched.seconds, stillOpenAfter6s: stillOpen, shutWhenGone: !r.pitching };
}

/** Given tires, Randy pays the brisket there and then, takes no more while they burn, and goes back to roasting. */
export function paysForTiresAtOnceThenBurnsThem() {
  const g = window.__game;
  const sim = window.__sim;
  const r = sim.standBy(1.5);
  if (!r) return { ok: false, why: 'no Randy' };
  g.inventory.add('tire', 2);
  const before = g.inventory.count('brisket');
  const taker = g.tires.taker(g.player.pos);
  const gave = taker ? g.tires.give(taker, g.player.pos) : 0;
  const paidAtOnce = g.inventory.count('brisket') - before;
  const busy = r.work.state.at === 'feeding' && g.tires.taker(g.player.pos) === null;
  const done = sim.until(() => r.work.state.at === 'roasting', 5, []);
  return { ok: gave === 2 && paidAtOnce === 2 && busy && done.ok && g.tires.taker(g.player.pos) === r, gave, paidAtOnce, busyWhileBurning: busy, backToRoastingAfter: done.seconds };
}

/** A scene holds Randy: no pitching of his own with Cody close; the coat opens and shuts as the scene says; released, he's back to his routine. */
export function aSceneDirectsHim() {
  const g = window.__game;
  const sim = window.__sim;
  const r = sim.standBy(2);
  if (!r) return { ok: false, why: 'no Randy' };
  r.send({ type: 'held', face: null });
  sim.run(30 * 6);
  const quiet = !r.pitching;
  r.send({ type: 'flash', open: true });
  sim.run(5);
  const flashed = r.pitching;
  r.send({ type: 'released' });
  const back = sim.until(() => r.pitching, 10, []);
  return { ok: quiet && flashed && back.ok, quietWhileHeld: quiet, flashedOnCue: flashed, pitchingAgainAfter: back.seconds };
}

/** Cody walks up to Randy carrying tires and presses F: they talk, F again gives him the tires (paid there and then), and when the talk's over Randy's back to his routine. */
export function talkToGiveHimTires() {
  const g = window.__game;
  const sim = window.__sim;
  const r = sim.standBy(1.5);
  if (!r) return { ok: false, why: 'no Randy' };
  g.inventory.add('tire', 2);
  const brisket = g.inventory.count('brisket');
  sim.run(2);
  g.input.press('KeyF');
  sim.run(2);
  const talking = g.randyTalk.active && r.held;
  const bubble = document.querySelector('.hud-bubble')?.textContent ?? '';
  g.input.press('KeyF');
  sim.run(2);
  const gave = g.inventory.count('tire') === 0 && g.inventory.count('brisket') === brisket + 2;
  const over = sim.until(() => !g.randyTalk.active, 6, []);
  return {
    ok: talking && /GIVE 2 TIRES/.test(bubble) && gave && over.ok && !r.held,
    talking,
    offered: /GIVE 2 TIRES/.test(bubble),
    gave,
    talkOverAfter: over.seconds,
    released: !r.held,
  };
}

/** With tires on him, Cody's shown where Randy is (the tire deal); once they're handed over, the marker's gone. */
export function tiresPutRandyOnTheMap() {
  const g = window.__game;
  const sim = window.__sim;
  const r = sim.standBy(1.5);
  if (!r) return { ok: false, why: 'no Randy' };
  const marked = () => g.objectives.has('tires-randy');
  sim.run(2);
  const before = marked();
  g.inventory.add('tire', 1);
  sim.run(2);
  const carrying = marked() && g.quests.steps().tires === 'bring';
  g.input.press('KeyF');
  sim.run(2);
  g.input.press('KeyF');
  sim.run(2);
  const after = marked();
  return { ok: !before && carrying && !after && g.inventory.count('tire') === 0, before, carrying, after };
}

/** While the tutorial runs, F by Randy doesn't start a talk of its own. */
export function noTalkDuringTheTutorial() {
  const g = window.__game;
  const sim = window.__sim;
  const r = sim.standBy(1.5);
  if (!r) return { ok: false, why: 'no Randy' };
  g.inventory.add('tire', 1);
  g.randyTalk.enabled = false;
  sim.run(2);
  g.input.press('KeyF');
  sim.run(2);
  return { ok: !g.randyTalk.active && !r.held && g.inventory.count('tire') === 1, talking: g.randyTalk.active };
}

/** Steps shared by this set's cases, installed on window.__sim before each one. */
export const steps = { standBy };
