// Randy at his fire: his pitch, his shop, and the tire trade. Each case runs in the page (see tools/scenarios.mjs).

/**
 * Place Cody on foot the requested number of meters in front of Randy. Return
 * Randy, or null if he is missing.
 */
const standBy = (meters) => {
  const g = window.__game;
  const sim = window.__sim;
  g.start();
  sim.run(30);
  const r = g.npcs.find('randy');
  if (!r) {
    return null;
  }

  const P = g.player.pos.constructor;
  g.player.place(
    new P(
      r.pos.x + Math.sin(r.homeYaw) * meters,
      r.pos.y,
      r.pos.z + Math.cos(r.homeYaw) * meters,
    ),
    r.homeYaw + Math.PI,
  );
  return r;
};

/**
 * Verify that Randy keeps his coat open while Cody browses, then closes it
 * when Cody leaves.
 */
export function keepsHisCoatOpenWhileCodyBrowses() {
  const g = window.__game;
  const sim = window.__sim;
  const r = sim.standBy(2);
  if (!r) {
    return { ok: false, why: 'no Randy' };
  }

  const pitched = sim.until(() => r.pitch.state.at === 'browsing', 15, []);
  sim.run(30 * 6);
  const stillOpen = r.pitch.state.at === 'browsing' && r.pitching;
  const P = g.player.pos.constructor;
  g.player.place(new P(r.pos.x + 12, r.pos.y, r.pos.z), 0);
  sim.run(10);
  return {
    ok: pitched.ok && stillOpen && !r.pitching,
    browsedAfter: pitched.seconds,
    stillOpenAfter6s: stillOpen,
    shutWhenGone: !r.pitching,
  };
}

/**
 * Verify immediate payment for tires, refusal of another trade during feeding,
 * and a return to roasting.
 */
export function paysForTiresAtOnceThenBurnsThem() {
  const g = window.__game;
  const sim = window.__sim;
  const r = sim.standBy(1.5);
  if (!r) {
    return { ok: false, why: 'no Randy' };
  }

  g.inventory.add('tire', 2);
  const before = g.inventory.count('brisket');
  const taker = g.trades.offer('tire', g.player.pos)?.to;
  const gave = taker ? g.trades.give(taker, 'tire', g.player.pos) : 0;
  const paidAtOnce = g.inventory.count('brisket') - before;
  const busy =
    r.work.state.at === 'feeding' &&
    g.trades.offer('tire', g.player.pos) === null;
  const done = sim.until(() => r.work.state.at === 'idle', 5, []);
  return {
    ok:
      gave === 2 &&
      paidAtOnce === 2 &&
      busy &&
      done.ok &&
      g.trades.offer('tire', g.player.pos)?.to === r,
    gave,
    paidAtOnce,
    busyWhileBurning: busy,
    backToRoastingAfter: done.seconds,
  };
}

/**
 * Verify that a scene can hold Randy and control his coat, then release him to
 * resume pitching.
 */
export function aSceneDirectsHim() {
  const g = window.__game;
  const sim = window.__sim;
  const r = sim.standBy(2);
  if (!r) {
    return { ok: false, why: 'no Randy' };
  }

  r.send({ type: 'held', face: null });
  sim.run(30 * 6);
  const quiet = !r.pitching;
  r.send({ type: 'flash', open: true });
  sim.run(5);
  const flashed = r.pitching;
  r.send({ type: 'released' });
  const back = sim.until(() => r.pitching, 10, []);
  return {
    ok: quiet && flashed && back.ok,
    quietWhileHeld: quiet,
    flashedOnCue: flashed,
    pitchingAgainAfter: back.seconds,
  };
}

/**
 * Use the interact key to start a conversation and trade tires, then verify
 * that the conversation releases Randy.
 */
export function talkToGiveHimTires() {
  const g = window.__game;
  const sim = window.__sim;
  const r = sim.standBy(1.5);
  if (!r) {
    return { ok: false, why: 'no Randy' };
  }

  g.inventory.add('tire', 2);
  const brisket = g.inventory.count('brisket');
  sim.run(2);
  g.input.press('KeyF');
  sim.run(2);
  const talking = g.randyTalk.active && r.held;
  const bubble = document.querySelector('.hud-bubble')?.textContent ?? '';
  g.input.press('KeyF');
  sim.run(2);
  const gave =
    g.inventory.count('tire') === 0 &&
    g.inventory.count('brisket') === brisket + 2;
  const over = sim.until(() => !g.randyTalk.active, 6, []);
  return {
    ok: talking && /GIVE 2 TIRES/.test(bubble) && gave && over.ok && !r.held,
    talking,
    offered: /GIVE 2 TIRES/.test(bubble),
    gave,
    talkOverAfter: over.seconds,
    released: !r.held,
  };
}

/**
 * Verify that carrying tires adds Randy’s objective marker and trading them
 * removes it.
 */
export function tiresPutRandyOnTheMap() {
  const g = window.__game;
  const sim = window.__sim;
  const r = sim.standBy(1.5);
  if (!r) {
    return { ok: false, why: 'no Randy' };
  }

  const marked = () => g.objectives.has('tires-randy');
  sim.run(2);
  const before = marked();
  g.inventory.add('tire', 1);
  sim.run(2);
  const carrying = marked();
  g.input.press('KeyF');
  sim.run(2);
  g.input.press('KeyF');
  sim.run(2);
  const after = marked();
  return {
    ok: !before && carrying && !after && g.inventory.count('tire') === 0,
    before,
    carrying,
    after,
  };
}

/**
 * Disabling RandyTalk prevents the interact key from starting a conversation
 * or trading tires.
 */
export function noTalkDuringTheTutorial() {
  const g = window.__game;
  const sim = window.__sim;
  const r = sim.standBy(1.5);
  if (!r) {
    return { ok: false, why: 'no Randy' };
  }

  g.inventory.add('tire', 1);
  g.randyTalk.enabled = false;
  sim.run(2);
  g.input.press('KeyF');
  sim.run(2);
  return {
    ok: !g.randyTalk.active && !r.held && g.inventory.count('tire') === 1,
    talking: g.randyTalk.active,
  };
}

/**
 * The bound shop redraws after a purchase and inventory actions change when
 * Randy is out of reach.
 */
export function shopAndInventoryFollowState() {
  const g = window.__game;
  const sim = window.__sim;
  const r = sim.standBy(2);
  if (!r) {
    return { ok: false, why: 'no Randy' };
  }

  const slot = r.stock.slotOf('brisket');
  const price = r.stock.price('brisket');
  g.money.cash = price * 2;

  if (!sim.until(() => r.pitch.state.at === 'browsing', 15, []).ok) {
    return { ok: false, why: 'shop never opened' };
  }

  const selector = `.ware-slot[data-id="${slot.id}"]`;
  const before = document.querySelector(selector);
  sim.run(3);
  const stable = document.querySelector(selector) === before;
  g.input.press('Digit2');
  sim.run(3);
  const bought =
    g.inventory.count('brisket') === 1 &&
    g.money.cash === price &&
    slot.count === 127;
  const redrawn =
    document.querySelector(selector) !== before &&
    document.querySelector(`${selector} .ware-count`)?.textContent === '127';
  g.inventory.add('tire');
  sim.run(2);
  const tireTag = () =>
    [...document.querySelectorAll('.inv-item')].find((el) =>
      el.textContent.includes('TIRE'),
    );
  const canGive = tireTag()?.classList.contains('usable');
  const P = g.player.pos.constructor;
  g.player.place(new P(r.pos.x + 12, r.pos.y, r.pos.z), 0);
  sim.run(3);
  const noGive = !tireTag()?.classList.contains('usable');
  const closed = !document.querySelector('.hud-wares.on');
  return {
    ok: stable && bought && redrawn && canGive && noGive && closed,
    stable,
    bought,
    redrawn,
    canGive,
    noGive,
    closed,
  };
}

/**
 * Thrown props keep their item kind through landing and collection; the
 * original returns to its model.
 */
export function throwsNamedProps() {
  const g = window.__game;
  const sim = window.__sim;
  const r = sim.standBy(12);
  if (!r) {
    return { ok: false, why: 'no Randy' };
  }

  const phone = r.prop('burner');
  const parent = phone.parent;
  const pos = phone.position.clone();
  const to = r.pos.clone();
  to.x += 3;
  to.z += 3;
  r.throwing.throw('burner', to);
  const landed = sim.until(() => !r.throwing.active, 8, []);
  const restored =
    phone.parent === parent && phone.position.equals(pos) && !phone.visible;
  const collected = g.junk.update(0, to);
  return {
    ok: landed.ok && restored && collected.includes('burner'),
    landed: landed.ok,
    restored,
    collected,
  };
}

/**
 * Eating advances to the next phase, while tutorial overrides and an active
 * fade prevent extra skips.
 */
export const cases = {
  mealSkipsPhase: {
    inputs: ['day', 'night'],
    run: (phase) => {
      const g = window.__game;
      const sim = window.__sim;
      g.start();
      sim.run(120);
      g.clock.hours = phase === 'day' ? 12 : 22;
      g.inventory.add('brisket', 3);
      g.skipAfterEating = false;
      g.hud.onItemAction('brisket', 'eat');
      sim.run(120);
      const suppressed =
        g.clock.phase === phase && g.inventory.count('brisket') === 2;
      let transitions = 0;
      g.events.on(
        phase === 'day' ? 'nightfall' : 'sunrise',
        () => transitions++,
      );
      g.skipAfterEating = true;
      g.hud.onItemAction('brisket', 'eat');
      g.hud.onItemAction('brisket', 'eat');
      const singleMeal = g.inventory.count('brisket') === 1;
      sim.run(150);
      return {
        ok:
          suppressed &&
          singleMeal &&
          g.clock.phase !== phase &&
          transitions === 1,
        suppressed,
        singleMeal,
        phase: g.clock.phase,
        transitions,
      };
    },
  },
};

/** Shared browser scenario helpers installed on window.__sim before each case. */
export const steps = { standBy };
