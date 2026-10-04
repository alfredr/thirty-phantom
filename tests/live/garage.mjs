/** Initial deck cars must be registered before the occupancy board is displayed. */
export function initialCarsAreLogged() {
  const g = window.__game;
  g.start();
  window.__sim.run(1);

  const cars = g.vehicles.filter((v) => v.insideDeck && !v.gone);
  const registered = cars.filter((v) => g.garage.spots.some((s) => s.occupant === v && v.homeSpot === s.def.id)).length;
  const logged = g.garage.logged;
  const phantom = g.garage.phantomOccupancy(g.vehicles);
  const displayed = g.hud.root.querySelector('.sign-score').textContent;
  return {
    ok: cars.length > 0 && registered === cars.length && logged === cars.length && phantom === 0 && displayed === '0',
    actual: cars.length,
    registered,
    logged,
    phantom,
    displayed,
  };
}

/** Restoring a phantom replaces its initial car while preserving that car's logged entry. */
export function restoredPhantomReplacesParkedCar() {
  const g = window.__game;
  g.start();
  const spot = g.garage.spots.find((s) => s.occupant);
  if (!spot) {
    return { ok: false, why: 'no registered initial car' };
  }

  const car = spot.occupant;
  const logged = g.garage.logged;
  const actual = g.garage.actual(g.vehicles);
  g.restorePhantom(spot.def.id, spot.center, spot.def.yaw);
  window.__sim.run(1);

  const phantom = g.garage.phantomOccupancy(g.vehicles);
  const displayed = g.hud.root.querySelector('.sign-score').textContent;
  return {
    ok:
      !g.vehicles.includes(car) &&
      spot.occupant === null &&
      !!spot.phantom &&
      g.garage.logged === logged &&
      g.garage.actual(g.vehicles) === actual - 1 &&
      phantom === 1 &&
      displayed === '1',
    logged: g.garage.logged,
    actual: g.garage.actual(g.vehicles),
    phantom,
    displayed,
  };
}
