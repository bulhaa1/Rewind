// Bundles the Electron main process and preload scripts with esbuild.
// Native modules (@streamlabs/obs-studio-node, uiohook-napi, koffi, ...) stay external
// because they are loaded from node_modules at runtime.
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptsDir = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(scriptsDir, '..')
const out = path.join(root, 'out')

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: false,
  // Mirrors the tsconfig path mapping so `@shared/x.js` resolves the same way in
  // both the build and the type checker.
  alias: {
    '@shared': path.join(root, 'src/shared'),
  },
  external: [
    'electron',
    '@streamlabs/obs-studio-node',
    'uiohook-napi',
    'koffi',
    'get-windows',
    'native-sound-mixer',
    'ffmpeg-static',
  ],
  logLevel: 'info',
}

await Promise.all([
  build({
    ...common,
    entryPoints: [path.join(root, 'src/main/index.ts')],
    outfile: path.join(out, 'main/index.js'),
  }),
  build({
    ...common,
    entryPoints: [path.join(root, 'src/preload/index.ts')],
    outfile: path.join(out, 'preload/index.js'),
  }),
])

console.log('[build:main] ok')