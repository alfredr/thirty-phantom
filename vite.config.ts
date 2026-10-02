import { defineConfig } from 'vite';
import { reloadPrompt } from './tools/vite-reload-prompt.ts';
import { levelValidator } from './tools/vite-level-validator.ts';

export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  server: { host: true },
  plugins: [levelValidator(), reloadPrompt()],
});
