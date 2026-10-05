// Vehicle wreck and escape scenarios. Each case runs in the page (see tools/scenarios.mjs).

/** Verify that an uncontrolled truck crash updates both parapet collision and visible damage. */
export function wreckSmashesThroughAParapet() {
  const g = window.__game;
  const sim = window.__sim;
  g.start();
  sim.run(30);
  const deck = g.world.breakables.filter((b) => b.solid.min[1] > 3);
  const piece = deck[0];
  if (!piece) {
    return { ok: false, why: 'no parapet above the street' };
  }

  const s = piece.solid;
  // Place the truck 8 m inside the parapet, facing it at the same floor height.
  const alongX = s.max[0] - s.min[0] > s.max[2] - s.min[2];
  const mid = g.deckCenter;
  const out = alongX ? Math.sign(piece.center.z - mid.z) : Math.sign(piece.center.x - mid.x);
  const dx = alongX ? 0 : out;
  const dz = alongX ? out : 0;
  const at = { x: piece.center.x - dx * 8, y: s.min[1], z: piece.center.z - dz * 8 };
  const truck = g.fleet.spawnCar('parked', piece.center.clone().set(at.x, at.y, at.z), Math.atan2(dx, dz));
  g.scene.remove(truck.rig.root);
  const rig = g.assets.truckRig();
  truck.setForm('truck', rig);
  g.scene.add(rig.root);
  // Apply an impulse toward the parapet with no driver controlling the truck.
  const push = truck.mass * 22;
  truck.hit(truck.pos.x, truck.pos.y, truck.pos.z, dx * push, 0, dz * push, true);
  sim.run(150);
  const holes = g.world.breakables.filter((b) => !b.solid.enabled && !b.broken).length;
  const broken = g.world.breakables.filter((b) => b.broken).length;
  return { ok: broken > 0 && holes === 0, broken, holes };
}

/** Verify that a truck escaping outside a gate creates a phantom, coasts, and starts vanishing after Cody disembarks. */
export function escapedTruckRollsOnThenDissolves() {
  const g = window.__game;
  const sim = window.__sim;
  g.start();
  sim.run(30);
  g.debug.night();
  sim.until(() => g.player.form === 'night', 20, []);
  const car = g.vehicles.find((v) => v.role === 'parked' && v.insideDeck && v.form === 'car' && v.pos.y < 1);
  if (!car) {
    return { ok: false, why: 'no car on the deck floor' };
  }

  g.board(car);
  const changed = sim.until(() => g.codyRide.driving !== null, 10, []);
  const truck = g.driving;
  if (!truck || truck.form !== 'truck') {
    return { ok: false, why: 'no truck', changed: changed.ok };
  }

  // Move the truck beyond the west edge, clear of every gate.
  const out = truck.pos.clone();
  while (g.garage.inFootprint(out)) {
    out.x -= 1;
  }

  out.x -= 8;

  if (g.world.gates.inZone(out)) {
    return { ok: false, why: 'came out by a gate' };
  }

  let phantoms = 0;
  g.events.on('phantom', () => phantoms++);
  truck.place(out.x, 0, out.z, truck.yaw, 0, 0, null);
  sim.run(2);
  const rolling = g.codyRide.escaping;
  const gone = sim.until(() => g.codyRide.onFoot, 10, []);
  return {
    ok: phantoms === 1 && rolling && gone.ok && truck.status === 'vanishing',
    phantoms,
    rolling,
    onFootAfter: gone.seconds,
    status: truck.status,
  };
}

/** Verify that a truck collision crushes an outside parked car, clears its parking record, and eventually removes it. */
export function truckCrushesACar() {
  const g = window.__game;
  const sim = window.__sim;
  g.start();
  sim.run(30);
  const victim = g.vehicles.find((v) => v.role === 'parked' && !v.insideDeck && v.form === 'car');
  const ride = g.vehicles.find((v) => v !== victim && v.role === 'parked' && !v.insideDeck && v.form === 'car');
  if (!victim || !ride) {
    return { ok: false, why: 'no parked cars outside the deck' };
  }

  g.board(ride);
  g.scene.remove(ride.rig.root);
  const rig = g.assets.truckRig();
  ride.setForm('truck', rig);
  g.scene.add(rig.root);
  // Place the truck 10 m behind the car, approaching at 12 m/s.
  const yaw = victim.yaw;
  ride.place(victim.pos.x - Math.sin(yaw) * 10, victim.pos.y, victim.pos.z - Math.cos(yaw) * 10, yaw, 0, 0, null);
  ride.vel.set(Math.sin(yaw) * 12, 0, Math.cos(yaw) * 12);
  ride.speed = 12;
  let crushed = 0;
  g.events.on('crushed', ({ car, by }) => {
    if (car === victim && by === ride) {
      crushed++;
    }
  });
  sim.run(45);
  const flat = victim.status === 'crushed' && victim.role === 'parked' && victim.gone;
  sim.run(240);
  const removed = !g.vehicles.includes(victim);
  return { ok: crushed === 1 && flat && removed, crushed, flat, removed };
}

/** Find a roof kicker, its run-up start 12 m before the low end, and its launch heading. */
const roofKicker = () => {
  const g = window.__game;
  const kickers = g.world.collision.solids.filter((s) => s.ramp && s.max[1] - s.ramp.low < 2.5);
  const top = Math.max(...kickers.map((s) => s.ramp.low));
  const box = kickers.find((s) => Math.abs(s.ramp.low - top) < 0.1);
  if (!box) {
    return null;
  }

  const r = box.ramp;
  const ax = r.axis === 'x' ? 0 : 2;
  const across = ax === 0 ? 2 : 0;
  const P = g.player.pos.constructor;
  const start = new P();
  start.setComponent(ax, (r.dir > 0 ? box.min[ax] : box.max[ax]) - r.dir * 12);
  start.setComponent(across, (box.min[across] + box.max[across]) / 2);
  start.y = r.low;
  const launch = new P(ax === 0 ? r.dir : 0, 0, ax === 0 ? 0 : r.dir);
  return { start, launch, yaw: Math.atan2(launch.x, launch.z) };
};

/** Hold the heading and line of a kicker run-up at full throttle. */
const runUp = (k) => (v) => {
  const side = (v.pos.x - k.start.x) * -k.launch.z + (v.pos.z - k.start.z) * k.launch.x;
  const heading = Math.atan2(Math.sin(v.yaw - k.yaw), Math.cos(v.yaw - k.yaw));
  return { throttle: 1, steer: Math.max(-1, Math.min(1, 2.5 * heading - 0.35 * side)), hop: false, drift: false };
};

/** Record the hardest ground landing of `v`. */
const landings = (v) => {
  const seen = { hardest: 0 };
  window.__game.events.on('impact', (e) => {
    if (e.v === v && e.against === 'ground') {
      seen.hardest = Math.max(seen.hardest, e.took);
    }
  });
  return seen;
};

/** Steal a badged car on the roof, jump it off the kicker, and leave Cody on foot beside the wreck with no phantom. */
export function aCarJumpedOffTheRoofIsWrecked() {
  const g = window.__game;
  const sim = window.__sim;
  g.start();
  sim.run(30);
  const k = sim.roofKicker();
  if (!k) {
    return { ok: false, why: 'no roof kicker' };
  }

  const roof = g.garage.spots.filter((s) => Math.abs(s.center.y - k.start.y) < 1 && g.garage.isFree(s));
  const spot = roof[0];
  if (!spot) {
    return { ok: false, why: 'no free roof spot' };
  }

  const car = g.fleet.spawnCar('parked', spot.center, spot.def.yaw, 'sedan');
  g.garage.checkIn(spot, car);
  const before = g.garage.phantoms;
  const ledger = () => {
    const actual = g.garage.actual(g.vehicles);
    return { logged: g.garage.logged, actual, phantom: g.garage.logged - actual };
  };

  const was = ledger();
  let phantoms = 0;
  g.events.on('phantom', () => phantoms++);
  g.board(car);
  g.resetVehicle(car, { pos: k.start, yaw: k.yaw });
  const hit = sim.landings(car);
  g.autopilot = sim.runUp(k);
  const wrecked = sim.until(() => car.status === 'crushed', 12, [car]);
  g.autopilot = null;
  sim.run(10);
  const now = ledger();
  const near = g.player.pos.distanceTo(car.pos);
  const toast = [...document.querySelectorAll('.toast')].some((t) => /PHANTOM CODY/.test(t.textContent ?? ''));
  const result = {
    wrecked: wrecked.ok,
    landed: Math.round(hit.hardest * 10) / 10,
    tolerance: car.breed.landingTolerance,
    phantoms,
    toast,
    onFoot: g.codyRide.onFoot && g.player.visible,
    near: Math.round(near * 10) / 10,
    canDrive: !car.status,
    ledger: { was, now },
  };
  return {
    ok:
      wrecked.ok &&
      phantoms === 0 &&
      g.garage.phantoms === before &&
      !toast &&
      result.onFoot &&
      near < 4 &&
      !result.canDrive &&
      now.phantom === was.phantom &&
      now.logged === was.logged - 1,
    ...result,
  };
}

/** Drop a stolen car from one floor's height onto the street: it lands hard but still drives. */
export function aCarSurvivesAOneFloorDrop() {
  const g = window.__game;
  const sim = window.__sim;
  g.start();
  sim.run(30);
  const car = g.vehicles.find((v) => v.role === 'parked' && !v.insideDeck && v.form === 'car');
  if (!car) {
    return { ok: false, why: 'no parked car outside the deck' };
  }

  g.board(car);
  const hit = sim.landings(car);
  const drop = 5 + (car.params.hop * car.params.hop) / (2 * 32);
  car.place(car.pos.x, car.pos.y + drop, car.pos.z, car.yaw, 0, 0, null);
  sim.until(() => hit.hardest > 0, 4, [car]);
  sim.run(10);
  return {
    ok: hit.hardest > 15 && !car.status && g.driving === car,
    landed: Math.round(hit.hardest * 10) / 10,
    drop: Math.round(drop * 10) / 10,
    status: car.status,
  };
}

/** The phantom truck jumping off the roof is a phantom and comes down whole. */
export function theTruckJumpedOffTheRoofIsAPhantom() {
  const g = window.__game;
  const sim = window.__sim;
  g.start();
  sim.run(30);
  g.debug.night();
  sim.until(() => g.player.form === 'night', 20, []);
  const k = sim.roofKicker();
  const car = g.vehicles.find((v) => v.role === 'parked' && v.insideDeck && v.form === 'car');
  if (!k || !car) {
    return { ok: false, why: 'no kicker or deck car' };
  }

  g.board(car);
  sim.until(() => g.codyRide.driving !== null, 10, []);
  const truck = g.driving;
  if (!truck || truck.form !== 'truck') {
    return { ok: false, why: 'no truck' };
  }

  const before = g.garage.phantoms;
  g.resetVehicle(truck, { pos: k.start, yaw: k.yaw });
  const hit = sim.landings(truck);
  g.autopilot = sim.runUp(k);
  const landed = sim.until(() => truck.grounded && truck.pos.y < 3 && hit.hardest > 0, 12, [truck]);
  g.autopilot = null;
  return {
    ok: landed.ok && g.garage.phantoms === before + 1 && truck.status !== 'crushed',
    landed: Math.round(hit.hardest * 10) / 10,
    phantoms: g.garage.phantoms - before,
    status: truck.status,
  };
}

export const steps = { roofKicker, runUp, landings };
