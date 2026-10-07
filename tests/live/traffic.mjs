// Traffic on the city loops. Each case runs in the page (see tools/scenarios.mjs).

/**
 * Verify that queued traffic honks and completes a detour around a stopped
 * car.
 */
export function pullsRoundBlockedLane() {
  const g = window.__game;
  const sim = window.__sim;
  g.start();
  sim.run(300);
  const blocker = g.vehicles.find(
    (v) => v.role === 'traffic' && Math.abs(v.speed) > 3,
  );
  if (!blocker) {
    return { ok: false, why: 'no moving traffic' };
  }

  blocker.role = 'parked';
  blocker.vel.set(0, 0, 0);
  blocker.speed = 0;
  blocker.markRest();
  let honks = 0;
  g.events.on('honk', () => honks++);
  const started = sim.until(() => g.detours.count > 0, 60, []);
  const finished = sim.until(
    () => g.detours.count === 0,
    60,
    g.vehicles.filter((v) => v.role === 'traffic' || v.role === 'visitor'),
  );
  return {
    ok: honks > 0 && started.ok && finished.ok,
    honks,
    startSeconds: started.seconds,
    roundSeconds: finished.seconds,
    maxJump: finished.maxJump,
  };
}

/**
 * Verify that boarding a detouring car cancels the detour and gives Cody the
 * seat.
 */
export function codyTakesAPullRound() {
  const g = window.__game;
  const sim = window.__sim;
  g.start();
  sim.run(300);
  const blocker = g.vehicles.find(
    (v) => v.role === 'traffic' && Math.abs(v.speed) > 3,
  );
  if (!blocker) {
    return { ok: false, why: 'no moving traffic' };
  }

  blocker.role = 'parked';
  blocker.vel.set(0, 0, 0);
  blocker.speed = 0;
  blocker.markRest();
  const started = sim.until(() => g.detours.count > 0, 60, []);
  const car = g.vehicles.find((v) => g.detours.has(v));
  if (!car) {
    return { ok: false, why: 'nobody pulled round', started: started.ok };
  }

  const held = g.claims.holder('driverSeat', car) !== null;
  g.board(car);
  sim.run(2);
  return {
    ok:
      held &&
      !g.detours.has(car) &&
      g.claims.holder('driverSeat', car) === g.cody &&
      car.role === 'player',
    held,
    mine: g.claims.holder('driverSeat', car) === g.cody,
  };
}
