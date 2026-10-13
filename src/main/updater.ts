import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { scope } from './logger.js'
import { lifecycle } from './window.js'

const log = scope('Updater')

/**
 * Update checking, on request only.
 *
 * Rewind makes no network calls unless someone asks it to. That is a property the
 * product claims, so it is enforced here rather than merely intended:
 *
 *   - `autoCheckForUpdates` stays false. Nothing polls on a timer or at startup.
 *   - `autoDownload` stays false. Finding an update does not start a download.
 *
 * The only path to the network is `check()`, which the header button calls.
 *
 * `electron-updater` refuses to run outside a packaged build -- it throws
 * "application is not packaged" -- so `supported` is reported to the renderer and
 * the button is hidden in development rather than failing on every click.
 */

/** What the renderer renders. Mirrored in shared/types.ts. */
export interface UpdateState {
  /** False in a dev build, where no check is possible. */
  supported: boolean
  status: 'idle' | 'checking' | 'available' | 'current' | 'downloading' | 'ready' | 'error'
  /** Version offered by the release feed, when one is. */
  version?: string
  /** Download progress 0..1. */
  progress?: number
  error?: string
}

let state: UpdateState = { supported: app.isPackaged, status: 'idle' }
let autoUpdater: typeof import('electron-updater').autoUpdater | null = null
let onChange: (s: UpdateState) => void = () => {}

/** Current app version, for saying "you're on 1.0.0". */
export function currentVersion(): string {
  return app.getVersion()
}

function set(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch }
  onChange(state)
}

/**
 * Loads electron-updater lazily.
 *
 * It is not imported at module scope so a dev build never pays for it, and so the
 * dependency is only required on the path that can actually use it.
 */
function load(): typeof import('electron-updater').autoUpdater | null {
  if (!app.isPackaged) return null
  if (autoUpdater) return autoUpdater
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('electron-updater')
    const au = mod.autoUpdater as typeof import('electron-updater').autoUpdater

    /*
     * Rewind makes no network calls unless someone asks it to, and that is enforced
     * here rather than merely intended.
     *
     * There is no auto-check in electron-updater 6 at all -- `autoCheckForUpdates`
     * does not exist. A check happens only where `checkForUpdates()` is called,
     * which is one place: the header button. So there is no flag here that a
     * future default change could quietly flip.
     *
     * The two below are the ones that do exist, and both default the wrong way for
     * this product:
     */
    au.autoDownload = false // finding an update must not start a download
    // A completed download must not install itself when the app is quit. On-demand
    // means the user presses the button, not that closing the window applies it.
    au.autoInstallOnAppQuit = false

    au.logger = {
      info: (m: string) => log.info(m),
      warn: (m: string) => log.warn(m),
      error: (m: string) => log.error(m),
    }

    au.on('checking-for-update', () => set({ status: 'checking', error: undefined }))
    au.on('update-available', (info: { version?: string }) =>
      set({ status: 'available', version: info?.version, error: undefined }),
    )
    au.on('update-not-available', () => set({ status: 'current', version: undefined }))
    au.on('download-progress', (p: { percent?: number }) =>
      set({ status: 'downloading', progress: (p.percent ?? 0) / 100 }),
    )
    au.on('update-downloaded', (info: { version?: string }) =>
      set({ status: 'ready', version: info?.version, progress: 1 }),
    )
    au.on('error', (e: Error) => {
      log.warn('update check failed:', e.message)
      set({ status: 'error', error: e?.message || 'Update check failed' })
    })

    autoUpdater = au
    return au
  } catch (e) {
    log.error('electron-updater could not be loaded:', e)
    set({ status: 'error', error: 'Update support is unavailable in this build' })
    return null
  }
}

/** Starts reporting state changes. Called once at startup. */
export function initUpdater(send: (s: UpdateState) => void): void {
  onChange = send
  state = { supported: app.isPackaged, status: 'idle' }
  send(state)
}

export function getUpdateState(): UpdateState {
  return state
}

/** Checks the release feed. Never called except from a user action. */
export async function checkForUpdates(): Promise<UpdateState> {
  const au = load()
  if (!au) {
    // Not packaged. Say so plainly rather than surfacing a thrown error.
    set({ status: 'error', error: 'Updates are only available in installed builds' })
    return state
  }
  try {
    await au.checkForUpdates()
  } catch (e) {
    // The 'error' event normally covers this, but guard anyway so a rejection can
    // never leave the button spinning forever.
    set({ status: 'error', error: e instanceof Error ? e.message : 'Update check failed' })
  }
  return state
}

export async function downloadUpdate(): Promise<UpdateState> {
  const au = load()
  if (!au) return state
  try {
    await au.downloadUpdate()
  } catch (e) {
    set({ status: 'error', error: e instanceof Error ? e.message : 'Download failed' })
  }
  return state
}

/**
 * The directory electron-updater downloads into.
 *
 * `updaterCacheDirName` is written into `app-update.yml` at package time and is the
 * name electron-updater itself uses. A dev build has no `app-update.yml`, and the
 * default there is the package name.
 */
function updateCacheDirName(): string {
  try {
    const yml = fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8')
    const match = /^updaterCacheDirName:\s*(\S+)\s*$/m.exec(yml)
    if (match) return match[1]
  } catch {
    /* not packaged */
  }
  // The same default electron-builder writes into app-update.yml: the *package* name,
  // not the product name. `app.name` is the product name ("Rewind"), which resolves to
  // a directory nothing ever writes to.
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')) as { name?: string }
    if (pkg.name) return `${pkg.name}-updater`
  } catch {
    /* fall through */
  }
  return `${app.name}-updater`
}

/** The directory electron-updater downloads into. */
function updateCacheDir(): string {
  // Mirrors electron-updater's own `getAppCacheDir`, which uses LOCALAPPDATA on
  // Windows rather than Electron's paths -- Electron has no `cache` key.
  const base = process.env.LOCALAPPDATA ?? path.join(app.getPath('home'), 'AppData', 'Local')
  return path.join(base, updateCacheDirName())
}

/**
 * Anything modified more recently than this is treated as a download in flight.
 *
 * Two minutes, not longer: an update's leftovers are already about four minutes old by
 * the time the app comes back (measured: download, silent install, relaunch), so they
 * are pruned on that start. A download writes continuously, so a fresh mtime is a
 * reliable sign of one; a download stalled for two minutes would be deleted and simply
 * re-downloaded.
 */
const CACHE_STALE_AFTER_MS = 2 * 60_000

/**
 * Deletes what the updater left behind, once per start.
 *
 * After one update the directory holds two copies of the same installer --
 * `installer.exe`, the renamed copy electron-updater executes, and the original --
 * plus a blockmap. Measured on this machine: 379 MB for one version, and it grows
 * with every release.
 *
 * Nothing there can be applied across a restart: the update state lives in memory and
 * starts at `idle`, so a stale download is downloaded again rather than installed.
 * Deleting it costs a repeat download at worst, and it is the difference between an
 * install folder that stays the size it was installed at and one that grows forever.
 *
 * Anything modified in the last two minutes is left alone. That is not hypothetical:
 * a second instance -- a portable copy, a dev build, another profile -- shares this
 * directory, and the first version of this deleted a download that was in flight. The
 * decision is made per file, so a stale installer beside a live download is still
 * cleared; an update's own leftovers are older than two minutes by the time the app
 * comes back, so they go on that start.
 */
export function pruneUpdateCache(): { path: string; files: number; bytes: number } {
  const dir = updateCacheDir()
  let counted = { files: 0, bytes: 0 }
  let kept = 0
  try {
    if (!fs.existsSync(dir)) {
      log.info(`Update cache: nothing to prune at ${dir}`)
      return { path: dir, ...counted }
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const result = pruneCacheEntry(path.join(dir, entry.name))
      counted = { files: counted.files + result.files, bytes: counted.bytes + result.bytes }
      kept += result.kept
    }
  } catch (e) {
    // A locked installer (one is mid-run) or a permission problem. Never fatal.
    log.warn('Could not prune the update cache:', e)
  }
  if (counted.files > 0) {
    log.info(
      `Update cache pruned: ${counted.files} file(s), ${(counted.bytes / 1024 / 1024).toFixed(1)} MB (${dir})` +
        (kept > 0 ? `, ${kept} fresh file(s) left alone` : ''),
    )
  } else if (kept > 0) {
    log.info(`Update cache: ${kept} fresh file(s) at ${dir}, nothing stale to prune`)
  }
  return { path: dir, ...counted }
}

/** Prunes one file or directory, keeping anything written in the last two minutes. */
function pruneCacheEntry(target: string): { files: number; bytes: number; kept: number } {
  const stat = fs.statSync(target)
  if (!stat.isDirectory()) {
    if (Date.now() - stat.mtimeMs < CACHE_STALE_AFTER_MS) return { files: 0, bytes: 0, kept: 1 }
    fs.rmSync(target, { force: true })
    return { files: 1, bytes: stat.size, kept: 0 }
  }

  let total = { files: 0, bytes: 0, kept: 0 }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const inner = pruneCacheEntry(path.join(target, entry.name))
    total = { files: total.files + inner.files, bytes: total.bytes + inner.bytes, kept: total.kept + inner.kept }
  }
  // An emptied directory goes with its contents; one holding a live download stays.
  try {
    if (fs.readdirSync(target).length === 0) fs.rmdirSync(target)
  } catch {
    /* leave it */
  }
  return total
}

/**
 * Exits and runs the installer.
 *
 * Silent, because the wizard is the thing being removed: an update that asks the user
 * to click through an installer they did not ask for is not an update, it is a chore.
 * `isForceRunAfter` brings the app back up once the installer finishes.
 *
 * The update is installed by a separate process on quit, so nothing here should have
 * run after this returns.
 */
export function quitAndInstall(): void {
  const au = load()
  if (!au) {
    app.quit()
    return
  }
  // The installer kills this process itself a few seconds in, so the quit must not
  // stop to finish a recording: `installing` tells window.ts to skip that wait.
  lifecycle.installing = true
  au.quitAndInstall(true, true)
}
