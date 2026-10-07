export const steps = {
  truck: () => {
    const g = window.__game;
    const sim = window.__sim;
    g.start();
    sim.run(30);
    g.debug.night();
    sim.until(() => g.player.form === 'night', 20, []);
    g.clock.paused = true;
    const car = g.vehicles.find(
      (v) =>
        v.role === 'parked' && v.insideDeck && v.form === 'car' && v.pos.y < 1,
    );
    if (!car) {
      return null;
    }

    g.board(car);
    sim.until(() => g.codyRide.driving !== null, 10, []);
    const truck = g.driving;
    return truck && truck.form === 'truck' ? truck : null;
  },
  reversals: (track, from) => {
    let n = 0;
    for (let i = from + 2; i < track.length; i++) {
      const ax = track[i - 1].x - track[i - 2].x;
      const az = track[i - 1].z - track[i - 2].z;
      const bx = track[i].x - track[i - 1].x;
      const bz = track[i].z - track[i - 1].z;
      if (ax * bx + az * bz < 0 && Math.hypot(bx, bz) > 0.05) {
        n++;
      }
    }

    return n;
  },
};

export function truckCreepingOffTheRoofKickerCrossesOnce() {
  const g = window.__game;
  const sim = window.__sim;
  const truck = sim.truck();
  if (!truck) {
    return { ok: false, why: 'no truck' };
  }

  const roof = Math.max(...g.garage.nav.floors);
  const { max } = g.garage.nav;
  const kicker = g.world.collision.solids.find(
    (s) =>
      s.ramp &&
      s.ramp.axis === 'x' &&
      s.ramp.dir > 0 &&
      s.min[1] === roof &&
      s.max[0] < max[0],
  );
  if (!kicker) {
    return { ok: false, why: 'no roof kicker' };
  }

  const kinds = [];
  g.events.on(
    'crossing',
    ({ vehicle, kind }) => vehicle === truck && kinds.push(kind),
  );
  truck.place(
    kicker.min[0] - 2,
    roof,
    (kicker.min[2] + kicker.max[2]) / 2,
    Math.PI / 2,
    0,
    0,
    null,
  );
  g.input.setStick(0, 0.15);
  const track = [];
  for (let i = 0; i < 240; i++) {
    sim.run(1);
    track.push(truck.pos.clone());
  }

  g.input.setStick(0, 0);
  const reversals = sim.reversals(
    track.filter((p) => p.y > roof - 1),
    0,
  );
  const off = !g.garage.inFootprint(truck.pos) && truck.pos.y < 1;
  return {
    ok: kinds.length === 1 && kinds[0] === 'escaped' && reversals === 0 && off,
    kinds,
    reversals,
    off,
  };
}

export function boundaryJitterLogsAtMostOneCrossing() {
  const g = window.__game;
  const sim = window.__sim;
  const truck = sim.truck();
  if (!truck) {
    return { ok: false, why: 'no truck' };
  }

  const gate = g.world.gates.list.find((x) => x.def.kind === 'entry');
  const edge = g.garage.nav.max[0];
  const z = gate.center.z;
  const kinds = [];
  g.events.on(
    'crossing',
    ({ vehicle, kind }) => vehicle === truck && kinds.push(kind),
  );
  truck.place(edge - 3, 0.2, z, Math.PI / 2, 0, 0, null);
  sim.run(10);

  for (let i = 0; i < 60; i++) {
    truck.place(
      i % 2 ? edge + 0.6 : edge - 1,
      i % 2 ? 0 : 0.2,
      z,
      Math.PI / 2,
      0,
      0,
      null,
    );
    sim.run(1);
  }

  const jittered = kinds.length;
  truck.place(edge - 3, 0.2, z, Math.PI / 2, 0, 0, null);
  g.input.setStick(0, 0.5);
  sim.run(60);
  g.input.setStick(0, 0);
  return {
    ok: jittered <= 1 && kinds.length === 1 && kinds[0] === 'logged-out',
    jittered,
    kinds,
  };
}

export function wedgeOnTheRoofRampHoldsStill() {
  const g = window.__game;
  const sim = window.__sim;
  const truck = sim.truck();
  if (!truck) {
    return { ok: false, why: 'no truck' };
  }

  const roof = Math.max(...g.garage.nav.floors);
  const ramp = g.world.collision.solids.find(
    (s) =>
      s.ramp && s.ramp.axis === 'x' && s.max[1] === roof && s.min[1] < roof,
  );
  if (!ramp) {
    return { ok: false, why: 'no ramp to the roof' };
  }

  const up = ramp.ramp.dir;
  const x =
    up > 0
      ? ramp.min[0] + 0.85 * (ramp.max[0] - ramp.min[0])
      : ramp.max[0] - 0.85 * (ramp.max[0] - ramp.min[0]);
  const z = ramp.min[2] + 0.05 * (ramp.max[2] - ramp.min[2]);
  const yaw = Math.atan2(up, 0) + 0.8;
  truck.place(
    x,
    g.world.collision.groundAt(x, z, roof + 1, 0),
    z,
    yaw,
    0,
    0,
    null,
  );
  g.input.setStick(0, 1);
  const track = [];
  for (let i = 0; i < 150; i++) {
    sim.run(1);
    track.push(truck.pos.clone());
  }

  g.input.setStick(0, 0);
  const reversals = sim.reversals(track, 60);
  return {
    ok: reversals <= 2,
    reversals,
    at: truck.pos.toArray().map((n) => Math.round(n * 100) / 100),
  };
}

export function leavingTheFloorAboveTheGateIsAnEscape() {
  const g = window.__game;
  const sim = window.__sim;
  const truck = sim.truck();
  if (!truck) {
    return { ok: false, why: 'no truck' };
  }

  const gate = g.world.gates.list.find((x) => x.def.kind === 'entry');
  const floor = g.garage.nav.floors[1];
  const edge = g.garage.nav.max[0];
  const z = gate.center.z;
  for (const s of g.world.collision.solids) {
    if (
      s.min[0] >= edge - 1 &&
      s.min[1] >= floor &&
      s.min[1] < floor + 2 &&
      s.min[2] <= z &&
      s.max[2] >= z
    ) {
      s.enabled = false;
    }
  }

  const kinds = [];
  g.events.on(
    'crossing',
    ({ vehicle, kind }) => vehicle === truck && kinds.push(kind),
  );
  truck.place(edge - 2, floor, z, Math.PI / 2, 0, 0, null);
  g.input.setStick(0, 0.08);
  let landed = null;
  for (let i = 0; i < 300 && !landed; i++) {
    sim.run(1);

    if (truck.pos.y < 1) {
      landed = truck.pos.clone();
    }
  }

  g.input.setStick(0, 0);
  sim.run(60);
  const inLane = !!landed && !!g.world.gates.inZone(landed);
  return {
    ok: kinds.length === 1 && kinds[0] === 'escaped' && inLane,
    kinds,
    inLane,
    landed: landed?.toArray(),
  };
}

export function teleportAcrossTheEdgeResyncsWithoutACrossing() {
  const g = window.__game;
  const sim = window.__sim;
  const truck = sim.truck();
  if (!truck) {
    return { ok: false, why: 'no truck' };
  }

  const gate = g.world.gates.list.find((x) => x.def.kind === 'entry');
  const edge = g.garage.nav.max[0];
  const kinds = [];
  let imprints = 0;
  g.events.on(
    'crossing',
    ({ vehicle, kind }) => vehicle === truck && kinds.push(kind),
  );
  g.events.on('phantom', () => imprints++);
  const spot = truck.homeSpot;
  const outside = { x: edge + 8, z: g.garage.nav.min[2] + 2 };
  truck.place(
    outside.x,
    g.world.collision.groundAt(outside.x, outside.z, 5, 0),
    outside.z,
    0,
    0,
    0,
    null,
  );
  g.garage.resync(truck);
  sim.run(30);
  const out = !truck.insideDeck;
  truck.place(edge - 3, 0.2, gate.center.z, Math.PI / 2, 0, 0, null);
  g.garage.resync(truck);
  sim.run(30);
  const back = truck.insideDeck;
  const teleported = kinds.length;
  g.input.setStick(0, 0.5);
  sim.run(60);
  g.input.setStick(0, 0);
  return {
    ok:
      spot !== null &&
      out &&
      back &&
      teleported === 0 &&
      imprints === 0 &&
      kinds.join() === 'logged-out',
    spot,
    out,
    back,
    kinds,
    imprints,
  };
}
