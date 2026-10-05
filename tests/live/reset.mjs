export const steps = {
  boardDeckCar: () => {
    const g = window.__game;
    g.start();
    window.__sim.run(30);
    const car = g.vehicles.find((v) => v.role === 'parked' && v.insideDeck && v.form === 'car' && v.pos.y < 1);
    if (car) {
      g.board(car, true);
      window.__sim.run(10);
    }

    return g.driving ? car : null;
  },
  wedge: (car) => {
    const g = window.__game;
    const y = car.pos.y + 0.7;
    let best = null;
    for (let k = 0; k < 32; k++) {
      const yaw = (k / 32) * Math.PI * 2;
      const dx = Math.sin(yaw);
      const dz = Math.cos(yaw);
      const reach = 12;
      const f = g.world.collision.raycast(
        [car.pos.x, y, car.pos.z],
        [car.pos.x + dx * reach, y, car.pos.z + dz * reach],
        0,
      );
      if (f < 1 && (!best || f * reach < best.d)) {
        best = { d: f * reach, yaw, dx, dz };
      }
    }

    if (!best) {
      return null;
    }

    const back = best.d - car.params.length / 2 - 0.4;
    car.place(car.pos.x + best.dx * back, car.pos.y, car.pos.z + best.dz * back, best.yaw, 0, 0, g.world.collision);
    g.garage.resync(car);
    return best;
  },
  promptShown: () => {
    return document.querySelector('.hud-reset')?.classList.contains('show') ?? false;
  },
  drivable: (car) => {
    const g = window.__game;
    const p = car.form === 'truck' ? g.debug.profiles.truck : g.debug.profiles.car;
    const fits = g.nav.standable(car.pos.x, car.pos.y, car.pos.z, p, car.yaw) !== null;
    const clear = g.vehicles.every(
      (o) => o === car || o.gone || o.pos.distanceTo(car.pos) > (o.params.length + car.params.length) / 2,
    );
    return { fits, clear, speed: Math.round(car.speed * 100) / 100 };
  },
};

export function wedgedCarResetsToOpenGround() {
  const g = window.__game;
  const sim = window.__sim;
  const car = sim.boardDeckCar();
  if (!car) {
    return { ok: false, why: 'no deck car to board' };
  }

  const wall = sim.wedge(car);
  if (!wall) {
    return { ok: false, why: 'no wall in reach' };
  }

  const crossings = [];
  g.events.on('crossing', (c) => crossings.push(c.kind));
  const start = car.pos.clone();
  g.input.hold('KeyW', true);
  sim.run(30 * 2);
  const early = sim.promptShown();
  const shown = sim.until(() => sim.promptShown(), 6, []);
  g.input.hold('KeyW', false);
  const pushed = Math.round(car.pos.distanceTo(start) * 100) / 100;
  if (!shown.ok) {
    return { ok: false, why: 'no prompt', pushed };
  }

  let resets = 0;
  g.events.on('reset', () => resets++);
  g.input.press('KeyR');
  sim.run(1);
  const after = sim.drivable(car);
  const hidden = !sim.promptShown();
  const from = car.pos.clone();
  g.input.hold('KeyW', true);
  sim.run(30 * 2);
  g.input.hold('KeyW', false);
  const drove = Math.round(car.pos.distanceTo(from) * 10) / 10;
  return {
    ok: !early && resets === 1 && after.fits && after.clear && hidden && drove > 3 && crossings.length === 0,
    promptAfter: shown.seconds + 2,
    pushed,
    resets,
    after,
    hidden,
    drove,
    crossings,
  };
}

export function resetAcrossTheDeckEdgeCountsNothing() {
  const g = window.__game;
  const sim = window.__sim;
  const car = sim.boardDeckCar();
  if (!car) {
    return { ok: false, why: 'no deck car to board' };
  }

  const inside = car.pos.clone();
  const out = car.pos.clone();
  while (g.garage.inFootprint(out)) {
    out.x -= 1;
  }

  out.x -= 10;
  out.y = g.world.collision.groundAt(out.x, out.z, 2, 0.5);
  const crossings = [];
  let phantoms = 0;
  g.events.on('crossing', (c) => crossings.push(c.kind));
  g.events.on('phantom', () => phantoms++);
  const logged = g.garage.logged;
  const before = g.garage.phantoms;
  g.resetVehicle(car, { pos: out, yaw: car.yaw });
  sim.run(30);
  const outside = !car.insideDeck;
  g.resetVehicle(car, { pos: inside, yaw: car.yaw });
  sim.run(30);
  const back = car.insideDeck;
  g.resetVehicle(car);
  sim.run(10);
  return {
    ok:
      outside &&
      back &&
      crossings.length === 0 &&
      phantoms === 0 &&
      g.garage.phantoms === before &&
      g.garage.logged === logged &&
      !g.codyRide.escaping,
    outside,
    back,
    crossings,
    phantoms,
    logged: [logged, g.garage.logged],
  };
}
