// Townsfolk on foot. Each case runs in the page (see tools/scenarios.mjs).

/** Someone strolling takes fright: they run from it, get well away, and calm down to stroll again. */
export function runsFromAFrightThenCalmsDown() {
  const g = window.__game;
  const sim = window.__sim;
  g.start();
  sim.run(600);
  const p = g.crowd.living().find((q) => q.mind.state.at === 'pause' || q.mind.state.at === 'stroll');
  if (!p) {
    return { ok: false, why: 'nobody about', count: g.crowd.count };
  }

  const from = p.walker.pos.clone().add({ x: 2, y: 0, z: 0 });
  g.crowd.frighten(p, from);
  const ran = p.mind.state.at === 'flee';
  sim.run(60);
  const away = p.walker.pos.distanceTo(from);
  const calm = sim.until(() => p.mind.state.at === 'pause' || p.mind.state.at === 'stroll', 40, []);
  return { ok: ran && away > 4 && calm.ok, ran, away: +away.toFixed(1), calmAfter: calm.seconds };
}

/** Someone knocked off their feet lies there a while, then gets up limping and runs from what hit them. */
export function knockedDownGetsUpAndRuns() {
  const g = window.__game;
  const sim = window.__sim;
  g.start();
  sim.run(600);
  const p = g.crowd.living()[0];
  if (!p) {
    return { ok: false, why: 'nobody about' };
  }

  const from = p.walker.pos.clone().add({ x: -2, y: 0, z: 0 });
  p.mind.send({ type: 'felled', from, vx: 4, vz: 0, harm: 'injured' });
  const down = p.mind.state.at === 'down' && !!p.hurt;
  const up = sim.until(() => p.mind.state.at !== 'down', 30, []);
  return {
    ok: down && up.ok && p.mind.state.at === 'flee' && p.limp < 1,
    down,
    upAfter: up.seconds,
    then: p.mind.state.at,
    limp: p.limp,
  };
}

/** Nine skeletons raised next to one person with nobody else about: no more than three go after them. */
export function atMostThreeSkeletonsOnOnePerson() {
  const g = window.__game;
  const sim = window.__sim;
  g.start();
  sim.run(600);
  g.debug.night();
  sim.until(() => g.player.form === 'night', 20, []);
  const me = g.player.pos;
  const [victim, ...rest] = g.crowd.living();
  if (!victim) {
    return { ok: false, why: 'nobody about' };
  }

  // everyone else far off, the one left a few metres away
  for (const p of rest) {
    p.walker.place(me.clone().add({ x: 400, y: 0, z: 400 }), 0);
  }

  victim.walker.place(me.clone().add({ x: 5, y: 0, z: 0 }), 0);
  let raised = 0;
  for (let k = 0; k < 3; k++) {
    raised += g.summon();
    sim.run(130);
  }

  const hunters = g.skeletons.list.filter((s) => s.target === victim).length;
  const claims = g.claims.holders('quarry', victim).length;
  return { ok: raised === 9 && hunters > 0 && hunters <= 3 && claims === hunters, raised, hunters, claims };
}
