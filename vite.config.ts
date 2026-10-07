import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

import { levelValidator } from './tools/vite-level-validator.ts';
import { reloadPrompt } from './tools/vite-reload-prompt.ts';

export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  server: { host: true },
  // Resolve application imports from src/; same-folder imports use './'.
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  plugins: [levelValidator(), reloadPrompt()],
});
