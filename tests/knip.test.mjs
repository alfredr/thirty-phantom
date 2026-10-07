import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(
  new URL('../node_modules/knip/bin/knip.js', import.meta.url),
);
const config = fileURLToPath(new URL('../tools/knip.ts', import.meta.url));

test('Knip follows named and namespace Vite test imports without hiding unused neighbors', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), '30phantom-knip-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'tests'));
  const files = {
    'knip.ts': [
      `import config from ${JSON.stringify(config)};`,
      'export default { ...config,',
      '  entry: ["tests/*.test.mjs"],',
      '  project: ["src/**/*.ts", "tests/**/*.mjs"],',
      '};',
    ].join('\n'),
    'package.json': JSON.stringify({
      type: 'module',
      scripts: { test: 'node --test tests/*.test.mjs' },
    }),
    'tsconfig.json': JSON.stringify({
      compilerOptions: { paths: { '@/*': ['./src/*'] } },
    }),
    'src/named.ts': 'export const used = 1; export const unusedNamed = 2;',
    'src/namespace.ts': [
      'export const property = 1;',
      'export const destructured = 2;',
      'export const unusedNamespace = 3;',
    ].join('\n'),
    'tests/modules.mjs': 'export async function loadModules() {}',
    'tests/imports.test.mjs': [
      'import { loadModules } from "./modules.mjs";',
      'const [{ used: alias }, namespace] = await loadModules(',
      '  "/src/named.ts", "/src/namespace.ts",',
      ').finally(() => {});',
      'const { destructured } = namespace;',
      'console.log(alias, namespace.property, destructured);',
    ].join('\n'),
  };

  for (const [name, source] of Object.entries(files)) {
    writeFileSync(join(root, name), source);
  }

  const result = spawnSync(
    process.execPath,
    [
      cli,
      '--directory',
      root,
      '--config',
      join(root, 'knip.ts'),
      '--include',
      'exports',
      '--reporter',
      'json',
      '--no-config-hints',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  const unused = report.issues.flatMap((issue) =>
    issue.exports.map((item) => item.name),
  );
  assert.deepEqual(unused.sort(), ['unusedNamed', 'unusedNamespace']);
});
