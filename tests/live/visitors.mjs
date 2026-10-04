// Townsfolk who drive into the lots and out again. Each case runs in the page (see tools/scenarios.mjs).

/** Someone turns up by car out of sight, drives to a free stall, parks, and gets out to join the crowd. */
export function arrivesParksAndGetsOut() {
  const g = window.__game;
  const sim = window.__sim;
  g.start();
  sim.run(60);
  const bay = g.visitors.bays.find((b) => g.visitors.isFree(b));
  if (!bay) return { ok: false, why: 'no free stall' };
  const before = new Set(g.vehicles);
  const people = g.crowd.living().length;
  if (!g.visitors.send(bay.center)) return { ok: false, why: 'nowhere to send one from' };
  let car = null;
  const turnedUp = sim.until(() => (car = g.vehicles.find((v) => !before.has(v) && v.role === 'visitor') ?? null) !== null, 30, []);
  if (!car) return { ok: false, why: 'no car turned up', seconds: turnedUp.seconds };
  const parked = sim.until(() => car.role === 'parked', 120, [car]);
  const inStall = g.visitors.bays.some((b) => Math.hypot(car.pos.x - b.center.x, car.pos.z - b.center.z) < 1);
  return {
    ok: parked.ok && inStall && g.crowd.living().length > people,
    secondsToTurnUp: turnedUp.seconds,
    secondsToPark: parked.seconds,
    inStall,
    gotOut: g.crowd.living().length > people,
    maxJump: parked.maxJump,
  };
}

/** A visitor back at their car in a stall backs out, drives to a lane, and joins the traffic. */
export function leavesAndJoinsTraffic() {
  const g = window.__game;
  const sim = window.__sim;
  g.start();
  sim.run(60);
  const car = g.vehicles.find((v) => g.visitors.waiting(v));
  if (!car) return { ok: false, why: 'no car waiting in a stall' };
  if (!g.visitors.leave(car)) return { ok: false, why: 'nowhere to go' };
  const joined = sim.until(() => car.role === 'traffic', 90, [car]);
  sim.run(60);
  return { ok: joined.ok && car.role === 'traffic', seconds: joined.seconds, role: car.role, maxJump: joined.maxJump };
}
