import path from 'node:path';

import type { EnvironmentModuleNode, Plugin } from 'vite';

/** Return whether an update reaches an importer without an HMR acceptance boundary, requiring a page reload. */
function hitsDeadEnd(mod: EnvironmentModuleNode, seen = new Set<EnvironmentModuleNode>()): boolean {
  if (seen.has(mod)) {
    return false;
  }

  seen.add(mod);

  // Match Vite: stop traversal for self-accepting modules and modules not yet analyzed.
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
 * Defer development updates that would reload the page, preserving the current game session until the player chooses to
 * reload. Notify the injected reload prompt; allow accepted HMR updates, such as CSS, to proceed.
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
