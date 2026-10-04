// Valets driving cars into the deck. Each case runs in the page (see tools/scenarios.mjs).

/** A valet takes a car to a deck spot, parks it, and comes back to the stand. */
export function parksAndComesBack() {
  const g = window.__game;
  const sim = window.__sim;
  g.start();
  sim.run(120);
  const valet = g.valet.crew.find((v) => v.state === 'idle');
  if (!valet) return { ok: false, why: 'no idle valet' };
  const car = g.vehicles
    .filter((v) => v.role === 'parked' && !v.insideDeck)
    .sort((a, b) => a.pos.distanceTo(valet.walker.pos) - b.pos.distanceTo(valet.walker.pos))[0];
  const spot = g.garage.topFree();
  if (!car || !spot) return { ok: false, why: 'no car or no free spot' };
  g.valet.take(valet, car, spot);
  const parked = sim.until(() => car.role === 'parked' && spot.occupant === car, 150, [car]);
  const back = sim.until(() => valet.state === 'idle', 150, []);
  return { ok: parked.ok && back.ok && car.insideDeck, parkSeconds: parked.seconds, backSeconds: back.seconds, maxJump: Math.max(parked.maxJump, back.maxJump) };
}

/** Cody takes the car off a valet mid-drive: the drive's off, the spot's free again, and he walks back to the stand. */
export function carjackedMidDrive() {
  const g = window.__game;
  const sim = window.__sim;
  g.start();
  sim.run(120);
  const valet = g.valet.crew.find((v) => v.state === 'idle');
  if (!valet) return { ok: false, why: 'no idle valet' };
  const car = g.vehicles
    .filter((v) => v.role === 'parked' && !v.insideDeck)
    .sort((a, b) => a.pos.distanceTo(valet.walker.pos) - b.pos.distanceTo(valet.walker.pos))[0];
  const spot = g.garage.topFree();
  if (!car || !spot) return { ok: false, why: 'no car or no free spot' };
  g.valet.take(valet, car, spot);
  const driving = sim.until(() => valet.state === 'driving' && Math.abs(car.speed) > 2, 120, [car]);
  if (!driving.ok) return { ok: false, why: 'never drove off' };
  g.board(car);
  sim.run(5);
  const back = sim.until(() => valet.state === 'idle', 120, []);
  return {
    ok: car.role === 'player' && g.garage.isFree(spot) && back.ok,
    cody: car.role,
    spotFree: g.garage.isFree(spot),
    backSeconds: back.seconds,
  };
}
