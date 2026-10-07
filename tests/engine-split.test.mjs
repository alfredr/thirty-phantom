import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const SRC = resolve('src');
const ENGINE = resolve(SRC, 'engine');

function* modules(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      yield* modules(p);
    } else if (e.name.endsWith('.ts')) {
      yield p;
    }
  }
}

test('the engine imports only three and itself, never the game', () => {
  const strays = [];
  for (const file of modules(ENGINE)) {
    for (const [, spec] of readFileSync(file, 'utf8').matchAll(
      /(?:import|export)[^'"]*?from\s*'([^']+)'/g,
    )) {
      if (spec === 'three') {
        continue;
      }

      // Resolve @/ imports from src and relative imports from the importing file.
      const target = spec.startsWith('@/')
        ? resolve(SRC, spec.slice(2))
        : spec.startsWith('.')
          ? resolve(dirname(file), spec)
          : null;
      const inside =
        target !== null && !relative(ENGINE, target).startsWith('..');
      if (!inside) {
        strays.push(`${relative(ENGINE, file)} imports ${spec}`);
      }
    }
  }

  assert.deepEqual(strays, []);
});
