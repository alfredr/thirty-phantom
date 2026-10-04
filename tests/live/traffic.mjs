// Traffic on the city loops. Each case runs in the page (see tools/scenarios.mjs).

/** A car stopped in a lane holds traffic up; the driver behind honks and pulls round it. */
export function pullsRoundBlockedLane() {
  const g = window.__game;
  const sim = window.__sim;
  g.start();
  sim.run(300);
  const blocker = g.vehicles.find((v) => v.role === 'traffic' && Math.abs(v.speed) > 3);
  if (!blocker) return { ok: false, why: 'no moving traffic' };
  blocker.role = 'parked';
  blocker.vel.set(0, 0, 0);
  blocker.speed = 0;
  blocker.markRest();
  let honks = 0;
  g.events.on('honk', () => honks++);
  const started = sim.until(() => g.detours.count > 0, 60, []);
  const finished = sim.until(() => g.detours.count === 0, 60, g.vehicles.filter((v) => v.role === 'traffic' || v.role === 'visitor'));
  return { ok: honks > 0 && started.ok && finished.ok, honks, startSeconds: started.seconds, roundSeconds: finished.seconds, maxJump: finished.maxJump };
}
