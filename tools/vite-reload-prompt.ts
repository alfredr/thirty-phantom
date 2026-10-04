import path from 'node:path';

import type { EnvironmentModuleNode, Plugin } from 'vite';

/** True if an update to `mod` bubbles up to a module nothing accepts, i.e. Vite would full-reload. */
function hitsDeadEnd(mod: EnvironmentModuleNode, seen = new Set<EnvironmentModuleNode>()): boolean {
  if (seen.has(mod)) {
    return false;
  }

  seen.add(mod);

  // undefined = not analyzed yet; Vite stops propagating there too
  if (mod.isSelfAccepting !== false) {
    return false;
  }

  if (!mod.importers.size) {
    return true;
  }

  for (const importer of mod.importers) {
    if (!importer.acceptedHmrDeps.has(mod) && hitsDeadEnd(importer, seen)) {
      return true;
    }
  }

  return false;
}

/**
 * Dev only: instead of letting a code change full-reload the page (and lose game state), hold it and tell
 * src/dev/reload-prompt.ts to show a "change ready" toast. Updates that can hot-swap (CSS) still apply live.
 */
export function reloadPrompt(): Plugin {
  return {
    name: 'reload-prompt',
    apply: 'serve',
    transformIndexHtml: () => [
      { tag: 'script', attrs: { type: 'module', src: '/src/dev/reload-prompt.ts' }, injectTo: 'head' },
    ],
    hotUpdate({ file, modules }) {
      if (this.environment.name !== 'client' || !modules.some((m) => hitsDeadEnd(m))) {
        return;
      }

      this.environment.hot.send('reload-prompt:ready', { file: path.relative(this.environment.config.root, file) });
      return [];
    },
  };
}
