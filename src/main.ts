import '@fontsource/anton';
import '@fontsource/bangers';
import '@fontsource/creepster';
import { AssetRegistry } from './assets/asset-registry';
import { SOUND_ON } from './audio/flags';
import { urlFlag, urlParam } from './core/url-flags';
import { Game } from './game/game';
import { SaveGame } from './game/save';
import { Tutorial } from './game/tutorial';
import { TouchControls, wantsTouch } from './ui/touch-controls';
import { generateLevel } from './world/generate-level';
import { parseLevel, type LevelData } from './world/level-data';

/** Fonts must be ready before sign/livery canvases are drawn. */
async function loadFonts(): Promise<void> {
  await Promise.all(['64px "Creepster"', '64px "Anton"', '64px "Bangers"'].map((f) => document.fonts.load(f)));
}

/** Load a JSON level from ?level=<url>, or generate the default city. */
async function loadLevel(): Promise<LevelData> {
  const url = urlParam('level');
  if (url) {
    try {
      const r = await fetch(url);
      if (r.ok) return parseLevel(await r.json());
      console.warn(`[level] ${url}: HTTP ${r.status}, using procedural level`);
    } catch (err) {
      console.warn(`[level] ${url} failed, using procedural level`, err);
    }
  }
  return generateLevel();
}

async function boot(): Promise<void> {
  const app = document.getElementById('app');
  if (!app) throw new Error('#app missing');
  const [, assets, level] = await Promise.all([loadFonts(), AssetRegistry.load(), loadLevel()]);
  const game = new Game(app, level, assets);
  const tutorial = new Tutorial(game, level);
  // Register after Tutorial so its start handler decides whether to restore a save.
  new SaveGame(game, () => tutorial.running);
  if (wantsTouch()) new TouchControls(game.input);
  // Load audio only when enabled (on by default; ?sound=0 disables it).
  if (SOUND_ON) void import('./audio/sound').then(({ Sound }) => new Sound(game));
  // ?manual: no RAF loop; frames are stepped externally (headless tests)
  if (!urlFlag('manual')) game.run();
  else game.frame(1 / 60);
}

boot().catch((err: unknown) => {
  console.error(err);
  document.body.insertAdjacentHTML('beforeend', `<pre style="color:#9dff2e;padding:20px;font:14px monospace">${String(err)}</pre>`);
});
