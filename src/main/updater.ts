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
 * Two things were tried here before this, and both were worse. A freshness window
 * (skip anything modified recently) failed in both directions: an install that took 15
 * seconds left its own leftovers in place, and a slow one would have looked stale. A
 * file held open for writing is not protected either -- Node opens with
 * FILE_SHARE_DELETE, so Windows deletes it happily (measured). What is protected is a
 * file in use as an executable, which the per-entry catch below reports rather than
 * failing on.
 *
 * The one cost: a second instance sharing this directory (a portable copy, a dev
 * build, another profile) loses a download in progress and fetches it again.
 */
export function pruneUpdateCache(): { path: string; files: number; bytes: number } {
  const dir = updateCacheDir()
  let counted = { files: 0, bytes: 0 }
  let kept = 0
  try {
    // A download started in the first seconds of a session -- possible only if someone
    // clicked the update button before this ran -- is not a leftover.
    if (state.status === 'downloading') {
      log.info('Update cache: a download is in progress; leaving it alone')
      return { path: dir, ...counted }
    }
    if (!fs.existsSync(dir)) {
      log.info(`Update cache: nothing to prune at ${dir}`)
      return { path: dir, ...counted }
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      const inner = entry.isDirectory() ? countCacheFiles(full) : { files: 1, bytes: safeSize(full) }
      try {
        fs.rmSync(full, { recursive: true, force: true })
        counted = { files: counted.files + inner.files, bytes: counted.bytes + inner.bytes }
      } catch (e) {
        // A running installer, or a permission problem. Never fatal.
        kept++
        log.info(`Update cache: left ${entry.name} alone (${(e as NodeJS.ErrnoException).code ?? 'error'})`)
      }
    }
  } catch (e) {
    log.warn('Could not prune the update cache:', e)
  }
  if (counted.files > 0) {
    log.info(`Update cache pruned: ${counted.files} file(s), ${(counted.bytes / 1024 / 1024).toFixed(1)} MB (${dir})`)
  } else if (kept > 0) {
    log.info(`Update cache: nothing pruned at ${dir}, ${kept} entr${kept === 1 ? 'y' : 'ies'} in use`)
  }
  return { path: dir, ...counted }
}

function safeSize(file: string): number {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

/** Counts files and bytes under a directory, for the log line. */
function countCacheFiles(dir: string): { files: number; bytes: number } {
  let files = 0
  let bytes = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const inner = countCacheFiles(full)
      files += inner.files
      bytes += inner.bytes
    } else {
      files++
      bytes += safeSize(full)
    }
  }
  return { files, bytes }
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
