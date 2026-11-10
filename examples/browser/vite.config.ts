import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '../..');

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Use the library's source directly, so changes to it show up without a build step.
    alias: [
      { find: /^textrude$/, replacement: resolve(repoRoot, 'src/index.ts') },
      { find: /^textrude\/(.+)$/, replacement: resolve(repoRoot, 'src/$1.ts') },
    ],
  },
  server: {
    fs: { allow: [repoRoot] },
  },
  // The worker's dependencies (otherwise they're found on first load, which reloads the page).
  optimizeDeps: {
    include: ['@tootallnate/bitmap-font', 'clipper-lib', 'fflate', 'fontkit', 'libtess'],
  },
  build: {
    // three.js alone is ~600 kB.
    chunkSizeWarningLimit: 1500,
  },
  worker: {
    format: 'es',
  },
});
