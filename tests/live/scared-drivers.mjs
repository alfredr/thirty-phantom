// Drivers frightened by phantom Cody near the deck. Each case runs in the page (see tools/scenarios.mjs).

/** Night falls with traffic about. */
const nightTraffic = () => {
  const g = window.__game;
  const sim = window.__sim;
  g.start();
  sim.run(200);
  g.debug.night();
  sim.run(90);
};

/** A driver frightened near the deck, with Cody ahead on their road, turns in, parks in a spot, and gets out and runs. */
export function turnsIntoDeck() {
  const g = window.__game;
  const sim = window.__sim;
  sim.nightTraffic();
  let id = -1;
  sim.until(() => (id = g.debug.divert()) >= 0, 30, []);
  const car = g.vehicles.find((v) => v.id === id);
  if (!car) return { ok: false, why: 'no traffic car would divert' };
  const peopleBefore = g.crowd.living().length;
  const done = sim.until(() => car.role === 'parked', 90, [car]);
  const spot = g.garage.spots.find((s) => s.occupant === car);
  return {
    ok: done.ok && car.insideDeck && !!spot && g.crowd.living().length > peopleBefore,
    seconds: done.seconds,
    maxJump: done.maxJump,
    inDeck: car.insideDeck,
    spot: spot?.def.id ?? null,
    driverRan: g.crowd.living().length > peopleBefore,
  };
}

/** With Cody behind them the road is the way out, so a driver near the deck keeps going; the same driver turns in when he's ahead. */
export function keepsDrivingWhenCodyIsBehind() {
  const g = window.__game;
  const sim = window.__sim;
  sim.nightTraffic();
  let turnedFromBehind = 0;
  let id = -1;
  const found = sim.until(() => {
    if (g.debug.divert(-6) >= 0) turnedFromBehind++;
    id = g.debug.divert(6);
    return id >= 0;
  }, 30, []);
  return { ok: found.ok && turnedFromBehind === 0, turnedFromBehind, turnedFromAhead: id, seconds: found.seconds };
}

/** Cody takes a car while its frightened driver is running it for the deck: the run stops, and its spot is free again. */
export function stopsWhenCarjacked() {
  const g = window.__game;
  const sim = window.__sim;
  sim.nightTraffic();
  let id = -1;
  sim.until(() => (id = g.debug.divert()) >= 0, 30, []);
  const car = g.vehicles.find((v) => v.id === id);
  if (!car) return { ok: false, why: 'no traffic car would divert' };
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
export const steps = { nightTraffic };
