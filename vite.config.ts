import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

import { levelValidator } from './tools/vite-level-validator.ts';
import { reloadPrompt } from './tools/vite-reload-prompt.ts';

export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  server: { host: true },
  // '@/x' is src/x: imports across folders are rooted there (same-folder ones stay './')
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  plugins: [levelValidator(), reloadPrompt()],
});
