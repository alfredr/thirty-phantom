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
