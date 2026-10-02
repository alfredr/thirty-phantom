import { after } from 'node:test';
import { createServer } from 'vite';
import { levelValidator } from '../tools/vite-level-validator.ts';

/** Load source modules through Vite without HTTP listeners, WebSockets, or file watchers. */
export async function loadModules(...paths) {
  const server = await createServer({
    configFile: false,
    plugins: [levelValidator()],
    server: { middlewareMode: true, ws: false, watch: null },
    appType: 'custom',
  });
  after(() => server.close());
  return Promise.all(paths.map((path) => server.ssrLoadModule(path)));
}
