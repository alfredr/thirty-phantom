// Vehicle-key ownership, collection, and valet handover through the running game.

export function droppedKeysStartOnlyTheirCar() {
  const g = window.__game;
  const sim = window.__sim;
  g.start();
  sim.run(2);
  const car = g.vehicles.find((v) => g.visitors.waiting(v));
  if (!car) {
    return { ok: false, why: 'no registered parked car' };
  }

  car.ignition.transfer('away', 'ignition');
  g.crowd.arrive(car);
  const owner = g.crowd.living().find((p) => p.car === car && car.ignition.heldBy(p.keys));
  if (!owner) {
    return { ok: false, why: 'no owner' };
  }

  const keys = car.ignition;
  owner.mind.send({ type: 'felled', from: car.pos.clone(), vx: 0, vz: 0, harm: 'dead' });
  const dropped = keys.heldBy('ground') && !owner.keys.held.size;
  const refused = !g.visitors.leave(car, owner.keys);
  g.player.place(owner.walker.pos.clone(), 0);
  sim.run(1);
  const collected = keys.heldBy(g.inventory.keys);
  const label = g.interactions.inventoryView(g.inventory).find((i) => i.kind === `keys-${car.id}`)?.name;
  g.codyRide.enter(car);
  const started = g.driving === car && car.engineOn && keys.heldBy('ignition') && !keys.hotwired;
  g.alight();
  const carried = keys.heldBy(g.inventory.keys);
  g.fleet.remove(car);
  const retired = !g.inventory.keys.held.has(keys);
  return {
    ok: dropped && refused && collected && started && carried && retired && label === `KEYS FOR ${car.plate}`,
    dropped,
    refused,
    collected,
    started,
    carried,
    retired,
    label,
  };
}

export function valetTakesNearestMatchingKeys() {
  const g = window.__game;
  const sim = window.__sim;
  g.start();
  sim.run(3);
  const valet = g.valet.crew.find((v) => v.state === 'idle');
  const at = valet.walker.pos.clone();
  g.player.place(at.clone().add({ x: 0, y: 0, z: 1 }), 0);

  const spawn = (distance, owned) => {
    const car = g.park(at.clone().add({ x: distance, y: 0, z: 0 }), 0, 'sedan');
    if (owned) {
      car.ignition.transfer('away', g.inventory.keys);
    }

    return car;
  };

  const withoutKeys = spawn(3, false);
  const nearest = spawn(7, true);
  const farther = spawn(13, true);
  const selected = g.codyRide.carForValet() === nearest;
  g.input.press('KeyF');
  sim.run(1);
  g.input.press('KeyF');
  sim.run(1);
  return {
    ok:
      selected &&
      valet.car === nearest &&
      nearest.ignition.heldBy(valet.keys) &&
      farther.ignition.heldBy(g.inventory.keys) &&
      withoutKeys.ignition.heldBy('away'),
    selected,
    plate: nearest.plate,
    valetCar: valet.car?.plate,
    keysTransferred: nearest.ignition.heldBy(valet.keys),
  };
}
