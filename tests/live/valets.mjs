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

/** Cody pulls up by an idle valet and presses F: the talk opens and he stays in his car; F again (PARK IT) hands the car over and the valet goes for it. */
export function talkHandsOverTheCar() {
  const g = window.__game;
  const sim = window.__sim;
  g.start();
  sim.run(120);
  const valet = g.valet.crew.find((v) => v.state === 'idle');
  if (!valet) return { ok: false, why: 'no idle valet' };
  const car = g.vehicles.filter((v) => v.role === 'parked' && !v.insideDeck && v.form === 'car').sort((a, b) => a.pos.distanceTo(valet.walker.pos) - b.pos.distanceTo(valet.walker.pos))[0];
  if (!car) return { ok: false, why: 'no car' };
  g.board(car);
  const w = valet.walker.pos;
  car.place(w.x + 3, w.y, w.z, valet.homeYaw, 0, 0, null);
  car.vel.set(0, 0, 0);
  car.speed = 0;
  sim.run(3);
  g.input.press('KeyF');
  sim.run(2);
  const talking = valet.attention.state.at === 'facing';
  const stillDriving = g.vehicles.some((v) => v === car && v.role === 'player');
  g.input.press('KeyF');
  sim.run(3);
  const handed = valet.state === 'toCar' && car.role === 'valet';
  sim.run(90);
  return {
    ok: talking && stillDriving && handed && valet.attention.state.at === 'free',
    talking,
    stillDriving,
    handed,
    valet: valet.state,
    attention: valet.attention.state.at,
  };
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
