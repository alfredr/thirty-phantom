// Tutorial browser scenarios (see tools/scenarios.mjs). Each case plays the beats through the real game: dialogue and
// pop-ups are advanced with F, and Cody acts through the game API or scripted input.

/** Enable the tutorial when the scenario runner starts each case. */
export const tutorial = true;

/** Read the goal line beneath the clock. */
const goal = () => document.querySelector('.burner-goal.on')?.textContent?.trim() ?? '';

const how = () => document.querySelector('.burner-how.on')?.textContent?.trim() ?? '';

/** Return the visible objective labels in sorted order. */
const marks = () =>
  window.__game.objectives.list
    .map((o) => o.label)
    .sort()
    .join(',');

const line = () =>
  document.body.classList.contains('dialogue-open')
    ? (document.querySelector('.dialogue-text')?.textContent?.trim() ?? '')
    : '';

const popup = () => document.querySelector('.text-pop.on .text-pop-msg')?.textContent?.trim() ?? '';

const thread = () => [...document.querySelectorAll('.burner-msg')].map((m) => m.firstChild?.textContent?.trim() ?? '');

const record = () => {
  const g = window.__game;
  const rec = { steps: [], popups: [], lines: [], step: null, keys: null };
  g.events.on('step', (e) => {
    if (e.quest === 'tutorial') {
      rec.step = e.step;
      rec.steps.push(e.step);
    } else if (e.quest === 'tutorial-keys') {
      rec.keys = e.step;
    }
  });
  window.__rec = rec;
  return rec;
};

const at = () => window.__rec?.step ?? null;

const observe = () => {
  const rec = window.__rec;
  const p = window.__sim.popup();
  if (p && rec.popups.at(-1) !== p) {
    rec.popups.push(p);
  }

  const l = window.__sim.line() || (window.__game.bubble?.line ?? '');
  if (l && rec.lines.at(-1) !== l) {
    rec.lines.push(l);
  }
};

const wantsF = () =>
  document.body.classList.contains('dialogue-open') ||
  !!document.querySelector('.signpost.on') ||
  !!document.querySelector('.text-pop.on.key') ||
  (window.__game.phone.calling &&
    [...document.querySelectorAll('.toast')].some((t) => /ANSWER/.test(t.textContent ?? '')));

/**
 * Advance at 30 FPS until done() succeeds or the time limit expires, pressing F every 0.2 s when it would advance
 * dialogue, signs, info texts or the first call. Pass `{ press: false }` to leave everything unanswered.
 */
const play = (done, seconds, opts = {}) => {
  const g = window.__game;
  const press = opts.press ?? true;
  for (let i = 0; i < seconds * 30; i++) {
    if (done()) {
      return true;
    }

    window.__sim.observe();

    if (press && i % 6 === 0 && window.__sim.wantsF()) {
      g.input.press('KeyF');
    }

    opts.each?.();
    g.frame(1 / 30);
  }

  return done();
};

const gaps = () => {
  const list = window.__game.phone.outreaches;
  let min = Infinity;
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1];
    if (prev.end !== null && !list[i].reply) {
      min = Math.min(min, list[i].start - prev.end);
    }
  }

  return { min: Math.round(min * 10) / 10, n: list.length };
};

const toDoor = (v) => {
  const g = window.__game;
  const P = g.player.pos.constructor;
  const side = v.params.radius + 0.8;
  g.player.place(new P(v.pos.x + Math.cos(v.yaw) * side, v.pos.y, v.pos.z - Math.sin(v.yaw) * side), v.yaw);
};

const inside = (p, v) => {
  const dx = p.x - v.pos.x;
  const dz = p.z - v.pos.z;
  const along = dx * Math.sin(v.yaw) + dz * Math.cos(v.yaw);
  const across = dx * Math.cos(v.yaw) - dz * Math.sin(v.yaw);
  return Math.abs(along) < v.params.length / 2 && Math.abs(across) < v.params.radius && Math.abs(p.y - v.pos.y) < 2;
};

const toRandy = () => {
  const g = window.__game;
  const r = g.npcs.find('randy');
  const P = g.player.pos.constructor;
  g.player.place(
    new P(r.pos.x + Math.sin(r.homeYaw) * 1.6, r.pos.y, r.pos.z + Math.cos(r.homeYaw) * 1.6),
    r.homeYaw + Math.PI,
  );
};

const kicker = () => {
  const g = window.__game;
  const lip = g.objectives.list.find((o) => o.label === 'THE RAMP')?.at;
  const box =
    lip &&
    g.world.collision.solids.find(
      (s) =>
        s.ramp &&
        s.min[0] - 0.1 <= lip.x &&
        s.max[0] + 0.1 >= lip.x &&
        s.min[2] - 0.1 <= lip.z &&
        s.max[2] + 0.1 >= lip.z &&
        Math.abs(s.max[1] - lip.y) < 0.2,
    );
  if (!box) {
    return null;
  }

  const r = box.ramp;
  const ax = r.axis === 'x' ? 0 : 2;
  const across = ax === 0 ? 2 : 0;
  const low = r.dir > 0 ? box.min[ax] : box.max[ax];
  const mid = (box.min[across] + box.max[across]) / 2;
  const P = g.player.pos.constructor;
  const start = new P();
  start.setComponent(ax, low - r.dir * 12);
  start.setComponent(across, mid);
  start.y = r.low;
  const launch = new P(ax === 0 ? r.dir : 0, 0, ax === 0 ? 0 : r.dir);
  return { box, start, launch, yaw: Math.atan2(launch.x, launch.z), lip };
};

const pilot =
  (k, throttle = 1) =>
  (v) => {
    const right = { x: -k.launch.z, z: k.launch.x };
    const side = (v.pos.x - k.start.x) * right.x + (v.pos.z - k.start.z) * right.z;
    let heading = v.yaw - k.yaw;
    heading = Math.atan2(Math.sin(heading), Math.cos(heading));
    return {
      throttle: typeof throttle === 'function' ? throttle(v) : throttle,
      steer: Math.max(-1, Math.min(1, 2.5 * heading - 0.35 * side)),
      hop: false,
      drift: false,
    };
  };

const toasted = (re) => [...document.querySelectorAll('.toast')].some((t) => re.test(t.textContent ?? ''));

/**
 * Play the tutorial like a quick, competent player until the beat `target` begins, or to the end. Each milestone runs
 * its entry in `checks` with the context, records the result, and stops at the first failure.
 */
const reach = (target, checks = {}) => {
  const g = window.__game;
  const sim = window.__sim;
  const rec = window.__rec ?? sim.record();
  const ctx = { log: [], failed: null };
  const here = () => sim.at() === target;
  const check = (name) => {
    const fn = checks[name];
    if (!fn) {
      return true;
    }

    const ok = !!fn(ctx);
    const flags = ok
      ? {}
      : Object.fromEntries(Object.entries(ctx).filter(([, v]) => typeof v === 'boolean' || typeof v === 'string'));
    ctx.log.push({ name, ok, step: sim.at(), goal: sim.goal(), marks: sim.marks(), ...flags });

    if (!ok) {
      ctx.failed = name;
    }

    return ok;
  };

  if (g.debug.state().mode === 'title') {
    g.start();
  }

  const pickup = g.vehicles.find((v) => v.plate === '30-CODY-01');
  const randy = g.npcs.find('randy');
  ctx.pickup = pickup;
  ctx.randy = randy;

  if (!pickup || !randy) {
    ctx.failed = 'actors';
    return ctx;
  }

  if (sim.at() !== 'morning') {
    sim.play(() => sim.line() !== '', 5, { press: false });

    if (here() || !check('roof')) {
      return ctx;
    }

    ctx.paused = true;
    ctx.through = false;

    const opening = [
      'roof',
      'badge',
      'handBadge',
      'toss',
      'keys',
      'phone',
      'gas',
      'pour',
      'allGood',
      'basteLine',
      'flare',
      'uhOh',
    ];
    const watch = () => {
      ctx.paused &&= g.clock.paused || !opening.includes(sim.at());
      ctx.through ||= sim.inside(randy.pos, pickup);
    };

    sim.play(() => sim.at() === 'badge', 30, { each: watch });

    if (here()) {
      return ctx;
    }

    ctx.carried = g.inventory.count('badge') === 1 && pickup.ignition.heldBy(g.inventory.keys);
    sim.play(() => sim.at() === 'handBadge', 30, { each: watch });

    if (here()) {
      return ctx;
    }

    ctx.handed = false;
    ctx.dropped = false;
    sim.play(() => sim.at() === 'toss', 30, {
      each: () => {
        watch();
        const badge = randy.prop('badge');
        const inPalm = badge.parent === g.player.palm && badge.visible;
        ctx.dropped ||= inPalm && pickup.ignition.heldBy('ground') && g.inventory.count('badge') === 0;
        ctx.handed ||= ctx.dropped && randy.reaching > 0;
      },
    });

    if (here()) {
      return ctx;
    }

    ctx.taken = randy.prop('badge').parent !== g.player.palm && randy.prop('badge').visible;
    ctx.thrown = false;
    sim.play(() => sim.at() === 'keys', 30, {
      each: () => {
        watch();
        const badge = randy.prop('badge');
        ctx.thrown ||= /AH MAN/.test(sim.line()) && randy.throwing.active && badge.parent === g.scene && badge.visible;
      },
    });

    if (here()) {
      return ctx;
    }

    ctx.picked = false;
    sim.play(() => sim.at() === 'phone', 30, {
      each: () => {
        watch();
        ctx.picked ||= pickup.ignition.heldBy(randy.keys);
      },
    });

    for (const beat of ['gas', 'pour']) {
      if (here()) {
        return ctx;
      }

      sim.play(() => sim.at() === beat, 30, { each: watch });
    }

    if (here()) {
      return ctx;
    }

    ctx.poured = false;
    sim.play(() => sim.at() === 'allGood', 30, {
      each: () => {
        watch();
        ctx.poured ||= randy.pouring > 0 && randy.pos.distanceTo(pickup.pos) < pickup.params.length;
      },
    });

    ctx.burner = g.inventory.count('burner') === 1;

    for (const beat of ['basteLine', 'flare']) {
      if (here()) {
        return ctx;
      }

      sim.play(() => sim.at() === beat, 30, { each: watch });
    }

    if (here()) {
      return ctx;
    }

    ctx.flared = false;
    sim.play(() => sim.at() === 'uhOh', 30, {
      each: () => {
        watch();
        ctx.flared ||= (randy.fire?.flare ?? 0) > 0.5;
      },
    });

    if (here()) {
      return ctx;
    }

    sim.play(() => sim.at() === 'discovery', 30, { each: watch });

    if (here() || !check('opening')) {
      return ctx;
    }

    const watchRandy = () => {
      ctx.through ||= sim.inside(randy.pos, pickup);
      ctx.ran ||= randy.pace > 3;
    };

    ctx.discovering =
      sim.goal() === 'GET IN YOUR PICKUP' && sim.marks() === 'YOUR PICKUP' && g.vehicleAccess === 'none';
    sim.toDoor(pickup);
    sim.play(() => false, 0.5, { each: watchRandy });
    g.input.press('KeyF');
    ctx.refused = sim.play(() => g.bubble?.line === 'NO KEYS.', 2, { each: watchRandy }) && pickup.role !== 'player';
    sim.play(() => sim.at() === 'wonder', 15, { each: watchRandy });
    ctx.gone = randy.pos.y < 5;

    if (here()) {
      return ctx;
    }

    ctx.solo =
      sim.play(() => g.bubble?.line === 'WHERE DID HE GO?' && g.bubble?.who === 'CODY', 3) &&
      !document.body.classList.contains('dialogue-open');
    ctx.solo &&=
      sim.play(() => g.bubble?.line === '...WAIT. HE HAD MY KEYS!!', 5) &&
      !document.body.classList.contains('dialogue-open');
    sim.play(() => sim.at() === 'keysCall', 10);

    if (here()) {
      return ctx;
    }

    sim.play(() => g.phone.calling, 5, { press: false });
    sim.play(() => false, 0.5, { press: false });
    ctx.asked = window.__sim.toasted(/ANSWER/);
    ctx.notice = false;
    ctx.smoky = false;
    sim.play(() => sim.at() === 'hotwire', 40, {
      each: () => {
        ctx.notice ||= sim.toasted(/RANDY ADDS MOLTEN KEYS TO INVENTORY/);
        ctx.smoky ||= !!document.querySelector('.dialogue-portrait.left .portrait-look.on');
      },
    });

    if (here() || !check('discovery')) {
      return ctx;
    }

    const other = g.vehicles.find((v) => v !== pickup && v.role === 'parked');
    g.codyRide.enter(other);
    ctx.onlyPickup = other.role !== 'player' && g.vehicleAccess === pickup;
    sim.toDoor(pickup);
    sim.play(() => false, 0.5);
    g.input.press('KeyF');
    sim.play(() => pickup.role === 'player', 3);
    ctx.waiting = !pickup.engineOn && /HOTWIRE YOUR PICKUP/.test(sim.goal());
    g.input.press('KeyG');
    const parked = pickup.pos.clone();
    let crept = 0;
    let since = 0;
    ctx.wait = null;

    const creep = () => {
      since += 1 / 30;

      if (pickup.form === 'car') {
        crept = Math.max(crept, pickup.pos.distanceTo(parked));
      } else {
        ctx.wait ??= Math.round(since * 10) / 10;
        g.input.hold('KeyW', false);
      }
    };

    g.input.hold('KeyW', true);

    for (const beat of ['sorry', 'weird', 'ramp']) {
      sim.play(() => sim.at() === beat || sim.at() === 'ramp', 60, { each: creep });

      if (here()) {
        g.input.hold('KeyW', false);
        return ctx;
      }
    }

    ctx.sorry = rec.popups.some((p) => /THINGS GET A LITTLE WEIRD/.test(p));
    ctx.swept = sim.play(
      () => pickup.form === 'truck' && g.clock.phase === 'night' && !g.transform && pickup.grounded,
      20,
      { each: creep },
    );
    g.input.hold('KeyW', false);
    ctx.stalled = crept < 0.5 && rec.lines.includes('...WHY DOES IT SMELL LIKE BARBECUE?');
    ctx.prompt = ctx.wait !== null && ctx.wait > 10 && ctx.wait < 16;

    if (!check('hotwire')) {
      return ctx;
    }

    g.input.press('KeyF');
    sim.play(() => false, 0.5, { press: false });
    ctx.locked = pickup.role === 'player' && window.__sim.toasted(/DOORS WON'T OPEN/);
    ctx.k = sim.kicker();

    if (!check('ramp')) {
      return ctx;
    }

    g.resetVehicle(pickup, { pos: ctx.k.start, yaw: ctx.k.yaw });
    g.autopilot = sim.pilot(ctx.k);
    ctx.jumped = sim.play(() => sim.at() === 'landing', 20);
    g.autopilot = null;

    if (here() || !check('jump')) {
      return ctx;
    }

    ctx.ledger = !document.querySelector('.hud-sign.held');

    for (const beat of ['tell', 'imprint']) {
      sim.play(() => sim.at() === beat, 90);

      if (here()) {
        return ctx;
      }
    }

    ctx.signed = sim.play(() => !!document.querySelector('.signpost.on'), 30);
    ctx.paused = g.clock.paused;
    sim.play(() => sim.at() === 'camera' || sim.at() === 'ghost', 60);

    if (here() || !check('phantom')) {
      return ctx;
    }

    ctx.cameraGoal = sim.play(() => /TRY THE CAMERAS \(1\/2\)/.test(sim.goal()), 15);
    g.input.press('KeyF');
    sim.play(() => false, 0.5, { press: false });
    ctx.stillLocked = pickup.role === 'player';

    for (let i = 0; i < 3 && sim.at() === 'camera'; i++) {
      g.input.press('KeyC');
      sim.play(() => sim.at() !== 'camera', 0.3);
    }

    ctx.cameras = sim.at() === 'ghost';

    if (here() || !check('camera')) {
      return ctx;
    }

    ctx.ghostMarked = /GHOST/.test(sim.marks());
    g.ghast = 0.5;
    ctx.ghost = sim.play(() => sim.at() === 'boost', 5);

    if (here()) {
      return ctx;
    }

    g.input.hold('KeyB', true);
    ctx.boost = sim.play(() => sim.at() === 'soul', 5);
    g.input.hold('KeyB', false);

    if (here() || !check('joyride')) {
      return ctx;
    }

    sim.play(() => sim.at() === 'basementCall', 120);

    if (here()) {
      return ctx;
    }

    for (let i = g.junk.parts.length - 1; i >= 0; i--) {
      g.junk.remove(i);
    }

    ctx.keycap = false;
    sim.play(() => sim.at() === 'tires', 120, {
      each: () => {
        ctx.keycap ||= /GETS YOU OUT/.test(sim.line()) && !!document.querySelector('.dialogue-text kbd');
      },
    });
    ctx.logged = [...document.querySelectorAll('.call-lines p')].some(
      (p) => /GETS YOU OUT/.test(p.textContent ?? '') && !/[{}]/.test(p.textContent ?? ''),
    );

    if (here()) {
      return ctx;
    }

    ctx.unlocked = g.doorLock === null;
    ctx.errand = sim.goal() === 'SMASH A CAR FOR TIRES' && sim.marks() === 'PARKED CAR';
    g.alight();
    sim.play(() => false, 1);
    sim.toRandy();
    sim.play(() => false, 1);
    g.input.press('KeyF');
    sim.play(() => sim.at() === 'noWheels', 3);
    sim.play(() => sim.at() === 'tires', 15);
    ctx.noWheels = rec.lines.includes('NO WHEELS? GO GET ME SOME.');
    g.inventory.add('tire', 1);
    sim.play(() => sim.at() === 'bring', 3);

    if (here() || !check('tires')) {
      return ctx;
    }

    ctx.brisket = g.inventory.count('brisket');
    g.input.press('KeyF');
    sim.play(() => sim.at() === 'moonlight', 40);
    ctx.fed = g.inventory.count('tire') === 0 && g.inventory.count('brisket') > ctx.brisket;

    if (here() || !check('brisket')) {
      return ctx;
    }

    g.player.place(g.traffic.paths[0].sample(0, g.player.pos.clone()), 0);
    sim.play(() => sim.at() === 'rules', 10);

    if (here()) {
      return ctx;
    }

    ctx.night = sim.play(() => sim.at() === 'spook' && g.player.form === 'night', 60);

    if (here() || !check('phantomCody')) {
      return ctx;
    }

    sim.play(() => g.debug.scare(6) >= 0 && sim.at() === 'raise', 60);

    if (here()) {
      return ctx;
    }

    sim.play(() => {
      g.input.press('KeyX');
      return sim.at() === 'possess';
    }, 60);

    if (here()) {
      return ctx;
    }

    const inDeck = g.vehicles.find((v) => v.role === 'parked' && v.insideDeck && v.form === 'car');
    g.board(inDeck);
    sim.play(() => sim.at() === 'escape', 10);

    if (here()) {
      return ctx;
    }

    g.onCrossing({ vehicle: inDeck, kind: 'escaped' });
    ctx.rested = sim.play(() => sim.at() === 'rest', 10);
    ctx.part1 = localStorage.getItem('30pc.tutorial.part1') === '1';

    if (here() || !check('escape')) {
      return ctx;
    }

    ctx.morning = sim.play(() => sim.at() === 'morning', 200);

    if (here()) {
      return ctx;
    }
  }

  sim.play(() => g.player.form === 'day' && !g.transform, 10);
  g.alight();
  sim.play(() => false, 1);
  const street = g.vehicles.find((v) => v.role === 'parked' && !v.insideDeck && v.form === 'car' && v !== pickup);
  g.board(street);
  sim.play(() => sim.at() === 'gate', 5);

  if (here()) {
    return ctx;
  }

  g.onCrossing({ vehicle: street, kind: 'logged-in' });
  sim.play(() => sim.at() === 'park', 5);

  if (here()) {
    return ctx;
  }

  const spot = g.garage.freeSpots()[0];
  street.place(spot.center.x, spot.center.y, spot.center.z, spot.def.yaw, 0, 0, null);
  street.insideDeck = true;
  sim.play(() => false, 0.2);
  g.alight();
  ctx.tonight = sim.play(() => sim.at() === 'tonight', 5);

  if (here() || !check('day2')) {
    return ctx;
  }

  ctx.night2 = sim.play(() => sim.at() === 'night2' && g.player.form === 'night' && !g.transform, 120);

  if (here()) {
    return ctx;
  }

  const second = g.vehicles.find((v) => v.role === 'parked' && v.insideDeck && v.form === 'car');
  g.board(second);
  sim.play(() => false, 1);
  g.onCrossing({ vehicle: second, kind: 'escaped' });
  ctx.over = sim.play(() => sim.at() === 'over', 120);
  check('over');
  return ctx;
};

/** Shared browser scenario helpers installed on window.__sim before each case. */
export const steps = {
  goal,
  how,
  marks,
  line,
  popup,
  thread,
  record,
  at,
  observe,
  wantsF,
  play,
  gaps,
  toDoor,
  toRandy,
  inside,
  kicker,
  pilot,
  toasted,
  reach,
};

/** Play the whole tutorial like a player, checking each beat's state changes and the 30 s outreach spacing. */
export function playsThrough() {
  const g = window.__game;
  const sim = window.__sim;
  const rec = sim.record();
  let early = 0;
  g.events.on('swallowed', () => {
    if (!['ghost', 'boost'].includes(sim.at()) && rec.steps.indexOf('ghost') < 0) {
      early++;
    }
  });
  const ctx = sim.reach('over', {
    roof: ({ pickup, randy }) =>
      sim.at() === 'roof' &&
      pickup.role === 'player' &&
      pickup.ignition.heldBy('ignition') &&
      g.inventory.count('burner') === 0 &&
      g.vehicleAccess === 'none' &&
      g.clock.paused &&
      Math.abs(g.clock.hours - 17.5) < 0.01 &&
      !!document.querySelector('.hud-sign.held') &&
      randy.held &&
      /BADGE WON'T SCAN/.test(sim.line()),
    opening: (c) =>
      c.paused &&
      c.carried &&
      c.dropped &&
      c.handed &&
      c.taken &&
      c.picked &&
      c.thrown &&
      c.burner &&
      c.poured &&
      c.flared &&
      !c.through &&
      c.pickup.ignition.heldBy(c.randy.keys) &&
      g.inventory.keys.held.size === 0 &&
      [
        "AND I'M ON E. PERFECT.",
        'I KNOW THESE SCANNERS. HAND ME YOUR BADGE.',
        "THAT'S NOT...",
        'ALL GOOD!',
        'TIME TO BASTE.',
        'UH OH...',
      ].every((l) => rec.lines.includes(l)),
    discovery: (c) => {
      const slot = c.randy.stock.slotOf('moltenKeys');
      const ware = g.shop.view(c.randy).slots.find((s) => s.id === slot?.id);
      return (
        c.discovering &&
        !c.through &&
        c.ran &&
        c.gone &&
        c.refused &&
        c.solo &&
        c.asked &&
        c.notice &&
        c.smoky &&
        ware?.unavailable === 'TOO HOT' &&
        c.pickup.ignition.heat === 'molten' &&
        c.pickup.ignition.heldBy(c.randy.keys) &&
        rec.lines.includes('GOOD NEWS: YOU CAN HAVE THEM BACK.') &&
        rec.lines.includes('BAD NEWS: MIGHT BE A SECOND. I DROPPED THEM IN THE SMOKER.')
      );
    },
    hotwire: (c) =>
      c.sorry &&
      c.stalled &&
      c.prompt &&
      c.onlyPickup &&
      c.waiting &&
      c.swept &&
      g.cameraMode === 'chase' &&
      Math.abs(g.clock.hours - 19) < 0.2,
    ramp: (c) => c.locked && !!c.k && sim.goal() === 'LEAVE THE DECK VIA THE RAMP' && sim.marks() === 'THE RAMP',
    jump: (c) => c.jumped && g.garage.phantoms === 1,
    phantom: (c) =>
      c.ledger &&
      c.signed &&
      c.paused &&
      rec.lines.includes("HEH. NO SWIPE OUT, NO EXIT ON THE LOG. TRUCK'S YOURS TONIGHT."),
    camera: (c) => c.cameraGoal && c.stillLocked && c.cameras && early === 0 && g.ghast === 0,
    joyride: (c) => c.ghostMarked && c.ghost && c.boost,
    tires: (c) =>
      c.keycap &&
      c.logged &&
      c.unlocked &&
      c.errand &&
      c.noWheels &&
      sim.goal() === 'BRING THE TIRES TO RANDY' &&
      sim.marks() === 'RANDY',
    brisket: (c) => c.fed && !!c.randy.stock.slotOf('moltenKeys'),
    phantomCody: (c) => c.night && !g.cody.holdForm && !g.cody.can('steal') && g.cody.can('summon'),
    escape: (c) => c.rested && c.part1,
    day2: (c) => c.morning && c.tonight && g.player.form === 'day',
    over: (c) =>
      c.night2 &&
      c.over &&
      sim.goal() === '' &&
      !g.cody.holdForm &&
      !g.keepEscaped &&
      g.skipAfterEating &&
      g.trades.enabled &&
      g.randyTalk.enabled &&
      g.doorLock === null &&
      !g.clock.paused &&
      localStorage.getItem('30pc.tutorial') === '1',
  });
  const gaps = sim.gaps();
  return {
    ok: !ctx.failed && ctx.log.at(-1)?.name === 'over' && gaps.min >= 30,
    gaps,
    failed: ctx.failed,
    log: ctx.log.filter((l) => !l.ok),
    steps: rec.steps.length,
    hotwireToTransform: ctx.wait,
  };
}

const idles = (beat) => {
  const g = window.__game;
  const sim = window.__sim;
  const rec = sim.record();
  const ctx = sim.reach(beat);
  if (ctx.failed || sim.at() !== beat) {
    return { ok: false, why: `did not reach ${beat}`, at: sim.at(), failed: ctx.failed };
  }

  const limit = { hotwire: 18.5, ghost: 21, tires: 22.5, raise: 1.5, morning: 10 }[beat];
  const start = g.clock.hours;
  let most = 0;
  const ahead = (h) => (((h - start) % 24) + 24) % 24;
  const stayed = !sim.play(() => {
    most = Math.max(most, ahead(g.clock.hours));
    return sim.at() !== beat;
  }, 480);
  const fun = rec.popups.findIndex((p) => p.startsWith('YOU KNOW WHAT WOULD BE FUN?'));
  const second = beat === 'ghost' ? 'WHERE CAN I FIND A GHOST?' : "YOU KNOW, TIME DOESN'T FLY";
  const flies = rec.lines.findIndex((l) => l.startsWith(second));
  const limbo = rec.lines.findIndex((l) => l.startsWith("LOOK. WE'RE STUCK IN THIS LIMBO"));
  const still = rec.popups.some((p) => p.startsWith('STILL HERE. STILL LIMBO.'));
  const gaps = sim.gaps();
  return {
    ok:
      stayed &&
      fun >= 0 &&
      flies >= 0 &&
      limbo > flies &&
      still &&
      most < ahead(limit) &&
      ahead(limit) - ahead(g.clock.hours) < 0.01 &&
      gaps.min >= 30,
    stayed,
    fun: rec.popups[fun],
    flies,
    limbo,
    still,
    start: Math.round(start * 100) / 100,
    end: Math.round(g.clock.hours * 100) / 100,
    pace: g.clock.pace,
    gaps,
  };
};

export function missesTheRamp() {
  const g = window.__game;
  const sim = window.__sim;
  const ctx = sim.reach('ramp');
  const { pickup } = ctx;
  sim.play(() => pickup.form === 'truck' && !g.transform && pickup.grounded, 20);
  const k = sim.kicker();
  if (!k) {
    return { ok: false, why: 'no ramp marker' };
  }

  let crossings = 0;
  let resets = 0;
  g.events.on('crossing', () => crossings++);
  const poses = [];
  g.events.on('reset', () => {
    resets++;
    poses.push({ onRamp: onRamp(), speed: Math.abs(pickup.speed), facing: Math.cos(pickup.yaw - k.yaw) });
  });
  const onRamp = () =>
    pickup.pos.x > k.box.min[0] &&
    pickup.pos.x < k.box.max[0] &&
    pickup.pos.z > k.box.min[2] &&
    pickup.pos.z < k.box.max[2];
  const missed = () => {
    const before = resets;
    const ok = sim.play(() => resets > before || sim.at() !== 'ramp', 30);
    sim.play(() => !g.fading, 3);
    return ok && sim.at() === 'ramp';
  };

  const stopOnRamp = () => {
    g.resetVehicle(pickup, { pos: k.start, yaw: k.yaw });
    g.autopilot = sim.pilot(k, () => (onRamp() ? -1 : 0.6));
    const ok = missed();
    g.autopilot = null;
    return ok;
  };

  const first = stopOnRamp();
  const back = poses.at(-1);
  const near = !!back && !back.onRamp && back.speed < 0.5 && back.facing > 0.98;
  const howShown = /FULL SPEED UP THE RAMP/.test(sim.how());
  const second = stopOnRamp();
  const P = pickup.pos.constructor;
  const mid = new P((k.box.min[0] + k.box.max[0]) / 2, 0, (k.box.min[2] + k.box.max[2]) / 2);
  mid.y = g.world.collision.groundAt(mid.x, mid.z, k.box.max[1] + 0.5, 1);
  g.resetVehicle(pickup, { pos: mid, yaw: k.yaw });
  const third = missed();
  const ideas = sim.toasted(/THE TRUCK'S GOT IDEAS/) || sim.play(() => sim.toasted(/THE TRUCK'S GOT IDEAS/), 3);
  const forced = sim.play(() => sim.at() === 'landing', 30);
  sim.play(() => sim.at() === 'tell', 15);
  return {
    ok: first && near && howShown && second && third && ideas && forced && g.garage.phantoms === 1 && crossings === 1,
    first,
    near,
    howShown,
    second,
    third,
    ideas,
    forced,
    phantoms: g.garage.phantoms,
    crossings,
    resets,
    back,
  };
}

export function assistClearsTheGap() {
  const g = window.__game;
  const sim = window.__sim;
  const ctx = sim.reach('ramp');
  const { pickup } = ctx;
  sim.play(() => pickup.form === 'truck' && !g.transform && pickup.grounded, 20);
  const k = sim.kicker();
  let resets = 0;
  g.events.on('reset', () => resets++);
  const onRamp = () =>
    pickup.pos.x > k.box.min[0] &&
    pickup.pos.x < k.box.max[0] &&
    pickup.pos.z > k.box.min[2] &&
    pickup.pos.z < k.box.max[2];
  for (let i = 0; i < 2; i++) {
    g.resetVehicle(pickup, { pos: k.start, yaw: k.yaw });
    g.autopilot = sim.pilot(k, () => (onRamp() ? -1 : 0.6));
    const before = resets;
    sim.play(() => resets > before, 30);
    g.autopilot = null;
    sim.play(() => !g.fading, 3);
  }

  g.resetVehicle(pickup, { pos: k.start, yaw: k.yaw });
  g.autopilot = sim.pilot(k, () => (onRamp() ? 0 : 0.3));
  let fastest = 0;
  const cleared = sim.play(() => {
    fastest = Math.max(fastest, Math.abs(pickup.speed));
    return sim.at() === 'landing';
  }, 20);
  g.autopilot = null;
  return {
    ok: cleared && fastest > 20 && g.garage.phantoms === 1,
    cleared,
    fastest: Math.round(fastest),
    resets,
    phantoms: g.garage.phantoms,
  };
}

export function truckGetsIdeas() {
  const g = window.__game;
  const sim = window.__sim;
  sim.reach('ramp');
  const ideas = sim.play(() => sim.toasted(/THE TRUCK'S GOT IDEAS/), 110);
  const cutscene = sim.play(() => !!g.cutscene && !!g.autopilot, 3);
  const jumped = sim.play(() => sim.at() === 'landing', 30);
  sim.play(() => sim.at() === 'tell', 15);
  return { ok: ideas && cutscene && jumped && !g.autopilot && g.garage.phantoms === 1, ideas, cutscene, jumped };
}

export function fallsOffTheRoof() {
  const g = window.__game;
  const sim = window.__sim;
  const rec = sim.record();
  const { pickup } = sim.reach('discovery');
  const P = g.player.pos.constructor;
  const at = g.player.pos.clone();
  while (g.garage.inFootprint(at)) {
    at.x += 1;
  }

  g.player.place(new P(at.x + 3, at.y, at.z), 0);
  g.player.grounded = false;
  const fell = sim.play(() => g.player.pos.y < 5, 10);
  const back = sim.play(() => g.player.pos.y > 15 && !g.fading, 15);
  const door = g.player.pos.distanceTo(pickup.pos) < pickup.params.radius + 2.5;
  sim.play(() => false, 1);
  sim.play(() => rec.lines.includes('...THAT WAS DUMB.'), 10);
  const dumb = rec.lines.includes('...THAT WAS DUMB.');
  const roof = ['discovery', 'wonder', 'keysCall', 'hotwire'].includes(sim.at());
  return { ok: fell && back && door && dumb && roof, fell, back, door, dumb, at: sim.at() };
}

export function gateOnTheRoof() {
  const g = window.__game;
  const sim = window.__sim;
  const rec = sim.record();
  const { pickup } = sim.reach('ramp');
  sim.play(() => pickup.form === 'truck' && !g.transform && pickup.grounded, 20);
  const k = sim.kicker();
  g.resetVehicle(pickup, { pos: k.start, yaw: k.yaw });
  const barred = g.world.collision.solids.some(
    (s) => s.enabled && !s.ramp && s.max[1] - s.min[1] > 3.9 && s.max[1] - s.min[1] < 4.1,
  );
  g.onCrossing({ vehicle: pickup, kind: 'logged-out' });
  const texted = sim.play(() => rec.popups.some((p) => /NOT THE GATE, KID. THE GATE SAW THAT/.test(p)), 60);
  return { ok: barred && texted && sim.at() === 'ramp', barred, texted, at: sim.at() };
}

export function ghostTrailIsReachable() {
  const g = window.__game;
  const sim = window.__sim;
  const { pickup } = sim.reach('ghost');
  g.ghast = 0;
  const P = pickup.pos.constructor;
  const target = new P();
  const near = () => g.activeGhosts().filter((p) => p.distanceTo(pickup.pos) < 45).length;
  const nearby = near();
  g.autopilot = (v) => {
    g.nearestGhost(v.pos, target);
    let heading = Math.atan2(target.x - v.pos.x, target.z - v.pos.z) - v.yaw;
    heading = Math.atan2(Math.sin(heading), Math.cos(heading));
    return { throttle: 0.8, steer: Math.max(-1, Math.min(1, -2 * heading)), hop: false, drift: false };
  };

  let t = 0;
  const done = sim.play(() => sim.at() !== 'ghost', 8, { each: () => (t += 1 / 30) });
  g.autopilot = null;
  return { ok: nearby >= 3 && done && t > 0.5 && t < 6, nearby, done, seconds: Math.round(t * 10) / 10 };
}

export function grabsTheTires() {
  const g = window.__game;
  const sim = window.__sim;
  const rec = sim.record();
  const { pickup } = sim.reach('tires');
  const cars = g.vehicles.filter((v) => v.role === 'parked' && v !== pickup && v.form === 'car');
  for (const car of cars) {
    if (g.looseItems('tire').length) {
      break;
    }

    for (let i = 0; i < 4; i++) {
      g.junk.hit(car, car.pos, 30);
    }
  }

  sim.play(() => g.looseItems('tire').length > 0 && sim.at() === 'grab', 10);
  sim.play(() => false, 1);
  const loose = g.looseItems('tire').filter((p) => p.distanceTo(pickup.pos) < 150).length;
  const pins = g.objectives.pins.filter((o) => o.color === '#ffb84a').length;
  const grab = sim.goal() === 'GRAB THE TIRES' && sim.marks() === 'TIRE';
  g.alight();
  sim.play(() => false, 0.5);
  const tire = g.looseItems('tire')[0];
  g.player.place(tire.clone(), 0);
  const got = sim.play(() => sim.at() === 'bring', 5);
  sim.play(() => false, 0.5);
  const after = g.objectives.pins.length;
  const lesson = sim.play(() => /OPENS YOUR PHONE/.test(sim.popup()), 60, { press: false });
  const caps = [...document.querySelectorAll('.text-pop.on .text-pop-msg kbd')].map((k) => k.textContent);
  return {
    ok: loose > 0 && pins === loose && grab && got && after === 0 && lesson && caps.includes('M'),
    loose,
    pins,
    grab,
    got,
    after,
    lesson,
    caps,
  };
}

export function ghostsPinnedOnTheMap() {
  const g = window.__game;
  const sim = window.__sim;
  const { pickup } = sim.reach('ghost');
  g.ghast = 0;
  pickup.vel.set(0, 0, 0);
  sim.play(() => false, 1);
  const near = g.activeGhosts().filter((p) => p.distanceTo(pickup.pos) < 150).length;
  const pinned = g.objectives.pins.length;
  const arrows = g.objectives.list.filter((o) => o.kind === 'optional' && o.label === 'GHOST').length;
  g.ghast = 0.5;
  sim.play(() => sim.at() !== 'ghost', 3);
  sim.play(() => false, 0.5);
  const after = g.objectives.pins.length;
  return { ok: near > 0 && pinned === near && arrows === 1 && after === 0, near, pinned, arrows, after };
}

export function hintNeverShowsAfterTheAction() {
  const g = window.__game;
  const sim = window.__sim;
  const rec = sim.record();
  sim.reach('ghost');
  g.ghast = 0;
  sim.play(() => /SEE THEM GHOSTS/.test(sim.popup()), 40, { press: false });
  g.ghast = 0.4;
  const held = sim.play(() => sim.at() === 'boost', 3) && !sim.popup();
  g.input.hold('KeyB', true);
  const done = sim.play(() => sim.at() !== 'boost', 3);
  g.input.hold('KeyB', false);
  sim.play(() => false, 40);
  const shown = (re) => rec.popups.some((p) => re.test(p)) || sim.thread().some((t) => re.test(t));
  const seen = shown(/FEEL THAT\? GHOSTS IN THE TANK/);
  return { ok: held && done && !seen, held, done, seen };
}

export function staleOutreachIsDropped() {
  const g = window.__game;
  const sim = window.__sim;
  const rec = sim.record();
  const { pickup } = sim.reach('ramp');
  sim.play(() => pickup.form === 'truck' && !g.transform && pickup.grounded, 20);
  const k = sim.kicker();
  g.resetVehicle(pickup, { pos: k.start, yaw: k.yaw });
  g.onCrossing({ vehicle: pickup, kind: 'logged-out' });
  const gate = sim.play(() => /NOT THE GATE/.test(sim.popup()), 40, { press: false });
  const queued = sim.play(() => g.phone.pending >= 2, 60, { press: false });
  g.resetVehicle(pickup, { pos: k.start, yaw: k.yaw });
  g.autopilot = sim.pilot(k);
  const jumped = sim.play(() => sim.at() !== 'ramp', 20, { press: false });
  g.autopilot = null;
  sim.play(() => false, 90);
  const late = [...rec.popups, ...sim.thread()].some((p) => /FLY OFF THAT RAMP/.test(p));
  return { ok: gate && queued && jumped && !late, gate, queued, jumped, late, pending: g.phone.pending };
}

export function meltedKeysPayoff() {
  const g = window.__game;
  const sim = window.__sim;
  localStorage.setItem('30pc.tutorial.part1', '1');
  const rec = sim.record();
  g.start();
  const morning = sim.at() === 'morning' && g.clock.day === 2 && g.player.form === 'day';
  const { pickup, randy } = sim.reach('night2');
  const original = pickup.ignition;
  const hot = original.heat === 'molten' && original.heldBy(randy.keys) && !!randy.stock.slotOf('moltenKeys');
  const swing = sim.play(
    () => rec.popups.includes('KEYS COOLED OFF. SWING BY.') || sim.thread().includes('KEYS COOLED OFF. SWING BY.'),
    120,
  );
  const optional = g.objectives.list.some((o) => o.id === 'tutorial-keys' && o.kind === 'optional');
  g.alight();
  sim.play(() => false, 1);
  sim.toRandy();
  sim.play(() => false, 1);
  g.input.press('KeyF');
  const told = sim.play(() => rec.lines.includes("TOLD YOU YOU COULD HAVE 'EM BACK."), 10);
  sim.play(() => rec.keys === 'over', 10);
  const melted =
    original.heat === 'melted' &&
    original.heldBy(g.inventory.keys) &&
    !randy.stock.slotOf('moltenKeys') &&
    !!document.querySelector('.inv-item') &&
    [...document.querySelectorAll('.inv-item')].some((el) => /MELTED KEYS/.test(el.textContent ?? ''));
  original.hotwired = false;
  pickup.place(pickup.pos.x, pickup.pos.y, pickup.pos.z, pickup.yaw, 0, 0, null);
  g.board(pickup);
  sim.play(() => false, 0.5);
  const dead = pickup.role === 'player' && !pickup.ignition.ready && original.heldBy(g.inventory.keys);
  return {
    ok: morning && hot && swing && optional && told && melted && dead,
    morning,
    hot,
    swing,
    optional,
    told,
    melted,
    dead,
  };
}

export const cases = {
  idlesAtBeat: {
    run: idles,
    inputs: ['hotwire', 'ghost', 'tires', 'raise', 'morning'],
  },
};
