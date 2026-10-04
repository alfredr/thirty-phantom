import '@fontsource/anton';
import '@fontsource/bangers';
import '@fontsource/creepster';
import { AssetRegistry } from './assets/asset-registry';
import { SOUND_ON } from './audio/flags';
import { urlFlag, urlParam } from './engine/core/url-flags';
import { Game } from './game/game';
import { SaveGame } from './game/save';
import { Tutorial } from './game/story/tutorial';
import { TouchControls, wantsTouch } from './ui/touch-controls';
import { loadLevel } from './world/load-level';

/** Load fonts before generating canvas textures for signs and vehicle livery. */
async function loadFonts(): Promise<void> {
  await Promise.all(['64px "Creepster"', '64px "Anton"', '64px "Bangers"'].map((f) => document.fonts.load(f)));
}

async function boot(): Promise<void> {
  const app = document.getElementById('app');
  if (!app) {
    throw new Error('#app missing');
  }

  const [, assets, level] = await Promise.all([loadFonts(), AssetRegistry.load(), loadLevel(urlParam('level'))]);
  const game = new Game(app, level, assets);
  const tutorial = new Tutorial(game, level);
  // Register after Tutorial so its start handler decides whether to restore a save.
  new SaveGame(game, () => tutorial.running);

  if (wantsTouch()) {
    new TouchControls(game.input);
  }

  // Load audio only when enabled (on by default; ?sound=0 disables it).
  if (SOUND_ON) {
    void import('./audio/sound').then(({ Sound }) => new Sound(game));
  }

  // Manual mode renders one initial frame and leaves further stepping to the caller.
  if (!urlFlag('manual')) {
    game.run();
  } else {
    game.frame(1 / 60);
  }
}

boot().catch((err: unknown) => {
  console.error(err);
  document.body.insertAdjacentHTML(
    'beforeend',
    `<pre style="color:#9dff2e;padding:20px;font:14px monospace">${String(err)}</pre>`,
  );
});
