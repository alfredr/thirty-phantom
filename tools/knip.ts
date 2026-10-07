import type { KnipConfig } from 'knip';

// Expose named and namespace imports hidden by Vite's test loader.
function testImports(source: string): string {
  if (!/^import\s*\{\s*loadModules\s*\}\s*from\s*['"]/m.test(source)) {
    return source;
  }

  const compiled = source.replace(
    /\bconst\s*\[([\w$\s,{}:]*)\]\s*=\s*await\s+loadModules\(([^)]*)\)/g,
    (_call, bindings: string, paths: string) => {
      const names = bindings.match(/\{[^{}]*\}|[\w$]+/g) ?? [];
      const imports = [...paths.matchAll(/['"]\/src\/([^'"]+)['"]/g)];
      if (names.length !== imports.length) {
        throw new Error('Knip cannot match loadModules bindings to paths.');
      }

      const declarations = names.map((name, i) => {
        const binding = name.startsWith('{')
          ? name.replace(/\s*:\s*/g, ' as ')
          : `* as ${name}`;
        const path = JSON.stringify(`@/${imports[i]![1]}`);
        return `import ${binding} from ${path};`;
      });
      return `${declarations.join('\n')}\nawait Promise.resolve()`;
    },
  );

  if (/\bawait\s+loadModules\s*\(/.test(compiled)) {
    throw new Error('Knip cannot analyze this loadModules call.');
  }

  return compiled;
}

export default {
  entry: ['tests/live/*.mjs', 'tests/types/**/*.ts'],
  compilers: { mjs: testImports },
} satisfies KnipConfig;
