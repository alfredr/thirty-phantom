// Run browser scenarios from tests/live/ against a running development server.
// Rendering and audio are disabled to reduce startup work. Each scenario gets its own
// page; JOBS controls concurrency (default 3).
//
// Usage: node tools/scenarios.mjs [baseUrl] [set | set/case[/input] | case[/input] ...]
// Set CHROME to override /Applications/Chromium.app/Contents/MacOS/Chromium.
import { readdirSync } from 'node:fs';

import { chromium } from 'playwright-core';

const BASE = process.argv[2]?.startsWith('http') ? process.argv[2] : 'http://localhost:5173/';
const only = process.argv.slice(2).filter((a) => !a.startsWith('http'));
const CHROME = process.env.CHROME ?? '/Applications/Chromium.app/Contents/MacOS/Chromium';
const LIVE = new URL('../tests/live/', import.meta.url);
const JOBS = Math.max(1, Number(process.env.JOBS ?? 3));

/**
 * Discover exported scenario functions in filename order. The optional `steps` export supplies browser helpers under
 * window.__sim; `tutorial = true` enables the tutorial. A `cases` table defines parameterized scenarios as { run,
 * inputs }, with each input run on a separate page.
 */
const cases = [];
for (const file of readdirSync(LIVE)
  .filter((f) => f.endsWith('.mjs'))
  .sort()) {
  const set = file.slice(0, -'.mjs'.length);
  const {
    steps = {},
    tutorial = false,
    cases: parameterized = {},
    ...exports
  } = await import(new URL(file, LIVE).href);
  const add = (name, run, input) => {
    const id = `${set}/${name}`;
    const wanted =
      !only.length ||
      only.some((filter) => [id, name].some((path) => path === filter || path.startsWith(`${filter}/`)));
    if (wanted) {
      cases.push({ id, run, input, steps, tutorial });
    }
  };

  for (const [name, run] of Object.entries(exports)) {
    if (typeof run === 'function') {
      add(name, run);
    }
  }

  for (const [name, { run, inputs }] of Object.entries(parameterized)) {
    for (const input of inputs) {
      add(`${name}/${input}`, run, input);
    }
  }
}

if (!cases.length) {
  console.log(`no live tests match ${only.join(' ')}`);
  process.exit(1);
}

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--headless=new', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
let failed = 0;
const queue = [...cases];
/** Run one scenario in an isolated page and report its result, uncaught browser errors, and excessive movement. */
async function runCase({ id, run, input, steps, tutorial }) {
  const started = Date.now();
  const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
  page.setDefaultTimeout(600000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  if (!tutorial) {
    await page.addInitScript(() => localStorage.setItem('30pc.tutorial', '1'));
  }

  await page.goto(`${BASE}?manual=1&render=0&q=low&curve=0&sound=0&fresh`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game !== undefined, null, { timeout: 600000 });
  await page.evaluate(() => {
    const g = window.__game;
    g.debug.render(false);
    const DT = 1 / 30;
    window.__sim = {
      run: (n) => {
        for (let i = 0; i < n; i++) {
          g.frame(DT);
        }
      },
      /**
       * Advance frames until the condition succeeds or the time limit expires. Track the largest movement in one frame
       * among the watched bodies.
       */
      until: (done, seconds, watch) => {
        let maxJump = 0;
        const last = watch.map((v) => v.pos.clone());
        for (let i = 0; i < seconds / DT; i++) {
          g.frame(DT);
          watch.forEach((v, k) => {
            maxJump = Math.max(maxJump, v.pos.distanceTo(last[k]));
            last[k].copy(v.pos);
          });

          if (done()) {
            return { ok: true, seconds: Math.round(i * DT * 10) / 10, maxJump: Math.round(maxJump * 100) / 100 };
          }
        }

        return { ok: false, seconds, maxJump: Math.round(maxJump * 100) / 100 };
      },
    };
  });
  const helpers = Object.entries(steps).map(([name, fn]) => `${name}: ${fn.toString()}`);
  if (helpers.length) {
    await page.evaluate(`Object.assign(window.__sim, { ${helpers.join(', ')} })`);
  }

  // Report scenario exceptions as failures so the remaining cases can run.
  const booted = Date.now();
  const result = await page
    .evaluate(run, input)
    .catch((e) => ({ ok: false, threw: String(e.message ?? e).split('\n')[0] }));
  // Treat movement above 3 m per frame (90 m/s at this timestep) as an unexpected position jump.
  const jumped = (result.maxJump ?? 0) > 3;
  const ok = result.ok && !jumped && errors.length === 0;
  if (!ok) {
    failed++;
  }

  const secs = (a, b) => Math.round((b - a) / 100) / 10;
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${id} (boot ${secs(started, booted)}s, run ${secs(booted, Date.now())}s) ${JSON.stringify(result)}${errors.length ? ` errors: ${errors.join(' | ')}` : ''}${jumped ? ' (jumped)' : ''}`,
  );
  await page.close();
}

await Promise.all(
  Array.from({ length: Math.min(JOBS, queue.length) }, async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      await runCase(c);
    }
  }),
);
await browser.close();
process.exitCode = failed ? 1 : 0;
