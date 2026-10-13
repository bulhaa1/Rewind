import { app, BrowserWindow, Menu, Tray, powerMonitor, session } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { scope } from './logger.js'
import { appIcon, resolveIconPath } from './icons.js'
import { killChildren, OBS_EXE } from './process-lifetime.js'

const log = scope('App')
const crashLog = scope('Crash')

const PRELOAD = path.join(__dirname, '../preload/index.js')
const RENDERER_DIR = path.join(__dirname, '../renderer')
const DEV_URL = process.env.REWIND_DEV_SERVER

const MAIN_WIDTH = 1000
const MAIN_HEIGHT = 620
// The landscape shell: the capture deck is fluid and the clips rail is resizable
// (340px by default, dragged from the divider between them), so the floor is where
// the rail's own floor plus the deck's floor still fit. The old panel was a fixed
// 400px column, which is why the floor used to equal the width.
const MIN_WIDTH = 860
const MIN_HEIGHT = 540

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false

/** True once a real quit is underway (used to distinguish hide-vs-quit). */
export const lifecycle = { value: false }

// ---------------------------------------------------------------------------
// Crash dump bookkeeping
// ---------------------------------------------------------------------------

const CLEAN_EXIT = 'clean-exit'
const DUMP_EXT = '.dmp'
const MAX_KEPT_DUMPS = 5

/**
 * Surfaces crash dumps left by a previous run.
 *
 * crashReporter runs with upload disabled, so these are purely local; we report them
 * on the next launch because a silent crash report is otherwise undebuggable.
 */
function reportPreviousCrashDumps(): void {
  const dumpsDir = path.join(app.getPath('crashDumps'), 'reports')
  const marker = path.join(app.getPath('crashDumps'), 'last-logged-dump')

  try {
    if (!fs.existsSync(dumpsDir)) return
    const since = Number(safeRead(marker) ?? 0) || 0

    const dumps = fs
      .readdirSync(dumpsDir)
      .filter((f) => f.endsWith(DUMP_EXT))
      .map((f) => {
        const full = path.join(dumpsDir, f)
        const st = fs.statSync(full)
        return { full, mtimeMs: st.mtimeMs, sizeKb: Math.round(st.size / 1024) }
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs)

    const fresh = dumps.filter((d) => d.mtimeMs > since)
    for (const d of fresh) {
      crashLog.error(`Crash dump from an earlier run (${new Date(d.mtimeMs).toLocaleString()}): ${d.full} (${d.sizeKb}KB)`)
    }
    if (fresh.length > 0) fs.writeFileSync(marker, String(fresh[fresh.length - 1].mtimeMs))

    for (const d of dumps.slice(0, Math.max(0, dumps.length - MAX_KEPT_DUMPS))) {
      fs.rmSync(d.full, { force: true })
    }
  } catch (e) {
    crashLog.warn('Failed to check for previous crash dumps:', e)
  }
}

function safeRead(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

function startCrashReporter(): void {
  try {
    app.on('web-contents-created', (_e, contents) => {
      contents.on('render-process-gone', (_ev, details) => {
        if (details.reason !== CLEAN_EXIT) {
          crashLog.error(`Renderer gone: reason=${details.reason} exitCode=${details.exitCode}`)
        }
      })
    })

    app.on('child-process-gone', (_ev, details) => {
      if (details.reason === CLEAN_EXIT) return
      const name = details.name ?? details.serviceName ?? ''
      crashLog.error(`Child process gone: type=${details.type} ${name} reason=${details.reason} exitCode=${details.exitCode}`)
    })
  } catch (e) {
    crashLog.warn('Failed to start crash reporter:', e)
  }
}

/**
 * Locks down the renderer with a strict CSP.
 *
 * Rewind is offline by design, so `connect-src` permits nothing remote. Dev mode
 * widens script/connect only for the Vite server.
 */
function applyContentSecurityPolicy(): void {
  const dev = !!DEV_URL
  const scriptSrc = dev ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'" : "script-src 'self'"
  const connectSrc = dev
    ? "connect-src 'self' ws://localhost:* http://localhost:*"
    : "connect-src 'none'"

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          `default-src 'self'; ${scriptSrc}; style-src 'self' 'unsafe-inline'; ` +
          `img-src 'self' data:; font-src 'self' data:; ${connectSrc}; ` +
          `media-src 'self' file: rewind-clip:; object-src 'none'; base-uri 'self'; ` +
          `form-action 'self'; frame-ancestors 'none';`,
        ],
      },
    })
  })
}

// ---------------------------------------------------------------------------
// Single instance
// ---------------------------------------------------------------------------

/**
 * Only one instance may own the capture device, so a second launch focuses the
 * existing window instead of starting a competing OBS instance.
 */
function acquireSingleInstanceLock(onReady: () => void): void {
  if (!app.requestSingleInstanceLock()) {
    log.info('Another instance is already running, quitting...')
    app.quit()
    return
  }

  app.on('second-instance', (_e, argv) => {
    log.info('Second instance detected')
    const protocolArg = argv.find((a) => a.startsWith('rewind://'))
    if (protocolArg) log.info(`Protocol activation: ${protocolArg}`)
    showMainWindow()
  })

  onReady()
}

// ---------------------------------------------------------------------------
// Main window
// ---------------------------------------------------------------------------

function createMainWindow(onCreated?: (win: BrowserWindow) => void): BrowserWindow {
  const { width: areaW, height: areaH } = screen_workArea()
  const win = new BrowserWindow({
    width: MAIN_WIDTH,
    height: MAIN_HEIGHT,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    x: areaW - MAIN_WIDTH,
    y: areaH - MAIN_HEIGHT,
    show: false,
    resizable: true,
    // Frameless with a native overlay: Windows still draws the real caption
    // buttons - snap layouts, the window menu and hover previews included - while
    // the renderer owns the strip behind them, which is components/titlebar.tsx.
    //
    // `frame: false` is not optional here. With the default frame and a hidden
    // title bar, the window settled at exactly its minimum size seconds after
    // launch (measured: 1000x620 -> 860x540); with the frame genuinely gone the
    // requested size holds.
    frame: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#131316', symbolColor: '#a7a7ad', height: 40 },
    transparent: false,
    alwaysOnTop: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      // The replay UI polls status, so don't throttle it in the background.
      backgroundThrottling: false,
    },
    icon: resolveIconPath(),
  })

  win.setMenuBarVisibility(false)
  win.once('ready-to-show', () => win.show())

  onCreated?.(win)

  if (DEV_URL) {
    win.loadURL(DEV_URL)
    win.webContents.openDevTools()
  } else {
    win.loadFile(path.join(RENDERER_DIR, 'index.html'))
  }

  // Closing the panel hides it; the app keeps recording in the tray.
  win.on('close', (e) => {
    if (lifecycle.value) return
    e.preventDefault()
    win.hide()
  })
  win.on('closed', () => {
    mainWindow = null
  })

  return win
}

function screen_workArea(): { width: number; height: number } {
  const { screen } = require('electron')
  return screen.getPrimaryDisplay().workAreaSize
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

export function showMainWindow(): void {
  if (!mainWindow) return
  mainWindow.show()
  mainWindow.focus()
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

/**
 * The tray is the app's real "always running" surface: it stays alive after the
 * panel is closed so the replay buffer keeps rolling.
 */
function createTray(handlers: { onShow: () => void; onSaveClip: () => Promise<void>; onQuit: () => void }): Tray {
  const t = new Tray(appIcon())
  t.setToolTip('Rewind - Replay Buffer')

  const menu = Menu.buildFromTemplate([
    { label: 'Show', click: handlers.onShow },
    {
      label: 'Save Clip',
      click: async () => {
        try {
          await handlers.onSaveClip()
        } catch (e) {
          crashLog.error('Failed to save clip from tray:', e)
        }
      },
    },
    { type: 'separator' },
    { label: 'Quit', click: handlers.onQuit },
  ])

  t.setContextMenu(menu)
  t.on('double-click', handlers.onShow)
  return t
}

export function destroyTray(): void {
  if (tray) {
    tray.destroy()
    tray = null
  }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

export function bootstrap(hooks: {
  onSaveClip: () => Promise<void>
  onInitPipeline: () => Promise<void>
  onPipelineWedge: () => Promise<void>
  onResume: () => Promise<void>
}): void {
  startCrashReporter()

  acquireSingleInstanceLock(() => {
    app.whenReady().then(async () => {
      log.info(`Rewind v${app.getVersion()} starting (pid ${process.pid})`)
      reportPreviousCrashDumps()

      // Needs a live session: `session.defaultSession` throws before app-ready.
      applyContentSecurityPolicy()

      mainWindow = createMainWindow()

      tray = createTray({
        onShow: showMainWindow,
        onSaveClip: hooks.onSaveClip,
        onQuit: () => app.quit(),
      })

      await hooks.onInitPipeline()

      // A display/lock cycle can leave the WASAPI context stale; rebuild rather than
      // silently recording silence.
      powerMonitor.on('resume', () => void hooks.onResume())

      app.on('activate', () => showMainWindow())
    })
  })

  // Closing the last window must not quit: we're a tray app.
  app.on('window-all-closed', () => {})

  app.on('before-quit', (e) => {
    if (lifecycle.value) return
    lifecycle.value = true
    try {
      hooks.onPipelineWedge()
    } catch (err) {
      log.error('Cleanup failed:', err)
    }
    destroyTray()
  })

  app.on('will-quit', () => {
    killChildren(OBS_EXE)
  })
}

export { PRELOAD, RENDERER_DIR, DEV_URL, mainWindowRef }

/** Escape hatch for modules that need the current window without a circular import. */
function mainWindowRef(): BrowserWindow | null {
  return mainWindow
}