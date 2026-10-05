export const steps = {
  ride: (form) => {
    const g = window.__game;
    g.start();
    window.__sim.run(30);
    g.clock.paused = true;
    const ride = g.vehicles.find((v) => v.role === 'parked' && !v.insideDeck && v.form === 'car' && v.kind === 'sedan');
    if (!ride) {
      return null;
    }

    g.board(ride);

    if (form === 'truck') {
      g.scene.remove(ride.rig.root);
      const rig = g.assets.truckRig();
      ride.setForm('truck', rig);
      g.scene.add(rig.root);
    }

    return g.driving === ride ? ride : null;
  },
  phantom: () => {
    const g = window.__game;
    const sim = window.__sim;
    g.start();
    sim.run(30);
    g.debug.night();
    sim.until(() => g.player.form === 'night', 20, []);
    g.clock.paused = true;
    const car = g.vehicles.find((v) => v.role === 'parked' && v.insideDeck && v.form === 'car' && v.pos.y < 1);
    if (!car) {
      return null;
    }

    g.board(car);
    sim.until(() => g.codyRide.driving !== null, 10, []);
    return g.driving?.form === 'truck' ? g.driving : null;
  },
  lane: (kind, before, after, boosted = false) => {
    const g = window.__game;
    const C = g.world.collision;
    const blocked = (p, own, hx, hz, from, to, passable) => {
      for (let t = from; t <= to; t += 0.5) {
        const x = p.x + hx * t;
        const z = p.z + hz * t;
        for (const s of C.query(x - 1.9, z - 1.9, x + 1.9, z + 1.9)) {
          const inside = s.min[0] < x + 1.9 && s.max[0] > x - 1.9 && s.min[2] < z + 1.9 && s.max[2] > z - 1.9;
          if (inside && s.enabled && !own.includes(s) && s.max[1] > p.y + 1 && !passable(s)) {
            return true;
          }
        }
      }

      return false;
    };

    for (const [i, p] of g.world.props.props.entries()) {
      if (p.kind.name !== kind || (p.solid.boost !== undefined) !== boosted) {
        continue;
      }

      const own = [p.solid, ...(p.parts ?? [])];
      for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        const hx = Math.sin(yaw);
        const hz = Math.cos(yaw);
        if (
          !blocked(p, own, hx, hz, -before, -0.5, () => false) &&
          !blocked(p, own, hx, hz, 0.5, after, (s) => s.knockdown)
        ) {
          return { i, p, own, yaw, hx, hz };
        }
      }
    }

    return null;
  },
  charge: (ride, kind, gap, speed, stick, frames) => {
    const g = window.__game;
    const sim = window.__sim;
    const back = ride.params.length / 2;
    const lane = sim.lane(kind, back * 2 + gap + 1, 6);
    if (!lane) {
      return { why: `no clear lane to a ${kind}` };
    }

    const { i, p, own, yaw, hx, hz } = lane;
    const d = back + gap + 0.5;
    ride.place(p.x - hx * d, p.y, p.z - hz * d, yaw, speed, 0, null);
    g.debug.teleport(p.x - hx * d, p.y, p.z - hz * d);
    ride.place(p.x - hx * d, p.y, p.z - hz * d, yaw, speed, 0, null);
    let knocked = 0;
    g.events.on('prop', (e) => {
      if (e.by === ride && e.kind.name === kind) {
        knocked++;
      }
    });
    g.input.setStick(0, stick);
    let fastest = 0;
    for (let f = 0; f < frames && g.world.props.standing(i); f++) {
      fastest = Math.max(fastest, Math.abs(ride.speed));
      sim.run(1);
    }

    const broke = !g.world.props.standing(i);
    sim.run(broke ? 30 : 0);
    g.input.setStick(0, 0);
    const past = (ride.pos.x - p.x) * hx + (ride.pos.z - p.z) * hz;
    return {
      i,
      own,
      broke,
      open: own.every((s) => !s.enabled),
      knocked,
      fastest: Math.round(fastest * 10) / 10,
      past: Math.round(past * 10) / 10,
      smashSpeed: ride.params.smashSpeed,
    };
  },
};

function breaksAtSpeed(kind) {
  const sim = window.__sim;
  const ride = sim.ride('truck');
  if (!ride) {
    return { ok: false, why: 'no truck' };
  }

  const r = sim.charge(ride, kind, 1.5, 12, 1, 60);
  if (r.why) {
    return { ok: false, why: r.why };
  }

  const ok = r.broke && r.open && r.knocked === 1 && r.past > 3;
  return { ok, broke: r.broke, open: r.open, knocked: r.knocked, past: r.past, fastest: r.fastest };
}

function slowTouchLeavesIt(kind) {
  const sim = window.__sim;
  const ride = sim.ride('truck');
  if (!ride) {
    return { ok: false, why: 'no truck' };
  }

  const r = sim.charge(ride, kind, 0.6, 0, 0.12, 90);
  if (r.why) {
    return { ok: false, why: r.why };
  }

  const ok = !r.broke && !r.open && r.past < 0 && r.fastest < r.smashSpeed;
  return { ok, broke: r.broke, past: r.past, fastest: r.fastest, smashSpeed: r.smashSpeed };
}

function carAtSpeedLeavesIt(kind) {
  const sim = window.__sim;
  const ride = sim.ride('car');
  if (!ride) {
    return { ok: false, why: 'no car' };
  }

  const r = sim.charge(ride, kind, 1.5, 22, 1, 60);
  if (r.why) {
    return { ok: false, why: r.why };
  }

  const ok = !r.broke && !r.open && r.past < 0;
  return { ok, broke: r.broke, past: r.past, fastest: r.fastest };
}

function bigTreeNeedsABoostedHit(mode) {
  const g = window.__game;
  const sim = window.__sim;
  const ride = sim.ride('truck');
  if (!ride) {
    return { ok: false, why: 'no truck' };
  }

  const fast = mode !== 'boostedSlow';
  const boost = mode !== 'fastUnboosted';
  const back = ride.params.length / 2;
  const gap = fast ? 3 : 0.5;
  const lane = sim.lane('tree', back * 2 + gap + 1, 6, true);
  if (!lane) {
    return { ok: false, why: 'no clear lane to a big tree' };
  }

  const { i, p, own, yaw, hx, hz } = lane;
  const d = back + gap + 0.5;
  const speed = fast ? 24 : 6;
  ride.place(p.x - hx * d, p.y, p.z - hz * d, yaw, speed, 0, null);
  g.debug.teleport(p.x - hx * d, p.y, p.z - hz * d);
  ride.place(p.x - hx * d, p.y, p.z - hz * d, yaw, speed, 0, null);
  g.ghast = 1;
  g.input.hold('KeyB', boost);
  g.input.setStick(0, 1);
  let fastest = 0;
  let burning = false;
  for (let f = 0; f < 45 && g.world.props.standing(i); f++) {
    fastest = Math.max(fastest, Math.abs(ride.speed));
    burning ||= g.burning;
    sim.run(1);
  }

  const broke = !g.world.props.standing(i);
  const along = () => (ride.pos.x - p.x) * hx + (ride.pos.z - p.z) * hz;
  const need = p.solid.boost;
  const momentum = Math.round(ride.mass * fastest);
  g.input.hold('KeyB', false);

  if (broke) {
    sim.run(30);
    g.input.setStick(0, 0);
    const past = Math.round(along() * 10) / 10;
    const ok = fast && boost && burning && own.every((s) => !s.enabled) && past > 3;
    return { ok, broke, burning, fastest: Math.round(fastest * 10) / 10, momentum, need, past };
  }

  g.input.setStick(0, 0);
  sim.run(60);
  const hit = along();
  g.input.setStick(0, -1);
  sim.run(45);
  g.input.setStick(0, 0);
  const backed = Math.round((hit - along()) * 10) / 10;
  const ok = !(fast && boost) && burning === boost && own.every((s) => s.enabled) && hit < 0 && backed > 2;
  return {
    ok,
    broke,
    burning,
    fastest: Math.round(fastest * 10) / 10,
    momentum,
    need,
    hit: Math.round(hit * 10) / 10,
    backed,
  };
}

export const cases = {
  bigTreeNeedsABoostedHit: { run: bigTreeNeedsABoostedHit, inputs: ['boostedFast', 'boostedSlow', 'fastUnboosted'] },
  truckBreaksAtSpeed: { run: breaksAtSpeed, inputs: ['headstone', 'deadTree'] },
  slowTruckTouchLeavesIt: { run: slowTouchLeavesIt, inputs: ['headstone', 'deadTree'] },
  carAtSpeedLeavesIt: { run: carAtSpeedLeavesIt, inputs: ['headstone', 'deadTree'] },
  vehicleKillsSometimesLeaveGhosts: {
    inputs: ['car', 'truck', 'phantom'],
    run: (form) => {
      const g = window.__game;
      const sim = window.__sim;
      const ride = form === 'phantom' ? sim.phantom() : sim.ride(form);
      if (!ride) {
        return { ok: false, why: `no ${form}` };
      }

      const causes = [];
      const onDeath = g.crowd.casualties.onDeath;
      g.crowd.casualties.onDeath = (c, cause) => {
        causes.push(cause);
        onDeath(c, cause);
      };

      let raised = 0;
      const onGhost = g.crowd.onGhost;
      g.crowd.onGhost = (at) => {
        raised++;
        onGhost(at);
      };

      let rose = 0;
      const rise = g.ghosts.rise.bind(g.ghosts);
      g.ghosts.rise = (at) => {
        rose++;
        rise(at);
      };

      const kills = 30;
      const speed = ride.form === 'truck' ? 18 : 24;
      const nose = ride.params.length / 2;
      const at = form === 'phantom' ? ride.pos.clone() : ride.pos.clone().set(30, 0, 0);
      const yaw = form === 'phantom' ? ride.yaw + Math.PI : Math.PI / 2;
      const ahead = at.clone().set(at.x + Math.sin(yaw) * (nose + 0.2), at.y, at.z + Math.cos(yaw) * (nose + 0.2));
      let dead = 0;
      for (let k = 0; k < kills; k++) {
        ride.place(at.x, at.y, at.z, yaw, speed, 0, null);
        const p = g.crowd.add(ahead.clone(), 0);
        sim.run(2);

        if (p.hurt?.harm === 'dead') {
          dead++;
        }
      }

      const vehicle = causes.filter((c) => c === 'vehicle').length;
      const ok =
        dead === kills &&
        vehicle === kills &&
        causes.length === kills &&
        raised > 0 &&
        raised < kills / 2 &&
        rose === raised;
      return { ok, kills, dead, vehicle, raised, rose };
    },
  },
};

export function brokenGravesStandAgainAtSunrise() {
  const g = window.__game;
  const sim = window.__sim;
  const ride = sim.ride('truck');
  if (!ride) {
    return { ok: false, why: 'no truck' };
  }

  const r = sim.charge(ride, 'headstone', 1.5, 12, 1, 60);
  if (!r.broke) {
    return { ok: false, why: r.why ?? 'did not break' };
  }

  let sunrise = false;
  g.events.on('sunrise', () => (sunrise = true));
  g.clock.paused = false;
  g.clock.hours = 7.49;
  sim.until(() => sunrise, 5, []);
  const standing = g.world.props.standing(r.i);
  const solid = r.own.every((s) => s.enabled);
  return { ok: sunrise && standing && solid, sunrise, standing, solid };
}

export function graveyardGhostsGatherAtNight() {
  const g = window.__game;
  const sim = window.__sim;
  g.start();
  sim.run(30);
  g.debug.setHours(23);
  g.clock.paused = true;
  sim.run(60);
  const zones = [...new Set(g.ghosts.list.map((x) => x.zone))];
  const yard = zones.find((z) => (z.weight ?? 1) > 1);
  if (!yard) {
    return { ok: false, why: 'no weighted ghost zone' };
  }

  const inside = (p) => p.x >= yard.min[0] && p.x <= yard.max[0] && p.z >= yard.min[2] && p.z <= yard.max[2];
  const there = () => g.ghosts.active().filter(inside).length;
  const gathered = there();
  const one = g.ghosts.active().find(inside).clone();
  const took = g.ghosts.suck(one, 0.5, 1 / 30);
  sim.run(1);
  const after = there();
  const back = sim.until(() => there() === gathered, yard.respawn + 1, []);
  const ok = gathered >= 24 && took === 1 && after === gathered - 1 && back.ok && back.seconds <= yard.respawn + 0.1;
  return { ok, gathered, total: g.ghosts.active().length, respawn: yard.respawn, back: back.seconds };
}
