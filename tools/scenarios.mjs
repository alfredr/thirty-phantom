// AI scenarios in the real game, headless, with rendering off so the simulation runs fast.
// Each scenario sets up a situation, runs the game until the AI finishes its job or time runs out,
// and checks it finished without anything jumping. Run a dev server first, then:
//   node tools/scenarios.mjs [baseUrl] [scenario...]
// It needs Chromium at /Applications/Chromium.app (override with CHROME).
import { chromium } from 'playwright-core';

const BASE = process.argv[2]?.startsWith('http') ? process.argv[2] : 'http://localhost:5173/';
const only = process.argv.slice(2).filter((a) => !a.startsWith('http'));
const CHROME = process.env.CHROME ?? '/Applications/Chromium.app/Contents/MacOS/Chromium';

/** Each scenario runs inside the page. It gets the game and a helper that steps frames and watches for jumps. */
const SCENARIOS = {
  /** A driver frightened near the deck turns in, parks in a spot, and gets out and runs. */
  divert: () => {
    const g = window.__game;
    const sim = window.__sim;
    g.start();
    sim.run(200);
    g.debug.night();
    sim.run(90);
    const id = g.debug.divert();
    const car = g.vehicles.find((v) => v.id === id);
    if (!car) return { ok: false, why: 'no traffic car would divert' };
    const peopleBefore = g.crowd.living().length;
    const done = sim.until(() => car.role === 'parked', 90, [car]);
    const spot = g.garage.spots.find((s) => s.occupant === car);
    return {
      ok: done.ok && car.insideDeck && !!spot && g.crowd.living().length > peopleBefore,
      seconds: done.seconds,
      maxJump: done.maxJump,
      inDeck: car.insideDeck,
      spot: spot?.def.id ?? null,
      driverRan: g.crowd.living().length > peopleBefore,
    };
  },

  /** Cody takes a car while its frightened driver is running it for the deck: the run stops, and its spot is free again. */
  divertCarjack: () => {
    const g = window.__game;
    const sim = window.__sim;
    g.start();
    sim.run(200);
    g.debug.night();
    sim.run(90);
    const id = g.debug.divert();
    const car = g.vehicles.find((v) => v.id === id);
    if (!car) return { ok: false, why: 'no traffic car would divert' };
    sim.run(90);
    const spot = g.garage.spots.find((s) => g.claims.holder('spot', s) === car);
    // board() is the scripted way in, past Cody's abilities: at night phantom Cody couldn't steal it out on the street.
    g.board(car);
    sim.run(3);
    const peopleAfter = g.crowd.living().length;
    sim.run(30);
    return {
      ok: g.refuge.count === 0 && car.role === 'player' && !!spot && g.garage.isFree(spot) && g.crowd.living().length === peopleAfter,
      cody: car.role,
      runsLeft: g.refuge.count,
      spotFreed: !!spot && g.garage.isFree(spot),
      maxJump: 0,
    };
  },

  /** A valet takes a car to a deck spot, parks it, and comes back to the stand. */
  valet: () => {
    const g = window.__game;
    const sim = window.__sim;
    g.start();
    sim.run(120);
    const valet = g.valet.crew.find((v) => v.state === 'idle');
    if (!valet) return { ok: false, why: 'no idle valet' };
    const car = g.vehicles
      .filter((v) => v.role === 'parked' && !v.insideDeck)
      .sort((a, b) => a.pos.distanceTo(valet.walker.pos) - b.pos.distanceTo(valet.walker.pos))[0];
    const spot = g.garage.topFree();
    if (!car || !spot) return { ok: false, why: 'no car or no free spot' };
    g.valet.take(valet, car, spot);
    const parked = sim.until(() => car.role === 'parked' && spot.occupant === car, 150, [car]);
    const back = sim.until(() => valet.state === 'idle', 150, []);
    return { ok: parked.ok && back.ok && car.insideDeck, parkSeconds: parked.seconds, backSeconds: back.seconds, maxJump: Math.max(parked.maxJump, back.maxJump) };
  },

  /** A car stopped in a lane holds traffic up; the driver behind honks and pulls round it. */
  pullRound: () => {
    const g = window.__game;
    const sim = window.__sim;
    g.start();
    sim.run(300);
    const blocker = g.vehicles.find((v) => v.role === 'traffic' && Math.abs(v.speed) > 3);
    if (!blocker) return { ok: false, why: 'no moving traffic' };
    blocker.role = 'parked';
    blocker.vel.set(0, 0, 0);
    blocker.speed = 0;
    blocker.markRest();
    let honks = 0;
    g.events.on('honk', () => honks++);
    const started = sim.until(() => g.detours.count > 0, 60, []);
    const finished = sim.until(() => g.detours.count === 0, 60, g.vehicles.filter((v) => v.role === 'traffic' || v.role === 'visitor'));
    return { ok: honks > 0 && started.ok && finished.ok, honks, startSeconds: started.seconds, roundSeconds: finished.seconds, maxJump: finished.maxJump };
  },
};

const browser = await chromium.launch({ executablePath: CHROME, args: ['--headless=new', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
let failed = 0;
for (const [name, scenario] of Object.entries(SCENARIOS)) {
  if (only.length && !only.includes(name)) continue;
  const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
  page.setDefaultTimeout(600000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem('30pc.tutorial', '1'));
  await page.goto(`${BASE}?manual=1&q=low&curve=0&sound=0&fresh`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game !== undefined, null, { timeout: 600000 });
  await page.evaluate(() => {
    const g = window.__game;
    g.debug.render(false);
    const DT = 1 / 30;
    window.__sim = {
      run: (n) => {
        for (let i = 0; i < n; i++) g.frame(DT);
      },
      /** Steps until `done()` or `seconds` pass, tracking the biggest single-frame move of `watch`. */
      until: (done, seconds, watch) => {
        let maxJump = 0;
        const last = watch.map((v) => v.pos.clone());
        for (let i = 0; i < seconds / DT; i++) {
          g.frame(DT);
          watch.forEach((v, k) => {
            maxJump = Math.max(maxJump, v.pos.distanceTo(last[k]));
            last[k].copy(v.pos);
          });
          if (done()) return { ok: true, seconds: Math.round(i * DT * 10) / 10, maxJump: Math.round(maxJump * 100) / 100 };
        }
        return { ok: false, seconds, maxJump: Math.round(maxJump * 100) / 100 };
      },
    };
  });
  const result = await page.evaluate(scenario);
  // A body moving more than 3 m in one frame (about 90 m/s) is a jump, not driving.
  const jumped = (result.maxJump ?? 0) > 3;
  const ok = result.ok && !jumped && errors.length === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(result)}${errors.length ? ` errors: ${errors.join(' | ')}` : ''}${jumped ? ' (jumped)' : ''}`);
  await page.close();
}
await browser.close();
process.exitCode = failed ? 1 : 0;
