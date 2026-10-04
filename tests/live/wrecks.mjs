// Cars nobody is driving: wrecks tumbling on their own. Each case runs in the page (see tools/scenarios.mjs).

/**
 * A monster truck flung at a deck parapet with nobody at the wheel smashes through it like one
 * Cody drives: the piece is broken (gone from view), never a hole left open in a parapet that
 * still shows.
 */
export function wreckSmashesThroughAParapet() {
  const g = window.__game;
  const sim = window.__sim;
  g.start();
  sim.run(30);
  const deck = g.world.breakables.filter((b) => b.solid.min[1] > 3);
  const piece = deck[0];
  if (!piece) return { ok: false, why: 'no parapet above the street' };
  const s = piece.solid;
  // square on to it from the deck side, eight metres back, on its floor
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
  // knocked hard toward the parapet: it crashes, and tumbles on with nobody driving
  const push = truck.mass * 22;
  truck.hit(truck.pos.x, truck.pos.y, truck.pos.z, dx * push, 0, dz * push, true);
  sim.run(150);
  const holes = g.world.breakables.filter((b) => !b.solid.enabled && !b.broken).length;
  const broken = g.world.breakables.filter((b) => b.broken).length;
  return { ok: broken > 0 && holes === 0, broken, holes };
}

/**
 * Phantom Cody possesses a car in the deck and gets the truck out without going through the gate:
 * a phantom's left behind, the truck rolls on a moment, dissolves, and leaves him on foot.
 */
export function escapedTruckRollsOnThenDissolves() {
  const g = window.__game;
  const sim = window.__sim;
  g.start();
  sim.run(30);
  g.debug.night();
  sim.until(() => g.player.form === 'night', 20, []);
  const car = g.vehicles.find((v) => v.role === 'parked' && v.insideDeck && v.form === 'car' && v.pos.y < 1);
  if (!car) return { ok: false, why: 'no car on the deck floor' };
  g.board(car);
  const changed = sim.until(() => g.codyRide.state.at === 'driving', 10, []);
  const truck = g.driving;
  if (!truck || truck.form !== 'truck') return { ok: false, why: 'no truck', changed: changed.ok };
  // straight out through the side, well clear of any gate
  const out = truck.pos.clone();
  while (g.garage.inFootprint(out)) out.x -= 1;
  out.x -= 8;
  if (g.world.gates.inZone(out)) return { ok: false, why: 'came out by a gate' };
  let phantoms = 0;
  g.events.on('phantom', () => phantoms++);
  truck.place(out.x, 0, out.z, truck.yaw, 0, 0, null);
  sim.run(2);
  const rolling = g.codyRide.state.at === 'driving' && g.codyRide.state.escape !== null;
  const gone = sim.until(() => g.codyRide.state.at === 'onFoot', 10, []);
  return { ok: phantoms === 1 && rolling && gone.ok && truck.status === 'vanishing', phantoms, rolling, onFootAfter: gone.seconds, status: truck.status };
}

/** Cody's monster truck runs over a parked car outside the deck: it's flattened, nobody's to drive it, and it's gone a few seconds later. */
export function truckCrushesACar() {
  const g = window.__game;
  const sim = window.__sim;
  g.start();
  sim.run(30);
  const victim = g.vehicles.find((v) => v.role === 'parked' && !v.insideDeck && v.form === 'car');
  const ride = g.vehicles.find((v) => v !== victim && v.role === 'parked' && !v.insideDeck && v.form === 'car');
  if (!victim || !ride) return { ok: false, why: 'no parked cars outside the deck' };
  g.board(ride);
  g.scene.remove(ride.rig.root);
  const rig = g.assets.truckRig();
  ride.setForm('truck', rig);
  g.scene.add(rig.root);
  // ten metres short of it, heading straight at it at 12 m/s
  const yaw = victim.yaw;
  ride.place(victim.pos.x - Math.sin(yaw) * 10, victim.pos.y, victim.pos.z - Math.cos(yaw) * 10, yaw, 0, 0, null);
  ride.vel.set(Math.sin(yaw) * 12, 0, Math.cos(yaw) * 12);
  ride.speed = 12;
  let crushed = 0;
  g.events.on('crushed', ({ car, by }) => {
    if (car === victim && by === ride) crushed++;
  });
  sim.run(45);
  const flat = victim.status === 'crushed' && victim.role === 'parked' && victim.gone;
  sim.run(240);
  const removed = !g.vehicles.includes(victim);
  return { ok: crushed === 1 && flat && removed, crushed, flat, removed };
}
