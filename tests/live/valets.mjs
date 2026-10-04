// Valets driving cars into the deck. Each case runs in the page (see tools/scenarios.mjs).

/** Verify that a valet parks the assigned car and returns to the stand. */
export function parksAndComesBack() {
  const g = window.__game;
  const sim = window.__sim;
  g.start();
  sim.run(120);
  const valet = g.valet.crew.find((v) => v.state === 'idle');
  if (!valet) {
    return { ok: false, why: 'no idle valet' };
  }

  const car = g.vehicles
    .filter((v) => v.role === 'parked' && !v.insideDeck)
    .sort((a, b) => a.pos.distanceTo(valet.walker.pos) - b.pos.distanceTo(valet.walker.pos))[0];
  const spot = g.garage.topFree();
  if (!car || !spot) {
    return { ok: false, why: 'no car or no free spot' };
  }

  car.ignition.transfer('away', valet.keys);
  g.valet.take(valet, car, spot);
  const parked = sim.until(() => car.role === 'parked' && spot.occupant === car, 150, [car]);
  const back = sim.until(() => valet.state === 'idle', 150, []);
  return {
    ok: parked.ok && back.ok && car.insideDeck,
    parkSeconds: parked.seconds,
    backSeconds: back.seconds,
    maxJump: Math.max(parked.maxJump, back.maxJump),
  };
}

/** Use the interact key from the car to open the valet conversation, then hand over the car and release attention. */
export function talkHandsOverTheCar() {
  const g = window.__game;
  const sim = window.__sim;
  g.start();
  sim.run(120);
  const valet = g.valet.crew.find((v) => v.state === 'idle');
  if (!valet) {
    return { ok: false, why: 'no idle valet' };
  }

  const car = g.vehicles
    .filter((v) => v.role === 'parked' && !v.insideDeck && v.form === 'car')
    .sort((a, b) => a.pos.distanceTo(valet.walker.pos) - b.pos.distanceTo(valet.walker.pos))[0];
  if (!car) {
    return { ok: false, why: 'no car' };
  }

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

/** Verify that boarding the valet’s car cancels the drive, frees the reserved spot, and returns the valet to the stand. */
export function carjackedMidDrive() {
  const g = window.__game;
  const sim = window.__sim;
  g.start();
  sim.run(120);
  const valet = g.valet.crew.find((v) => v.state === 'idle');
  if (!valet) {
    return { ok: false, why: 'no idle valet' };
  }

  const car = g.vehicles
    .filter((v) => v.role === 'parked' && !v.insideDeck)
    .sort((a, b) => a.pos.distanceTo(valet.walker.pos) - b.pos.distanceTo(valet.walker.pos))[0];
  const spot = g.garage.topFree();
  if (!car || !spot) {
    return { ok: false, why: 'no car or no free spot' };
  }

  car.ignition.transfer('away', valet.keys);
  g.valet.take(valet, car, spot);
  const driving = sim.until(() => valet.state === 'driving' && Math.abs(car.speed) > 2, 120, [car]);
  if (!driving.ok) {
    return { ok: false, why: 'never drove off' };
  }

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

/** Verify that a spot occupied by Cody’s car is excluded from the free spots available to valets. */
export function codysSpotIsntFree() {
  const g = window.__game;
  const sim = window.__sim;
  g.start();
  sim.run(30);
  const spot = g.garage.topFree();
  const car = g.vehicles.find((v) => v.role === 'parked' && !v.insideDeck && v.form === 'car');
  if (!spot || !car) {
    return { ok: false, why: 'no free spot or no car' };
  }

  g.board(car);
  car.place(spot.center.x, spot.center.y, spot.center.z, spot.def.yaw, 0, 0, null);
  car.vel.set(0, 0, 0);
  car.speed = 0;
  sim.run(2);
  const next = g.garage.topFree();
  return {
    ok: next !== null && next !== spot && g.garage.isFree(spot, car),
    sitting: spot.def.id,
    next: next?.def.id ?? null,
  };
}

/**
 * Verify that a valet’s reservation excludes the destination from free spots until parking replaces the claim with
 * occupancy.
 */
export function spotBookedTillParked() {
  const g = window.__game;
  const sim = window.__sim;
  g.start();
  sim.run(120);
  const valet = g.valet.crew.find((v) => v.state === 'idle');
  if (!valet) {
    return { ok: false, why: 'no idle valet' };
  }

  const car = g.vehicles
    .filter((v) => v.role === 'parked' && !v.insideDeck && v.form === 'car')
    .sort((a, b) => a.pos.distanceTo(valet.walker.pos) - b.pos.distanceTo(valet.walker.pos))[0];
  const spot = g.garage.topFree();
  if (!car || !spot) {
    return { ok: false, why: 'no car or spot' };
  }

  car.ignition.transfer('away', valet.keys);
  g.valet.take(valet, car, spot);
  sim.run(60);
  const booked =
    g.claims.holder('spot', spot) === car &&
    spot.occupant === null &&
    !g.garage.isFree(spot) &&
    g.garage.topFree() !== spot;
  const parked = sim.until(() => spot.occupant === car, 150, [car]);
  sim.run(2);
  const released = g.claims.holder('spot', spot) === null;
  return { ok: booked && parked.ok && released, booked, parkSeconds: parked.seconds, released };
}
