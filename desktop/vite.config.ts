import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

/*
  Krewgent's, with its own port: 5274, one past Krewgent's 5273, so the two
  apps' dev servers can run side by side on the owner's machine.
*/
const DEV_PORT = 5274;

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@shared': path.resolve(process.cwd(), 'shared') },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1600,
  },
  server: { port: DEV_PORT, strictPort: true },
});
