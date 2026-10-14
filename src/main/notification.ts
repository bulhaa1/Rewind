import { BrowserWindow, screen } from 'electron'
import path from 'node:path'
import { scope } from './logger.js'
import { devServerUrl } from './window.js'
import type { BufferStatus } from '@shared/types.js'

const log = scope('Notification')
const stateLog = scope('FullscreenState')

/** Windows Shell notification state: QUNS_BUSY = 3 means exclusive fullscreen. */
const QUNS_BUSY = 3

const NOTIFICATION_WIDTH = 280
const NOTIFICATION_HEIGHT = 110
const SCREEN_MARGIN = 16
const NOTIFICATION_LIFETIME_MS = 3500

let panel: BrowserWindow | null = null

// ---------------------------------------------------------------------------
// Exclusive-fullscreen detection
// ---------------------------------------------------------------------------

let shQuery: ((out: number[]) => number) | null | undefined

/**
 * Resolves SHQueryUserNotificationState so popups can be suppressed while a game is
 * running exclusive fullscreen. An overlay there would land on top of the game.
 */
function getShellQuery() {
  if (shQuery !== undefined) return shQuery
  try {
    const koffi = require('koffi')
    shQuery = koffi.load('shell32.dll').func('int SHQueryUserNotificationState(_Out_ int *state)')
  } catch (e) {
    stateLog.warn('SHQueryUserNotificationState unavailable, exclusive-fullscreen detection disabled:', e)
    shQuery = null
  }
  return shQuery
}

function inExclusiveFullscreen(): boolean {
  const fn = getShellQuery()
  if (!fn) return false
  try {
    const out = [0]
    return fn(out) === 0 && out[0] === QUNS_BUSY
  } catch (e) {
    stateLog.warn('SHQueryUserNotificationState call failed:', e)
    return false
  }
}

// ---------------------------------------------------------------------------
// Popup
// ---------------------------------------------------------------------------

export interface NotifyDeps {
  getMainWindow: () => BrowserWindow | null
  /** Whether the popup itself should be shown. */
  enabled: () => boolean
  /** Whether the chime should play. Independent of `enabled`. */
  soundEnabled: () => boolean
  /** Directory holding the built renderer (used when not in dev). */
  rendererDir: string
}

/**
 * Shows the in-app notification popup in a dedicated transparent panel window.
 *
 * `title` replaces the kind's default heading, which is how a hotkey popup names
 * the action and its key; `message` is the body line -- the engine's own reason
 * on a failure, the folder on a save.
 *
 * The sound fires before the popup is suppressed, so a saved clip is still
 * acknowledged when the user has turned popups off or is mid-game.
 */
export function notify(type: BufferStatus, deps: NotifyDeps, message?: string, title?: string): void {
  if (type === 'saved' || type === 'screenshot') {
    if (deps.soundEnabled()) {
      const win = deps.getMainWindow()
      if (win && !win.isDestroyed()) win.webContents.send('play-notification-sound')
    }
  }

  if (!deps.enabled()) {
    log.info(`Notification suppressed (disabled): ${type}`)
    return
  }
  if (inExclusiveFullscreen()) {
    log.info(`Notification suppressed (exclusive fullscreen app active): ${type}`)
    return
  }

  dismissPanel()

  const win = new BrowserWindow({
    width: NOTIFICATION_WIDTH,
    height: NOTIFICATION_HEIGHT,
    x: screen.getPrimaryDisplay().workArea.x + screen.getPrimaryDisplay().workArea.width - NOTIFICATION_WIDTH - SCREEN_MARGIN,
    y: screen.getPrimaryDisplay().workArea.y + SCREEN_MARGIN,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    focusable: false,
    type: 'panel',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The popup loads the app's own bundle, which needs the preload bridge.
      sandbox: false,
      webSecurity: true,
    },
  })
  panel = win

  win.setVisibleOnAllWorkspaces(true)
  win.setFullScreenable(false)
  win.setMinimizable(false)

  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return
    // 'screen-saver' is the strongest always-on-top level, so the popup stays
    // visible over a fullscreen game.
    win.setAlwaysOnTop(true, 'screen-saver')
    win.showInactive()
    win.moveTop()
  })

  const devUrl = devServerUrl()
  const indexHtml = path.join(deps.rendererDir, 'index.html')
  const params = new URLSearchParams({ notification: type })
  if (message) params.set('message', message)
  if (title) params.set('title', title)
  const query = `?${params.toString()}`

  win.loadURL(devUrl ? `${devUrl}${query}` : `file://${indexHtml}${query}`)

  win.on('closed', () => {
    if (panel === win) panel = null
  })

  setTimeout(() => {
    if (!win.isDestroyed()) win.close()
  }, NOTIFICATION_LIFETIME_MS)

  log.info(`Shown: ${type}${title ? ` - ${title}` : ''}${message ? ` - ${message}` : ''}`)
}

/** Closes any open popup. Safe to call when none is showing. */
export function dismissPanel(): void {
  if (panel && !panel.isDestroyed()) panel.close()
  panel = null
}