// Dev helper: headless screenshots of scripted game states.
// usage: node tools/shot.mjs <url> <outdir> [scenario...]
// Scenarios run __game.debug helpers, advance frames, then capture.
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:4173/?manual=1';
const out = process.argv[3] ?? 'shots';
const only = process.argv.slice(4);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? '/opt/pw-browsers/chromium',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

// advance the game by hand: with ?manual nothing else drives it, so every run steps the same way
const step = async (n, dt = 1 / 30) => {
  await page.evaluate(
    ([n, dt]) => {
      for (let i = 0; i < n; i++) window.__game.frame(dt);
    },
    [n, dt],
  );
};
const snap = async (name) => {
  await page.screenshot({ path: `${out}/${name}.png`, timeout: 180000 });
  console.log('shot', name, JSON.stringify(await page.evaluate(() => window.__game.debug.state())));
};

const scenarios = {
  title: async () => {
    await step(6, 0.1);
    await snap('title');
  },
  day: async () => {
    await page.evaluate(() => window.__game.start());
    await step(12, 0.1);
    await snap('day-start');
  },
  deck: async () => {
    await page.evaluate(() => {
      const g = window.__game;
      g.start();
      g.debug.setHours(13);
      g.debug.teleport(118, 0, 90);
    });
    await step(12, 0.1);
    await snap('day-deck');
  },
  night: async () => {
    await page.evaluate(() => {
      const g = window.__game;
      g.start();
      for (let i = 0; i < 12; i++) g.debug.parkCar(i);
      g.debug.phantom(14);
      g.debug.phantom(16);
      g.debug.setHours(18.9);
      g.debug.teleport(84, 5, 98);
    });
    await step(24, 0.1);
    await snap('night-level2');
  },
  possess: async () => {
    await page.evaluate(() => {
      const g = window.__game;
      g.start();
      for (let i = 0; i < 10; i++) g.debug.parkCar(i);
      g.debug.setHours(21);
      g.debug.teleport(80.4, 5, 89);
    });
    await step(8, 0.1);
    await page.evaluate(() => window.__game.debug.enterNearest());
    await step(7, 1 / 15);
    await snap('possess-mid');
    await step(16, 0.1);
    await snap('possess-done');
  },
  roof: async () => {
    await page.evaluate(() => {
      const g = window.__game;
      g.start();
      for (let i = 20; i < 30; i++) g.debug.parkCar(i);
      g.debug.phantom(22);
      g.debug.setHours(22);
      g.debug.teleport(98, 15, 88);
    });
    await step(12, 0.1);
    await snap('night-roof');
  },
  street: async () => {
    await page.evaluate(() => {
      const g = window.__game;
      g.start();
      g.debug.setHours(23);
      g.debug.teleport(150, 0.25, 140);
    });
    await step(12, 0.1);
    await snap('night-graveyard');
  },
  walk: async () => {
    await page.evaluate(() => {
      const g = window.__game;
      g.start();
      g.debug.setHours(15);
      g.debug.teleport(128, 0.2, 92);
      g.iso.zoomTarget = 14;
      g.iso.zoom = 14;
      g.input.hold('KeyW', true);
    });
    await step(10, 1 / 20);
    await snap('walk-day');
    await page.evaluate(() => {
      const g = window.__game;
      g.debug.setHours(20.5);
      g.player.setForm('night');
    });
    await step(10, 1 / 20);
    await snap('walk-night');
  },
  hero: async () => {
    await page.evaluate(() => {
      const g = window.__game;
      g.start();
      for (let i = 10; i < 20; i++) g.debug.parkCar(i);
      g.debug.phantom(12);
      g.debug.phantom(17);
      g.debug.setHours(21);
      g.debug.teleport(92, 10, 89);
    });
    await step(4, 0.1);
    await page.evaluate(() => window.__game.debug.enterNearest());
    await step(22, 0.1);
    await page.evaluate(() => {
      const g = window.__game;
      g.iso.zoomTarget = 22;
      g.input.hold('KeyW', true);
    });
    await step(10, 1 / 20);
    await snap('hero-truck');
  },
  dusk: async () => {
    await page.evaluate(() => {
      const g = window.__game;
      g.start();
      g.debug.setHours(18.4);
      g.debug.teleport(120, 0, 112);
    });
    await step(12, 0.1);
    await snap('dusk');
  },
};

for (const [name, fn] of Object.entries(scenarios)) {
  if (only.length && !only.includes(name)) continue;
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game !== undefined, null, { timeout: 120000 });
  await fn();
}
console.log(logs.filter((l) => !l.includes('GPU stall')).slice(0, 40).join('\n'));
await browser.close();
