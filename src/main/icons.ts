import { app, nativeImage } from 'electron'
import path from 'node:path'
import fs from 'node:fs'

/**
 * Locating the app icon.
 *
 * The icon used to be resolved as `path.join(__dirname, '../../assets/favicon.ico')`
 * in three places. That works in development, where `__dirname` is `out/main` inside
 * the project, and silently does nothing in a packaged build: `__dirname` becomes
 * `app.asar/out/main`, so the path points inside the archive at `assets/`, which
 * electron-builder never copies -- its `files` list is `out/**` and `package.json`,
 * and assets only ship via `extraResources`, which flattens them to
 * `process.resourcesPath/favicon.ico`.
 *
 * The tray then fell through its `isEmpty()` guard to `nativeImage.createEmpty()`,
 * so an installed Reflect showed a blank tray icon on the one surface the app is
 * always running on. Nothing errored. This mirrors `resolveFfmpeg()`, which
 * already branches on `app.isPackaged` for exactly this reason.
 */
let cachedPath: string | null = null

/** Absolute path to the .ico, preferring the packaged location. */
export function resolveIconPath(): string {
  if (cachedPath) return cachedPath
  const packaged = path.join(process.resourcesPath, 'favicon.ico')
  const dev = path.join(__dirname, '../../assets/favicon.ico')
  cachedPath = app.isPackaged ? packaged : dev

  // If the packaged copy is somehow missing, say so rather than returning a path
  // that will quietly produce an empty image further down.
  if (app.isPackaged && !fs.existsSync(cachedPath)) {
    console.warn(`[icons] packaged icon missing at ${cachedPath}; the tray and windows will show no icon`)
  }
  return cachedPath
}

/**
 * The app icon as a NativeImage.
 *
 * Never returns an empty image when the file is readable. The tray previously
 * degraded to `createEmpty()` on any failure, which is how a missing icon became
 * invisible rather than obvious.
 */
export function appIcon(): Electron.NativeImage {
  const file = resolveIconPath()
  const image = nativeImage.createFromPath(file)
  if (image.isEmpty()) {
    throw new Error(`icon could not be loaded from ${file}`)
  }
  return image
}
