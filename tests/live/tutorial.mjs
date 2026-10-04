// Tutorial browser scenarios, from the roof conversation through completion (see tools/scenarios.mjs).
// Advance dialogue with input events, set the clock directly, and board vehicles through the game API.
// Inject escape crossings to test tutorial progression without reproducing the jump physics.

/** Enable the tutorial when the scenario runner starts each case. */
export const tutorial = true;

/** Read the currently displayed goal beneath the clock. */
const goal = () => document.querySelector('.burner-goal.on')?.textContent?.trim() ?? '';

/** Return the visible objective labels in sorted order. */
const marks = () =>
  window.__game.objectives.list
    .map((o) => o.label)
    .sort()
    .join(',');

/**
 * Advance at 30 FPS, pressing F through dialogue and signs until done() succeeds or the time limit expires. Return
 * whether done() succeeded.
 */
const playUntil = (done, seconds) => {
  const g = window.__game;
  for (let i = 0; i < seconds * 30; i++) {
    if (done()) {
      return true;
    }

    if (i % 6 === 0 && (document.body.classList.contains('dialogue-open') || document.querySelector('.signpost.on'))) {
      g.input.press('KeyF');
    }

    g.frame(1 / 30);
  }

  return done();
};

/** Complete each tutorial stage in sequence and report its goal, markers, and any failed checkpoint. */
export function playsThrough() {
  const g = window.__game;
  const sim = window.__sim;
  const reached = [];
  const at = (step, ok, extra = {}) => {
    reached.push({ step, ok, goal: sim.goal(), marks: sim.marks(), ...extra });
    return ok;
  };

  const result = () => ({ ok: reached.every((r) => r.ok) && reached.at(-1)?.step === 'done', reached });

  // Verify the opening scene holds Randy at the window and the clock at 17:30 before introducing the badge objective.
  g.start();
  const truck = g.vehicles.find((v) => v.role === 'player');
  const randy = g.npcs.find('randy');
  if (!truck || !randy) {
    return { ok: false, why: 'no pickup or no Randy', reached };
  }

  const opened = sim.playUntil(() => document.body.classList.contains('dialogue-open'), 5);
  const heldAtWindow = randy.held && Math.abs(g.clock.hours - 17.5) < 0.01 && !!g.cutscene;
  if (
    !at(
      'roof',
      opened &&
        heldAtWindow &&
        sim.playUntil(() => /FIND YOUR BADGE/.test(sim.goal()), 60) &&
        g.inventory.count('burner') === 1 &&
        sim.marks() === 'YOUR BADGE',
    )
  ) {
    return result();
  }

  // Advance to sunset and wait for the call that sends Cody back to the pickup.
  g.clock.hours = 18.99;

  if (
    !at(
      'back',
      sim.playUntil(() => /GET BACK IN THE PICKUP/.test(sim.goal()), 40) && sim.marks() === 'YOUR BADGE,YOUR PICKUP',
    )
  ) {
    return result();
  }

  // Board the pickup and verify that the jump objective clears the map markers.
  g.board(truck);

  if (!at('jump', sim.playUntil(() => /OFF THE ROOF/.test(sim.goal()), 5) && sim.marks() === '')) {
    return result();
  }

  // Inject the first escape and advance through the phantom explanation to the driving objective.
  g.onCrossing({ vehicle: truck, kind: 'escaped' });

  if (
    !at(
      'cruise',
      sim.playUntil(() => /SPIN|CAMERAS/.test(sim.goal()), 60),
      { phantoms: g.garage.phantoms },
    )
  ) {
    return result();
  }

  // Advance to 22:00 and wait for the tire objective and Randy’s marker.
  g.clock.hours = 21.99;

  if (!at('basement', sim.playUntil(() => /FIND TIRES/.test(sim.goal()), 40) && sim.marks() === 'RANDY')) {
    return result();
  }

  // Visit Randy without tires and verify that the tire objective remains active.
  g.alight();
  sim.run(10);
  const P = g.player.pos.constructor;
  g.player.place(
    new P(randy.pos.x + Math.sin(randy.homeYaw) * 1.6, randy.pos.y, randy.pos.z + Math.cos(randy.homeYaw) * 1.6),
    randy.homeYaw + Math.PI,
  );
  sim.run(5);
  g.input.press('KeyF');
  sim.run(3);
  const turnedAway =
    sim.playUntil(() => !document.body.classList.contains('dialogue-open'), 20) && /FIND TIRES/.test(sim.goal());
  if (!at('noWheels', turnedAway)) {
    return result();
  }

  // Trade a tire and verify payment before the next objective appears.
  g.inventory.add('tire', 1);
  const brisketBefore = g.inventory.count('brisket');
  sim.run(3);
  g.input.press('KeyF');
  sim.run(3);
  const ate = sim.playUntil(() => /GO BACK OUT/.test(sim.goal()), 40);
  if (!at('outside', ate && g.inventory.count('tire') === 0 && g.inventory.count('brisket') > brisketBefore)) {
    return result();
  }

  // Move outside and wait for Cody’s night form and the scare objective.
  const road = g.traffic.paths[0].sample(0, g.player.pos.clone());
  g.player.place(road, 0);

  if (!at('spook', sim.playUntil(() => /SPOOK SOMEBODY/.test(sim.goal()), 20) && g.player.form === 'night')) {
    return result();
  }

  // Trigger a scare, then summon skeletons to advance to possession.
  sim.playUntil(() => g.debug.scare(6) >= 0 && /RAISE THE DEAD/.test(sim.goal()), 60);

  if (!at('raise', /RAISE THE DEAD/.test(sim.goal()))) {
    return result();
  }

  const raised = sim.playUntil(() => {
    g.input.press('KeyX');
    return /POSSESS A CAR/.test(sim.goal());
  }, 30);
  if (!at('possess', raised)) {
    return result();
  }

  // Possess a deck car and inject its escape crossing.
  const inDeck = g.vehicles.find((v) => v.role === 'parked' && v.insideDeck && v.form === 'car');
  if (!inDeck) {
    return { ok: false, why: 'no car in the deck', reached };
  }

  g.board(inDeck);
  sim.run(3);
  g.onCrossing({ vehicle: inDeck, kind: 'escaped' });
  sim.run(30);

  // Advance through sunrise at 07:30, then steal, register, and park a street car.

  g.clock.hours = 7.49;

  if (
    !at(
      'steal',
      sim.playUntil(() => /STEAL A CAR/.test(sim.goal()), 20),
    )
  ) {
    return result();
  }

  g.alight();
  sim.run(10);
  const street = g.vehicles.find((v) => v.role === 'parked' && !v.insideDeck && v.form === 'car');
  if (!street) {
    return { ok: false, why: 'no car to steal', reached };
  }

  g.board(street);

  if (
    !at(
      'badge',
      sim.playUntil(() => /EAST GATE/.test(sim.goal()), 5),
    )
  ) {
    return result();
  }

  g.onCrossing({ vehicle: street, kind: 'logged-in' });

  if (
    !at(
      'park',
      sim.playUntil(() => /PARK IN A FREE SPOT/.test(sim.goal()), 5),
    )
  ) {
    return result();
  }

  const spot = g.garage.freeSpots()[0];
  street.place(spot.center.x, spot.center.y, spot.center.z, spot.def.yaw, 0, 0, null);
  street.insideDeck = true;
  sim.run(3);
  g.alight();

  if (
    !at(
      'tonight',
      sim.playUntil(() => /WAIT FOR NIGHT/.test(sim.goal()), 5),
    )
  ) {
    return result();
  }

  // Complete the second night’s possession and escape sequence.
  g.clock.hours = 18.99;
  // Wait for Cody’s night transformation to finish before boarding.
  sim.playUntil(() => /POSSESS A CAR/.test(sim.goal()) && g.player.form === 'night' && !g.transform, 30);
  const second = g.vehicles.find((v) => v.role === 'parked' && v.insideDeck && v.form === 'car');
  if (!second) {
    return { ok: false, why: 'no car in the deck the second night', reached };
  }

  g.board(second);
  sim.run(3);
  g.onCrossing({ vehicle: second, kind: 'escaped' });
  const finished = sim.playUntil(() => g.randyTalk.enabled, 30);
  at(
    'done',
    finished &&
      sim.goal() === '' &&
      !g.cody.holdForm &&
      !g.keepEscaped &&
      g.skipAfterEating &&
      g.trades.enabled &&
      sim.marks() === '',
  );
  return result();
}

/** Reach a scene through its preceding story beats, leaving its dialogue open. */
const reachScene = (target) => {
  const g = window.__game;
  const sim = window.__sim;
  let step;
  g.events.on('step', (e) => {
    if (e.quest === 'tutorial') {
      step = e.step;
    }
  });
  g.start();
  const truck = g.vehicles.find((v) => v.role === 'player');
  const randy = g.npcs.find('randy');
  if (!truck || !randy) {
    throw new Error('missing tutorial actors');
  }

  const result = () => ({ step: () => step, randy, truck });
  if (target === 'scene') {
    sim.until(() => document.body.classList.contains('dialogue-open'), 5, []);
    return result();
  }

  if (!sim.playUntil(() => step === 'out', 30)) {
    throw new Error('roof did not finish');
  }

  g.clock.hours = 18.99;

  if (target === 'sorry') {
    sim.until(() => step === 'sorry' && document.body.classList.contains('dialogue-open'), 15, []);
    return result();
  }

  if (!sim.playUntil(() => step === 'back', 30)) {
    throw new Error('Randy did not call back');
  }

  g.board(truck);

  if (!sim.playUntil(() => step === 'jump', 5)) {
    throw new Error('pickup did not transform');
  }

  g.onCrossing({ vehicle: truck, kind: 'escaped' });

  if (target === 'tell') {
    sim.until(() => step === 'tell' && document.body.classList.contains('dialogue-open'), 20, []);
    return result();
  }

  if (target === 'imprint') {
    sim.playUntil(() => !!document.querySelector('.signpost.on'), 30);
    return result();
  }

  if (!sim.playUntil(() => step === 'cruise', 40)) {
    throw new Error('imprint did not finish');
  }

  g.clock.hours = 21.99;

  if (target === 'call') {
    sim.until(() => step === 'call' && document.body.classList.contains('dialogue-open'), 15, []);
    return result();
  }

  if (!sim.playUntil(() => step === 'basement', 30)) {
    throw new Error('no basement invitation');
  }

  g.alight();
  sim.run(10);
  const P = g.player.pos.constructor;
  g.player.place(
    new P(randy.pos.x + Math.sin(randy.homeYaw) * 1.6, randy.pos.y, randy.pos.z + Math.cos(randy.homeYaw) * 1.6),
    randy.homeYaw + Math.PI,
  );

  if (target === 'brisket') {
    g.inventory.add('tire');
  }

  sim.run(5);
  g.input.press('KeyF');
  sim.run(3);
  return result();
};

/** A sunrise must cancel scene UI and restore the normal daytime rules. */
const interruptScene = (target) => {
  const g = window.__game;
  const sim = window.__sim;
  const scene = sim.reachScene(target);
  const reached = scene.step() === target;
  const wasOpen = !!document.querySelector('.dialogue.on, .signpost.on');
  g.clock.paused = false;
  g.clock.hours = 7.49;
  const woke = sim.until(() => scene.step() === 'steal', 5, []).ok;
  const released = !scene.randy.held && !g.cutscene && !g.clock.paused && !g.cody.holdForm && !g.keepEscaped;
  const closed = !document.querySelector('.dialogue.on, .signpost.on, .burner.calling');
  // A stale callback must not replace the daytime objective after cancellation.
  document.querySelector('.signpost')?.click();
  document.querySelector('.dialogue')?.click();
  sim.run(60);
  const stayed = scene.step() === 'steal' && /STEAL A CAR/.test(sim.goal());
  return {
    ok: reached && wasOpen && woke && released && closed && stayed && g.skipAfterEating && g.trades.enabled,
    reached,
    wasOpen,
    woke,
    released,
    closed,
    stayed,
  };
};

export const cases = {
  sunriseInterrupts: {
    run: interruptScene,
    inputs: ['scene', 'sorry', 'tell', 'imprint', 'call', 'noWheels', 'brisket'],
  },
};

/** The scene releases only its camera; a later scene's camera survives its exit. */
export function preservesReplacementCamera() {
  const g = window.__game;
  const sim = window.__sim;
  const scene = sim.reachScene('imprint');
  const replacement = { focus: g.player.pos.clone(), zoom: 20 };
  g.cutscene = replacement;
  g.clock.hours = 7.49;
  const woke = sim.until(() => scene.step() === 'steal', 5, []).ok;
  return { ok: woke && g.cutscene === replacement && !document.querySelector('.signpost.on') };
}

export function keepsPlayersCameraChoiceAfterSunrise() {
  const g = window.__game;
  const sim = window.__sim;
  const scene = sim.reachScene('tell');
  // Chase -> auto -> iso, so the choice differs from the default before the jump.
  g.input.press('KeyC');
  sim.run(1);
  g.input.press('KeyC');
  sim.run(1);
  const picked = g.cameraMode;
  g.clock.hours = 7.49;
  const woke = sim.until(() => scene.step() === 'steal', 5, []).ok;
  return { ok: woke && picked === 'iso' && g.cameraMode === picked, picked, after: g.cameraMode };
}

export function restoresPreviousRulesAfterFirstNight() {
  const g = window.__game;
  const sim = window.__sim;
  g.skipAfterEating = false;
  g.trades.enabled = false;
  g.keepEscaped = true;
  const scene = sim.reachScene('imprint');
  g.clock.hours = 7.49;
  const woke = sim.until(() => scene.step() === 'steal', 5, []).ok;
  return { ok: woke && !g.skipAfterEating && !g.trades.enabled && g.keepEscaped && !g.cody.holdForm };
}

/** Shared browser scenario helpers installed on window.__sim before each case. */
export const steps = { goal, marks, playUntil, reachScene };
