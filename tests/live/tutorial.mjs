// The tutorial, played through from the roof chat to the end. Each case runs in the page (see tools/scenarios.mjs).
// Dialogues are talked through with real key presses, times of day are set on the clock, cars are
// boarded for real, and an escape is handed to the game as a crossing (as if off a kicker).

/** Run these with the tutorial on. */
export const tutorial = true;

/** The goal under the clock, as shown. */
const goal = () => document.querySelector('.burner-goal.on')?.textContent?.trim() ?? '';

/** The objective markers up, by label, sorted. */
const marks = () => window.__game.objectives.list.map((o) => o.label).sort().join(',');

/**
 * Frames on, talking through any dialogue or sign that comes up (F), until `done()` or `seconds`
 * pass. Returns whether it got there.
 */
const playUntil = (done, seconds) => {
  const g = window.__game;
  for (let i = 0; i < seconds * 30; i++) {
    if (done()) return true;
    if (i % 6 === 0 && (document.body.classList.contains('dialogue-open') || document.querySelector('.signpost.on'))) g.input.press('KeyF');
    g.frame(1 / 30);
  }
  return done();
};

/** The whole tutorial: each beat in order, and the goal it leaves under the clock. Reports how far it got. */
export function playsThrough() {
  const g = window.__game;
  const sim = window.__sim;
  const reached = [];
  const at = (step, ok, extra = {}) => {
    reached.push({ step, ok, goal: sim.goal(), marks: sim.marks(), ...extra });
    return ok;
  };
  const result = () => ({ ok: reached.every((r) => r.ok) && reached.at(-1)?.step === 'done', reached });

  // the roof: Randy at the window, the clock waiting at half past five, then out to find the badge
  g.start();
  const truck = g.vehicles.find((v) => v.role === 'player');
  const randy = g.npcs.find('randy');
  if (!truck || !randy) return { ok: false, why: 'no pickup or no Randy', reached };
  const opened = sim.playUntil(() => document.body.classList.contains('dialogue-open'), 5);
  const heldAtWindow = randy.held && Math.abs(g.clock.hours - 17.5) < 0.01 && !!g.cutscene;
  if (!at('roof', opened && heldAtWindow && sim.playUntil(() => /FIND YOUR BADGE/.test(sim.goal()), 60) && g.inventory.count('burner') === 1 && sim.marks() === 'YOUR BADGE')) return result();

  // seven o'clock: Randy's gone in a puff, rings to say sorry, then texts him back to the pickup
  g.clock.hours = 18.99;
  if (!at('back', sim.playUntil(() => /GET BACK IN THE PICKUP/.test(sim.goal()), 40) && sim.marks() === 'YOUR BADGE,YOUR PICKUP')) return result();

  // back in: the jump
  g.board(truck);
  if (!at('jump', sim.playUntil(() => /OFF THE ROOF/.test(sim.goal()), 5) && sim.marks() === '')) return result();

  // off a kicker: the first phantom; it idles, Randy rings, the camera shows the imprint, then the joyride
  g.onCrossing({ vehicle: truck, kind: 'escaped' });
  if (!at('cruise', sim.playUntil(() => /SPIN|CAMERAS/.test(sim.goal()), 60), { phantoms: g.garage.phantoms })) return result();

  // ten o'clock: the call, and down to the basement with wheels
  g.clock.hours = 21.99;
  if (!at('basement', sim.playUntil(() => /FIND TIRES/.test(sim.goal()), 40) && sim.marks() === 'RANDY')) return result();

  // no tires: sent back out for some
  g.alight();
  sim.run(10);
  const P = g.player.pos.constructor;
  g.player.place(new P(randy.pos.x + Math.sin(randy.homeYaw) * 1.6, randy.pos.y, randy.pos.z + Math.cos(randy.homeYaw) * 1.6), randy.homeYaw + Math.PI);
  sim.run(5);
  g.input.press('KeyF');
  sim.run(3);
  const turnedAway = sim.playUntil(() => !document.body.classList.contains('dialogue-open'), 20) && /FIND TIRES/.test(sim.goal());
  if (!at('noWheels', turnedAway)) return result();

  // with tires: the brisket, paid for the tires as they go in
  g.inventory.add('tire', 1);
  const brisketBefore = g.inventory.count('brisket');
  sim.run(3);
  g.input.press('KeyF');
  sim.run(3);
  const ate = sim.playUntil(() => /GO BACK OUT/.test(sim.goal()), 40);
  if (!at('outside', ate && g.inventory.count('tire') === 0 && g.inventory.count('brisket') > brisketBefore)) return result();

  // out under the moon: phantom Cody, and the first lessons
  const road = g.traffic.paths[0].sample(0, g.player.pos.clone());
  g.player.place(road, 0);
  if (!at('spook', sim.playUntil(() => /SPOOK SOMEBODY/.test(sim.goal()), 20) && g.player.form === 'night')) return result();

  // a real scare, then raise the dead
  sim.playUntil(() => g.debug.scare(6) >= 0 && /RAISE THE DEAD/.test(sim.goal()), 60);
  if (!at('raise', /RAISE THE DEAD/.test(sim.goal()))) return result();
  const raised = sim.playUntil(() => {
    g.input.press('KeyX');
    return /POSSESS A CAR/.test(sim.goal());
  }, 30);
  if (!at('possess', raised)) return result();

  // possess one in the deck and get it out
  const inDeck = g.vehicles.find((v) => v.role === 'parked' && v.insideDeck && v.form === 'car');
  if (!inDeck) return { ok: false, why: 'no car in the deck', reached };
  g.board(inDeck);
  sim.run(3);
  g.onCrossing({ vehicle: inDeck, kind: 'escaped' });
  sim.run(30);

  // morning: the day job. Steal one, badge it in, park it upstairs and get out
  // (sunrise is at half past seven)
  g.clock.hours = 7.49;
  if (!at('steal', sim.playUntil(() => /STEAL A CAR/.test(sim.goal()), 20))) return result();
  g.alight();
  sim.run(10);
  const street = g.vehicles.find((v) => v.role === 'parked' && !v.insideDeck && v.form === 'car');
  if (!street) return { ok: false, why: 'no car to steal', reached };
  g.board(street);
  if (!at('badge', sim.playUntil(() => /EAST GATE/.test(sim.goal()), 5))) return result();
  g.onCrossing({ vehicle: street, kind: 'logged-in' });
  if (!at('park', sim.playUntil(() => /PARK IN A FREE SPOT/.test(sim.goal()), 5))) return result();
  const spot = g.garage.freeSpots()[0];
  street.place(spot.center.x, spot.center.y, spot.center.z, spot.def.yaw, 0, 0, null);
  street.insideDeck = true;
  sim.run(3);
  g.alight();
  if (!at('tonight', sim.playUntil(() => /WAIT FOR NIGHT/.test(sim.goal()), 5))) return result();

  // night again: possess, out, and that's the whole racket
  g.clock.hours = 18.99;
  // (and phantom Cody again once his outfit's changed: only he possesses)
  sim.playUntil(() => /POSSESS A CAR/.test(sim.goal()) && g.player.form === 'night' && !g.transform, 30);
  const second = g.vehicles.find((v) => v.role === 'parked' && v.insideDeck && v.form === 'car');
  if (!second) return { ok: false, why: 'no car in the deck the second night', reached };
  g.board(second);
  sim.run(3);
  g.onCrossing({ vehicle: second, kind: 'escaped' });
  const finished = sim.playUntil(() => g.randyTalk.enabled, 30);
  at('done', finished && sim.goal() === '' && !g.cody.holdForm && !g.keepEscaped && g.sleepAfterEating && g.tires.enabled && sim.marks() === '');
  return result();
}

/** Reach a scene through its preceding story beats, leaving its dialogue open. */
const reachScene = (target) => {
  const g = window.__game;
  const sim = window.__sim;
  let step;
  g.events.on('step', (e) => { if (e.quest === 'tutorial') step = e.step; });
  g.start();
  const truck = g.vehicles.find((v) => v.role === 'player');
  const randy = g.npcs.find('randy');
  if (!truck || !randy) throw new Error('missing tutorial actors');
  const result = () => ({ step: () => step, randy, truck });
  if (target === 'scene') {
    sim.until(() => document.body.classList.contains('dialogue-open'), 5, []);
    return result();
  }
  if (!sim.playUntil(() => step === 'out', 30)) throw new Error('roof did not finish');
  g.clock.hours = 18.99;
  if (target === 'sorry') {
    sim.until(() => step === 'sorry' && document.body.classList.contains('dialogue-open'), 15, []);
    return result();
  }
  if (!sim.playUntil(() => step === 'back', 30)) throw new Error('Randy did not call back');
  g.board(truck);
  if (!sim.playUntil(() => step === 'jump', 5)) throw new Error('pickup did not transform');
  g.onCrossing({ vehicle: truck, kind: 'escaped' });
  if (target === 'tell') {
    sim.until(() => step === 'tell' && document.body.classList.contains('dialogue-open'), 20, []);
    return result();
  }
  if (target === 'imprint') {
    sim.playUntil(() => !!document.querySelector('.signpost.on'), 30);
    return result();
  }
  if (!sim.playUntil(() => step === 'cruise', 40)) throw new Error('imprint did not finish');
  g.clock.hours = 21.99;
  if (target === 'call') {
    sim.until(() => step === 'call' && document.body.classList.contains('dialogue-open'), 15, []);
    return result();
  }
  if (!sim.playUntil(() => step === 'basement', 30)) throw new Error('no basement invitation');
  g.alight();
  sim.run(10);
  const P = g.player.pos.constructor;
  g.player.place(new P(randy.pos.x + Math.sin(randy.homeYaw) * 1.6, randy.pos.y, randy.pos.z + Math.cos(randy.homeYaw) * 1.6), randy.homeYaw + Math.PI);
  if (target === 'brisket') g.inventory.add('tire');
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
  return { ok: reached && wasOpen && woke && released && closed && stayed && g.sleepAfterEating && g.tires.enabled, reached, wasOpen, woke, released, closed, stayed };
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
  g.sleepAfterEating = false;
  g.tires.enabled = false;
  g.keepEscaped = true;
  const scene = sim.reachScene('imprint');
  g.clock.hours = 7.49;
  const woke = sim.until(() => scene.step() === 'steal', 5, []).ok;
  return { ok: woke && !g.sleepAfterEating && !g.tires.enabled && g.keepEscaped && !g.cody.holdForm };
}

/** Steps shared by this set's cases, installed on window.__sim before each one. */
export const steps = { goal, marks, playUntil, reachScene };
