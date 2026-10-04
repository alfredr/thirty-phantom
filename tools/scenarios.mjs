// Runs the live engine tests in tests/live/ against the real game, headless, with rendering off so
// the simulation runs fast. Each file there is a set of cases. A case sets up a situation, runs the
// game until the AI finishes its job or time runs out, and checks it finished without anything
// jumping. Run a dev server first, then:
//   node tools/scenarios.mjs [baseUrl] [set | set/case | case ...]
// It needs Chromium at /Applications/Chromium.app (override with CHROME).
import { readdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const BASE = process.argv[2]?.startsWith('http') ? process.argv[2] : 'http://localhost:5173/';
const only = process.argv.slice(2).filter((a) => !a.startsWith('http'));
const CHROME = process.env.CHROME ?? '/Applications/Chromium.app/Contents/MacOS/Chromium';
const LIVE = new URL('../tests/live/', import.meta.url);

/**
 * Every case in every set, in file order. A set's exported functions are its cases, and its
 * `steps` (if any) are helpers its cases call as window.__sim.<name>().
 */
const cases = [];
for (const file of readdirSync(LIVE).filter((f) => f.endsWith('.mjs')).sort()) {
  const set = file.slice(0, -'.mjs'.length);
  const { steps = {}, ...exports } = await import(new URL(file, LIVE).href);
  for (const [name, run] of Object.entries(exports)) {
    if (typeof run !== 'function') continue;
    const wanted = !only.length || only.some((o) => o === set || o === name || o === `${set}/${name}`);
    if (wanted) cases.push({ id: `${set}/${name}`, run, steps });
  }
}
if (!cases.length) {
  console.log(`no live tests match ${only.join(' ')}`);
  process.exit(1);
}

const browser = await chromium.launch({ executablePath: CHROME, args: ['--headless=new', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
let failed = 0;
for (const { id, run, steps } of cases) {
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
  const helpers = Object.entries(steps).map(([name, fn]) => `${name}: ${fn.toString()}`);
  if (helpers.length) await page.evaluate(`Object.assign(window.__sim, { ${helpers.join(', ')} })`);
  const result = await page.evaluate(run);
  // A body moving more than 3 m in one frame (about 90 m/s) is a jump, not driving.
  const jumped = (result.maxJump ?? 0) > 3;
  const ok = result.ok && !jumped && errors.length === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${JSON.stringify(result)}${errors.length ? ` errors: ${errors.join(' | ')}` : ''}${jumped ? ' (jumped)' : ''}`);
  await page.close();
}
await browser.close();
process.exitCode = failed ? 1 : 0;
