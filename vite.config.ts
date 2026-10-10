import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: path.join(root, 'src/renderer'),
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@shared': path.join(root, 'src/shared'),
      '@renderer': path.join(root, 'src/renderer'),
      // The brand artwork is generated into assets/ by scripts/logo-*.ps1 and is
      // the single source for the app icon, the tray and the in-app mark. Vite's
      // root is src/renderer, so a relative import out to assets/ escapes it and
      // Rollup refuses to resolve it. The alias keeps one copy of the artwork
      // rather than duplicating it under src/renderer where it would drift.
      '@assets': path.join(root, 'assets'),
    },
  },
  build: {
    outDir: path.join(root, 'out/renderer'),
    emptyOutDir: true,
    target: 'chrome124',
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
  server: {
    port: 5273,
    strictPort: true,
  },
})