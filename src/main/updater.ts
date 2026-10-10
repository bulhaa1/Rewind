import { app } from 'electron'
import { scope } from './logger.js'

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
 * Exits and runs the installer.
 *
 * The update is installed by a separate process on quit, so nothing here should
 * have run after this returns.
 */
export function quitAndInstall(): void {
  const au = load()
  if (!au) {
    app.quit()
    return
  }
  // isSilent = false and isForceRunAfter = true: the user should see the installer
  // running, and the app should come back up afterwards.
  au.quitAndInstall(false, true)
}
