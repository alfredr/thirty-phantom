// Drivers who see phantom Cody. Each case runs in the page (see tools/scenarios.mjs).

/** Night falls with traffic about. */
const nightTraffic = () => {
  const g = window.__game;
  const sim = window.__sim;
  g.start();
  sim.run(200);
  g.debug.night();
  sim.run(90);
};

/** Cody appears in the road just ahead of the traffic car nearest the deck's entry, frame after frame, until a driver turns off for the deck. Returns that car, or null. */
const turnIn = () => {
  const g = window.__game;
  const sim = window.__sim;
  for (let i = 0; i < 900; i++) {
    const id = g.debug.scare(6);
    sim.run(1);
    const car = g.vehicles.find((v) => v.id === id);
    if (car && g.refuge.has(car)) return car;
  }
  return null;
};

/** Where Cody would stand `meters` behind a car, on its line. */
const behind = (car, meters) => ({ x: car.pos.x - Math.sin(car.yaw) * meters, y: car.pos.y, z: car.pos.z - Math.cos(car.yaw) * meters });

/** A driver whose road leads toward Cody, with the deck's entry just ahead, turns off without stopping, parks, sits a moment, then gets out and runs. */
export function turnsIntoDeck() {
  const g = window.__game;
  const sim = window.__sim;
  sim.nightTraffic();
  const car = sim.turnIn();
  if (!car) return { ok: false, why: 'nobody turned off for the deck' };
  let slowest = Infinity;
  const inside = sim.until(() => {
    if (!car.insideDeck) slowest = Math.min(slowest, Math.abs(car.speed));
    return car.insideDeck;
  }, 20, [car]);
  const peopleBefore = g.crowd.living().length;
  const parked = sim.until(() => car.role === 'parked' && !g.refuge.has(car), 90, [car]);
  const spot = g.garage.spots.find((s) => s.occupant === car);
  const driverRan = g.crowd.living().length > peopleBefore;
  return {
    ok: inside.ok && inside.seconds < 10 && slowest > 1 && parked.ok && !!spot && driverRan,
    secondsToGate: inside.seconds,
    slowestOnRoad: Math.round(slowest * 10) / 10,
    secondsToOut: parked.seconds,
    spot: spot?.def.id ?? null,
    driverRan,
    maxJump: Math.max(inside.maxJump, parked.maxJump),
  };
}

/** With Cody behind them the road is the way out: the driver floors it along it. */
export function speedsAwayWhenCodyIsBehind() {
  const g = window.__game;
  const sim = window.__sim;
  sim.nightTraffic();
  const id = g.debug.scare(-6);
  const car = g.vehicles.find((v) => v.id === id);
  if (!car) return { ok: false, why: 'no traffic' };
  const before = car.speed;
  for (let i = 0; i < 30; i++) {
    g.debug.scare(-6, id);
    sim.run(1);
  }
  return { ok: car.role === 'traffic' && car.speed > before + 1, role: car.role, speedBefore: Math.round(before * 10) / 10, speedAfter: Math.round(car.speed * 10) / 10 };
}

/** Far from the deck, with Cody standing in the road ahead, a driver stops short of him, gets out and runs. */
export function stopsAndRunsWhenCornered() {
  const g = window.__game;
  const sim = window.__sim;
  sim.nightTraffic();
  const e = g.refuge.entry;
  const car = g.vehicles.filter((v) => v.role === 'traffic' && Math.abs(v.speed) > 3).sort((a, b) => b.pos.distanceTo(e) - a.pos.distanceTo(e))[0];
  if (!car) return { ok: false, why: 'no moving traffic' };
  const cody = g.traffic.roadAt(car, 7);
  const dist = () => Math.hypot(car.pos.x - cody.x, car.pos.z - cody.z);
  const start = dist();
  let closest = start;
  const peopleBefore = g.crowd.living().length;
  const out = sim.until(() => {
    g.debug.frighten(car.id, cody.x, cody.y, cody.z);
    closest = Math.min(closest, dist());
    return car.role === 'parked';
  }, 8, [car]);
  sim.run(2);
  const driverRan = g.crowd.living().length > peopleBefore;
  return {
    ok: out.ok && closest > 3 && driverRan && !g.refuge.has(car),
    seconds: out.seconds,
    start: Math.round(start * 10) / 10,
    closest: Math.round(closest * 10) / 10,
    driverRan,
    maxJump: out.maxJump,
  };
}

/** Cody moves behind a driver on their way to the turn-off: the road is the way out again, so they take it and give up the deck. */
export function backToTheRoadWhenCodyMoves() {
  const g = window.__game;
  const sim = window.__sim;
  sim.nightTraffic();
  const car = sim.turnIn();
  if (!car) return { ok: false, why: 'nobody turned off for the deck' };
  const back = sim.until(() => {
    const p = sim.behind(car, 6);
    g.debug.frighten(car.id, p.x, p.y, p.z);
    return car.role === 'traffic';
  }, 2, [car]);
  const spotsHeld = g.garage.spots.filter((s) => g.claims.holder('spot', s) === car).length;
  sim.run(30);
  return { ok: back.ok && !g.refuge.has(car) && spotsHeld === 0 && car.role === 'traffic' && !car.insideDeck, seconds: back.seconds, role: car.role, spotsHeld, maxJump: back.maxJump };
}

/** Cody steps into the way in, between a driver and the deck: they don't drive at him. They find a way round, or get out and run. */
export function givesWayWhenCodyIsInTheWayIn() {
  const g = window.__game;
  const sim = window.__sim;
  sim.nightTraffic();
  const car = sim.turnIn();
  if (!car) return { ok: false, why: 'nobody turned off for the deck' };
  const divert = g.refuge.diverts.find((d) => d.p.car === car);
  const offRoad = sim.until(() => !g.traffic.onRoad(car) && divert.stage.ahead?.(16).length > 0, 10, [car]);
  if (!offRoad.ok) return { ok: false, why: 'never left the road with a way in' };
  const cody = divert.stage.ahead(16)[2];
  const dist = () => Math.hypot(car.pos.x - cody.x, car.pos.z - cody.z);
  const start = dist();
  let closest = start;
  const settled = sim.until(() => {
    g.debug.frighten(car.id, cody.x, cody.y, cody.z);
    closest = Math.min(closest, dist());
    return !g.refuge.has(car);
  }, 60, [car]);
  return {
    ok: settled.ok && closest > 2,
    outcome: car.role,
    inDeck: car.insideDeck,
    start: Math.round(start * 10) / 10,
    closest: Math.round(closest * 10) / 10,
    seconds: settled.seconds,
    maxJump: settled.maxJump,
  };
}

/** Inside the deck with Cody following in sight, a driver heads up a level; once he's out of sight they park and, after a moment, get out. */
export function climbsWhileCodyIsInSight() {
  const g = window.__game;
  const sim = window.__sim;
  sim.nightTraffic();
  const car = sim.turnIn();
  if (!car) return { ok: false, why: 'nobody turned off for the deck' };
  const inside = sim.until(() => car.insideDeck, 20, [car]);
  if (!inside.ok) return { ok: false, why: 'never got in' };
  const up = sim.until(() => {
    const p = sim.behind(car, 7);
    g.debug.frighten(car.id, p.x, p.y, p.z);
    return g.garage.floorOf(car.pos.y) >= 1 || !g.refuge.has(car);
  }, 60, [car]);
  const parked = sim.until(() => !g.refuge.has(car), 60, [car]);
  const spot = g.garage.spots.find((s) => s.occupant === car);
  return {
    ok: up.ok && g.garage.floorOf(car.pos.y) >= 1 && parked.ok && car.role === 'parked' && !!spot && spot.def.level >= 1,
    secondsToClimb: up.seconds,
    level: g.garage.floorOf(car.pos.y),
    spotLevel: spot?.def.level ?? null,
    maxJump: Math.max(up.maxJump, parked.maxJump),
  };
}

/** Cody takes a car while its frightened driver is running it for the deck: the run stops, and its spot is free again. */
export function stopsWhenCarjacked() {
  const g = window.__game;
  const sim = window.__sim;
  sim.nightTraffic();
  const car = sim.turnIn();
  if (!car) return { ok: false, why: 'nobody turned off for the deck' };
  sim.run(90);
  const spot = g.garage.spots.find((s) => g.claims.holder('spot', s) === car);
  // board() is the scripted way in, past Cody's abilities: at night phantom Cody couldn't steal it out on the street.
  g.board(car);
  sim.run(3);
  const peopleAfter = g.crowd.living().length;
  sim.run(30);
  return {
    ok: g.refuge.count === 0 && car.role === 'player' && !!spot && g.garage.isFree(spot) && g.crowd.living().length === peopleAfter,
    cody: car.role,
    runsLeft: g.refuge.count,
    spotFreed: !!spot && g.garage.isFree(spot),
  };
}

/** Steps shared by this set's cases, installed on window.__sim before each one. */
export const steps = { nightTraffic, turnIn, behind };
