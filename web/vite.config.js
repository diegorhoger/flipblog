import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  root: '.',
  base: './',
  build: {
    outDir: fileURLToPath(new URL('../server/public', import.meta.url)),
    // NOTE: do NOT set emptyOutDir: true here. The output dir (server/public) also
    // holds user-generated/uploaded content in `uploads/`. Emptying it would delete
    // cover images and uploaded media on every build. Vite still overwrites
    // index.html and the hashed assets, so stale bundles are simply unreferenced.
    emptyOutDir: false,
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/uploads': 'http://localhost:3000',
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/tests/**/*.test.js'],
  },
});
