import Ajv from 'ajv';
import standaloneCode from 'ajv/dist/standalone/index.js';
import type { Plugin } from 'vite';

import { LevelV1Schema } from '../src/world/schema/level-v1.ts';

const ID = 'virtual:level-validator';

/**
 * Compile the level schema into a standalone validator when Vite starts. Expose the generated code through a virtual
 * module so Ajv is not bundled for the browser.
 */
export function levelValidator(): Plugin {
  const ajv = new Ajv({ strict: true, useDefaults: true, code: { source: true, esm: true } });
  const code = standaloneCode(ajv, ajv.compile(LevelV1Schema));
  return {
    name: 'level-validator',
    resolveId(id) {
      if (id === ID) {
        return `\0${ID}`;
      }
    },
    load(id) {
      if (id === `\0${ID}`) {
        return code;
      }
    },
  };
}
