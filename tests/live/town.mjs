// Townsfolk on foot. Each case runs in the page (see tools/scenarios.mjs).

/** Someone strolling takes fright: they run from it, get well away, and calm down to stroll again. */
export function runsFromAFrightThenCalmsDown() {
  const g = window.__game;
  const sim = window.__sim;
  g.start();
  sim.run(600);
  const p = g.crowd.living().find((q) => q.mind.state.at === 'pause' || q.mind.state.at === 'stroll');
  if (!p) return { ok: false, why: 'nobody about', count: g.crowd.count };
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
  if (!p) return { ok: false, why: 'nobody about' };
  const from = p.walker.pos.clone().add({ x: -2, y: 0, z: 0 });
  p.mind.send({ type: 'felled', from, vx: 4, vz: 0, harm: 'injured' });
  const down = p.mind.state.at === 'down' && !!p.hurt;
  const up = sim.until(() => p.mind.state.at !== 'down', 30, []);
  return { ok: down && up.ok && p.mind.state.at === 'flee' && p.limp < 1, down, upAfter: up.seconds, then: p.mind.state.at, limp: p.limp };
}
