// Drivers who see phantom Cody. Each case runs in the page (see tools/scenarios.mjs).

/** Start traffic and advance through the transition to night. */
const nightTraffic = () => {
  const g = window.__game;
  const sim = window.__sim;
  g.start();
  sim.run(200);
  g.debug.night();
  sim.run(90);
};

/**
 * Repeatedly frighten traffic near the deck entry. Return the first car that
 * starts a refuge route, or null after 900 frames.
 */
const turnIn = () => {
  const g = window.__game;
  const sim = window.__sim;
  for (let i = 0; i < 900; i++) {
    const id = g.debug.scare(6);
    sim.run(1);
    const car = g.vehicles.find((v) => v.id === id);
    if (car && g.refuge.has(car)) {
      return car;
    }
  }

  return null;
};

/**
 * Return a point the requested number of meters behind the car along its
 * heading.
 */
const behind = (car, meters) => ({
  x: car.pos.x - Math.sin(car.yaw) * meters,
  y: car.pos.y,
  z: car.pos.z - Math.cos(car.yaw) * meters,
});

/**
 * Verify that a frightened driver enters the deck without stopping, parks in a
 * spot, and joins the pedestrian crowd.
 */
export function turnsIntoDeck() {
  const g = window.__game;
  const sim = window.__sim;
  sim.nightTraffic();
  const car = sim.turnIn();
  if (!car) {
    return { ok: false, why: 'nobody turned off for the deck' };
  }

  let slowest = Infinity;
  const inside = sim.until(
    () => {
      if (!car.insideDeck) {
        slowest = Math.min(slowest, Math.abs(car.speed));
      }

      return car.insideDeck;
    },
    20,
    [car],
  );
  const peopleBefore = g.crowd.living().length;
  const parked = sim.until(
    () => car.role === 'parked' && !g.refuge.has(car),
    90,
    [car],
  );
  const spot = g.garage.spots.find((s) => s.occupant === car);
  const driverRan = g.crowd.living().length > peopleBefore;
  return {
    ok:
      inside.ok &&
      inside.seconds < 10 &&
      slowest > 1 &&
      parked.ok &&
      !!spot &&
      driverRan,
    secondsToGate: inside.seconds,
    slowestOnRoad: Math.round(slowest * 10) / 10,
    secondsToOut: parked.seconds,
    spot: spot?.def.id ?? null,
    driverRan,
    maxJump: Math.max(inside.maxJump, parked.maxJump),
  };
}

/**
 * Verify that a driver accelerates along the road when Cody remains behind the
 * car.
 */
export function speedsAwayWhenCodyIsBehind() {
  const g = window.__game;
  const sim = window.__sim;
  sim.nightTraffic();
  const id = g.debug.scare(-6);
  const car = g.vehicles.find((v) => v.id === id);
  if (!car) {
    return { ok: false, why: 'no traffic' };
  }

  const before = car.speed;
  for (let i = 0; i < 30; i++) {
    g.debug.scare(-6, id);
    sim.run(1);
  }

  return {
    ok: car.role === 'traffic' && car.speed > before + 1,
    role: car.role,
    speedBefore: Math.round(before * 10) / 10,
    speedAfter: Math.round(car.speed * 10) / 10,
  };
}

/**
 * Verify that a driver far from the deck stops short of Cody and joins the
 * pedestrian crowd.
 */
export function stopsAndRunsWhenCornered() {
  const g = window.__game;
  const sim = window.__sim;
  sim.nightTraffic();
  const e = g.refuge.entry;
  const car = g.vehicles
    .filter((v) => v.role === 'traffic' && Math.abs(v.speed) > 3)
    .sort((a, b) => b.pos.distanceTo(e) - a.pos.distanceTo(e))[0];
  if (!car) {
    return { ok: false, why: 'no moving traffic' };
  }

  const cody = g.traffic.roadAt(car, 7);
  const dist = () => Math.hypot(car.pos.x - cody.x, car.pos.z - cody.z);
  const start = dist();
  let closest = start;
  const peopleBefore = g.crowd.living().length;
  const out = sim.until(
    () => {
      g.debug.frighten(car.id, cody.x, cody.y, cody.z);
      closest = Math.min(closest, dist());
      return car.role === 'parked';
    },
    8,
    [car],
  );
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

/**
 * Verify that moving Cody behind a driver cancels the refuge route, releases
 * its spot, and restores traffic driving.
 */
export function backToTheRoadWhenCodyMoves() {
  const g = window.__game;
  const sim = window.__sim;
  sim.nightTraffic();
  const car = sim.turnIn();
  if (!car) {
    return { ok: false, why: 'nobody turned off for the deck' };
  }

  const back = sim.until(
    () => {
      const p = sim.behind(car, 6);
      g.debug.frighten(car.id, p.x, p.y, p.z);
      return car.role === 'traffic';
    },
    2,
    [car],
  );
  const spotsHeld = g.garage.spots.filter(
    (s) => g.claims.holder('spot', s) === car,
  ).length;
  sim.run(30);
  return {
    ok:
      back.ok &&
      !g.refuge.has(car) &&
      spotsHeld === 0 &&
      car.role === 'traffic' &&
      !car.insideDeck,
    seconds: back.seconds,
    role: car.role,
    spotsHeld,
    maxJump: back.maxJump,
  };
}

/**
 * Verify that a refuge route resolves while keeping the car clear of Cody when
 * he blocks the approach.
 */
export function givesWayWhenCodyIsInTheWayIn() {
  const g = window.__game;
  const sim = window.__sim;
  sim.nightTraffic();
  const car = sim.turnIn();
  if (!car) {
    return { ok: false, why: 'nobody turned off for the deck' };
  }

  const divert = g.refuge.diverts.find((d) => d.p.car === car);
  const offRoad = sim.until(
    () => !g.traffic.onRoad(car) && divert.step.action.ahead?.(16).length > 0,
    10,
    [car],
  );
  if (!offRoad.ok) {
    return { ok: false, why: 'never left the road with a way in' };
  }

  const cody = divert.step.action.ahead(16)[2];
  const dist = () => Math.hypot(car.pos.x - cody.x, car.pos.z - cody.z);
  const start = dist();
  let closest = start;
  const settled = sim.until(
    () => {
      g.debug.frighten(car.id, cody.x, cody.y, cody.z);
      closest = Math.min(closest, dist());
      return !g.refuge.has(car);
    },
    60,
    [car],
  );
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

/**
 * Verify that repeated scares inside the deck send the driver upstairs, where
 * it eventually parks.
 */
export function climbsWhileCodyIsInSight() {
  const g = window.__game;
  const sim = window.__sim;
  sim.nightTraffic();
  const car = sim.turnIn();
  if (!car) {
    return { ok: false, why: 'nobody turned off for the deck' };
  }

  const inside = sim.until(() => car.insideDeck, 20, [car]);
  if (!inside.ok) {
    return { ok: false, why: 'never got in' };
  }

  const up = sim.until(
    () => {
      const p = sim.behind(car, 7);
      g.debug.frighten(car.id, p.x, p.y, p.z);
      return g.garage.floorOf(car.pos.y) >= 1 || !g.refuge.has(car);
    },
    60,
    [car],
  );
  const parked = sim.until(() => !g.refuge.has(car), 60, [car]);
  const spot = g.garage.spots.find((s) => s.occupant === car);
  return {
    ok:
      up.ok &&
      g.garage.floorOf(car.pos.y) >= 1 &&
      parked.ok &&
      car.role === 'parked' &&
      !!spot &&
      spot.def.level >= 1,
    secondsToClimb: up.seconds,
    level: g.garage.floorOf(car.pos.y),
    spotLevel: spot?.def.level ?? null,
    maxJump: Math.max(up.maxJump, parked.maxJump),
  };
}

/**
 * Verify that boarding a fleeing driver’s car cancels the refuge route and
 * frees its reserved spot.
 */
export function stopsWhenCarjacked() {
  const g = window.__game;
  const sim = window.__sim;
  sim.nightTraffic();
  const car = sim.turnIn();
  if (!car) {
    return { ok: false, why: 'nobody turned off for the deck' };
  }

  sim.run(90);
  const spot = g.garage.spots.find((s) => g.claims.holder('spot', s) === car);
  // Call board() directly to bypass the ability rules that prevent phantom Cody from stealing a street car.
  g.board(car);
  sim.run(3);
  const peopleAfter = g.crowd.living().length;
  sim.run(30);
  return {
    ok:
      g.refuge.count === 0 &&
      car.role === 'player' &&
      !!spot &&
      g.garage.isFree(spot) &&
      g.crowd.living().length === peopleAfter,
    cody: car.role,
    runsLeft: g.refuge.count,
    spotFreed: !!spot && g.garage.isFree(spot),
  };
}

/**
 * Place Cody at `at` for `seconds` and record vehicle reactions, minimum
 * moving-car distance, and maximum frame displacement.
 */
const watch = (at, seconds) => {
  const g = window.__game;
  g.player.place(new g.player.pos.constructor(at.x, at.y, at.z), 0);
  const spooked = new Set();
  g.events.on('spooked', ({ car }) => spooked.add(car.id));
  const turnedIn = new Set();
  const pulledRound = new Set();
  const bailed = new Set();
  const was = new Map();
  let closestMoving = Infinity;
  let maxJump = 0;
  const last = new Map();
  for (let i = 0; i < seconds * 30; i++) {
    g.frame(1 / 30);

    for (const v of g.vehicles) {
      if (g.refuge.has(v)) {
        turnedIn.add(v.id);
      }

      if (g.detours.has(v)) {
        pulledRound.add(v.id);
      }

      if (was.get(v) === 'traffic' && v.role === 'parked' && !v.insideDeck) {
        bailed.add(v.id);
      }

      was.set(v, v.role);

      if (Math.abs(v.speed) > 2) {
        closestMoving = Math.min(
          closestMoving,
          Math.hypot(v.pos.x - at.x, v.pos.z - at.z),
        );
      }

      const p = last.get(v);
      if (p) {
        maxJump = Math.max(maxJump, v.pos.distanceTo(p));
      }

      last.set(v, v.pos.clone());
    }
  }

  return {
    phantom: g.player.form === 'night',
    spooked: spooked.size,
    turnedIn: turnedIn.size,
    pulledRound: pulledRound.size,
    bailed: bailed.size,
    closestMoving: Math.round(closestMoving * 10) / 10,
    maxJump: Math.round(maxJump * 100) / 100,
  };
};

/**
 * Find the traffic path nearest the deck entry and the distance along that
 * path to its closest point.
 */
const gateLane = () => {
  const g = window.__game;
  const e = g.refuge.entry;
  let best = null;
  for (const line of g.traffic.paths) {
    const s = line.project(e);
    const p = line.sample(s, e.clone());
    const d = Math.hypot(p.x - e.x, p.z - e.z);
    if (!best || d < best.d) {
      best = { line, s, d };
    }
  }

  return best;
};

/**
 * Verify that Cody standing just beyond the entry sends at least one driver
 * into the deck and keeps moving cars clear.
 */
export function playerJustPastTheGate() {
  const g = window.__game;
  const sim = window.__sim;
  sim.nightTraffic();
  const { line, s } = sim.gateLane();
  const at = line.sample(s + 3, g.player.pos.clone());
  const r = sim.watch(at, 45);
  return { ok: r.phantom && r.turnedIn >= 1 && r.closestMoving > 1.5, ...r };
}

/**
 * Place Cody ahead of two nearby cars away from the deck. Verify that both
 * react and moving cars keep clear without entering the deck.
 */
export function playerInTheRoadAwayFromTheDeck() {
  const g = window.__game;
  const sim = window.__sim;
  sim.nightTraffic();
  const e = g.refuge.entry;
  let pair = null;
  sim.until(
    () => {
      const cars = g.vehicles.filter(
        (v) =>
          v.role === 'traffic' &&
          Math.abs(v.speed) > 3 &&
          v.pos.distanceTo(e) > 50,
      );
      for (const a of cars) {
        const b = cars.find(
          (o) =>
            o !== a &&
            o.pathIndex === a.pathIndex &&
            o.pathS < a.pathS &&
            a.pathS - o.pathS < 20,
        );
        if (b) {
          pair = { a, b };
        }
      }

      return !!pair;
    },
    120,
    [],
  );

  if (!pair) {
    return { ok: false, why: 'no two cars close together' };
  }

  const at = g.traffic.roadAt(pair.a, 22);
  const r = sim.watch(at, 45);
  return {
    ok:
      r.phantom && r.spooked >= 2 && r.turnedIn === 0 && r.closestMoving > 1.5,
    ...r,
  };
}

/** Shared browser scenario helpers installed on window.__sim before each case. */
export const steps = { nightTraffic, turnIn, behind, watch, gateLane };
