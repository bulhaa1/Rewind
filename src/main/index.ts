import { app, protocol, screen } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scope } from './logger.js'
import { bootstrap, getMainWindow, lifecycle, PRELOAD, RENDERER_DIR, showMainWindow } from './window.js'
import { log as logger } from './logger.js'
import { ObsCore, defaultOutputPath, killObsChildren } from './obs-core.js'
import { ReplayBuffer } from './replay-buffer.js'
import { CaptureManager } from './capture.js'
import { GameDetector } from './game-detector.js'
import { AudioDeviceChannels, AudioMix, invalidateDeviceCache } from './audio.js'
import { notify, dismissPanel } from './notification.js'
import { installDefaultHotkeys, shutdown as shutdownHotkeys, startCapture, stopCapture } from './hotkey.js'
import { registerIpc, saveClipAndNotify, takeScreenshot, outputRoot, OBS_STATUS_MESSAGES } from './ipc.js'
import { getClipMeta, setClipMeta } from './clip-meta.js'
import { openEditorWindow, currentEditorClip, closeEditorWindow, cleanupEditor, saveClip } from './editor.js'
import { getSetting, setSetting } from './store.js'
import { isInside } from './util.js'
import { Mutex, sleep, withTimeout } from './obs-bind.js'
import { TIMING } from '@shared/constants.js'
import type { BufferStatus, ObsStatus } from '@shared/types.js'

const log = scope('App')
const protocolLog = scope('ClipProtocol')

// ---------------------------------------------------------------------------
// Custom protocol
// ---------------------------------------------------------------------------

const CLIP_SCHEME = 'reflect-clip'
let previewRoot = ''

/**
 * Declares the clip scheme as privileged.
 *
 * This is the only part that may run before `app.whenReady()` — Electron reads the
 * privilege table while it boots and ignores later registrations.
 */
function declareClipScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: CLIP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
    },
  ])
}

/**
 * Serves local clips to the renderer over the custom scheme.
 *
 * The editor is a `file://` page, and Chromium blocks `fetch` of sibling files from
 * there, so clips are streamed through a privileged scheme instead. Range requests
 * are honoured because `<video>` needs them for seeking.
 *
 * Must be called after the app is ready — `protocol.handle` throws otherwise.
 */
function registerClipProtocol(): void {
  previewRoot = path.join(os.tmpdir(), 'reflect-editor-preview')

  // Must use the shared resolver: `outputPath` is empty until the user picks a
  // folder, and comparing against it rejected every request — which surfaced in the
  // editor as MEDIA_ERR_SRC_NOT_SUPPORTED with no clue why.
  const isAllowed = (target: string): boolean =>
    isInside(target, outputRoot()) || isInside(target, previewRoot)

  protocol.handle(CLIP_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      const target = decodeURIComponent(url.pathname.replace(/^\//, ''))

      if (!isAllowed(target)) {
        protocolLog.warn('Blocked clip protocol request outside allowed dirs:', target)
        return new Response('Forbidden', { status: 403 })
      }
      if (!fs.existsSync(target)) return new Response('Not Found', { status: 404 })

      const ext = path.extname(target).toLowerCase()
      const contentType = ext === '.mkv' ? 'video/x-matroska' : ext === '.webm' ? 'video/webm' : 'video/mp4'
      const size = fs.statSync(target).size

      const range = request.headers.get('range') ?? request.headers.get('Range')
      if (range) {
        const m = /^bytes=(\d+)-(\d*)$/.exec(range.trim())
        if (m) {
          const start = parseInt(m[1], 10)
          const end = m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1

          if (Number.isNaN(start) || start >= size || end < start) {
            return new Response('Range Not Satisfiable', {
              status: 416,
              headers: { 'Content-Range': `bytes */${size}` },
            })
          }

          const stream = fs.createReadStream(target, { start, end })
          return new Response(toWebStream(stream), {
            status: 206,
            headers: {
              'Content-Type': contentType,
              'Content-Length': String(end - start + 1),
              'Content-Range': `bytes ${start}-${end}/${size}`,
              'Accept-Ranges': 'bytes',
              'Access-Control-Allow-Origin': '*',
              'Cross-Origin-Resource-Policy': 'cross-origin',
            },
          })
        }
      }

      return new Response(toWebStream(fs.createReadStream(target)), {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(size),
          'Accept-Ranges': 'bytes',
          'Access-Control-Allow-Origin': '*',
          'Cross-Origin-Resource-Policy': 'cross-origin',
        },
      })
    } catch (e) {
      protocolLog.error('Clip protocol error:', e)
      return new Response('Bad Request', { status: 400 })
    }
  })

  protocolLog.info(`Registered ${CLIP_SCHEME}:// protocol`)
}

/** Adapts a Node readable to a web ReadableStream for the protocol handler. */
function toWebStream(stream: fs.ReadStream): ReadableStream {
  let closed = false
  return new ReadableStream({
    start(controller) {
      stream.on('data', (chunk) => {
        if (closed) return
        try {
          controller.enqueue(new Uint8Array(typeof chunk === 'string' ? Buffer.from(chunk) : chunk))
        } catch {
          closed = true
          stream.destroy()
        }
      })
      stream.on('end', () => {
        if (!closed) {
          closed = true
          try {
            controller.close()
          } catch {
            /* already closed */
          }
        }
      })
      stream.on('error', (e) => {
        if (!closed) {
          closed = true
          try {
            controller.error(e)
          } catch {
            /* already closed */
          }
        }
      })
    },
    cancel() {
      closed = true
      stream.destroy()
    },
  })
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

let obsCore: ObsCore | null = null
let replay: ReplayBuffer | null = null
let capture: CaptureManager | null = null
let detector: GameDetector | null = null
let audioMix: AudioMix | null = null
let audioDevices: AudioDeviceChannels | null = null

let currentStatus: { status: ObsStatus; message?: string } = OBS_STATUS_MESSAGES.initializing
let reinitMutex = new Mutex()
let wedgeRecoveryInFlight = false

const pipelineActive = (): boolean => !!(obsCore?.isInitialized() && replay?.isReplayBufferActive())

function buildPipeline(): void {
  const config = {
    bufferDuration: getSetting('bufferDuration'),
    fps: getSetting('fps'),
    outputPath: getSetting('outputPath') || defaultOutputPath(),
    outputResolution: getSetting('outputResolution'),
  }

  obsCore = new ObsCore(config)
  replay = new ReplayBuffer(obsCore)
  capture = new CaptureManager(obsCore)
  detector = new GameDetector()
  audioMix = new AudioMix({ obs: () => obsCore?.obs ?? null })
  audioDevices = new AudioDeviceChannels({ obs: () => obsCore?.obs ?? null })

  capture.setReplayBuffer(replay)
  capture.setGameDetector(detector)

  obsCore.wire(capture, replay, audioMix, audioDevices)

  detector.setCapture(capture)
  detector.setGetMainWindow(getMainWindow)
}

async function initPipeline(): Promise<void> {
  installDefaultHotkeys({
    'save-replay': () => void saveFromHotkey(),
    screenshot: () => void saveScreenshotFromHotkey(),
  })

  try {
    await startPipeline()
    setStatus(OBS_STATUS_MESSAGES.ready, getMainWindow())
    log.info('OBS initialized and replay buffer started')
  } catch (e) {
    log.error('Failed to initialize OBS:', e)
    setStatus({ status: 'error', message: errorMessage(e) }, getMainWindow())
  }
}

/** Restores whichever capture source the user last had selected. */
async function startPipeline(): Promise<void> {
  await obsCore!.initialize()

  const mode = getSetting('captureMode')
  const displayIndex = getSetting('displayIndex')
  const windowId = getSetting('windowId')

  log.info(
    `Restoring capture source: mode=${mode}, ` +
    (mode === 'display' ? `displayIndex=${displayIndex}` : mode === 'window' ? `windowId=${windowId ?? 'none'}` : 'game'),
  )

  if (mode === 'game') {
    try {
      await capture!.setAutoDetectCapture(displayIndex)
    } catch {
      log.warn('Failed to restore auto-detect capture, falling back to display')
      await capture!.setMonitor(displayIndex)
    }
    return
  }

  if (mode === 'window' && windowId) {
    try {
      await capture!.setWindow(windowId)
      capture!.refreshWindowList()
    } catch {
      log.warn('Failed to restore window capture, falling back to display')
      await capture!.setMonitor(displayIndex)
    }
    return
  }

  // Display mode with index 0 is the default: start the buffer without a source switch.
  if (displayIndex === 0) {
    await replay!.startReplayBuffer(true)
  } else {
    await capture!.setMonitor(displayIndex)
  }
}

async function shutdownPipeline(): Promise<void> {
  try {
    if (!obsCore) return
    await withTimeout(obsCore.shutdown(), TIMING.SHUTDOWN, 'Shutdown timed out')
  } catch (e) {
    log.warn('OBS shutdown timed out during reinit, force-killing:', e)
    obsCore?.markAbandoned()
    killObsChildren()
    await sleep(TIMING.OBS_RESPAWN_SETTLE)
  } finally {
    obsCore = null
    replay = null
    capture = null
    detector = null
    audioMix = null
    audioDevices = null
  }
}

/**
 * Tears the pipeline down and rebuilds it. Serialized so concurrent calls queue.
 *
 * The status has to be restored here rather than by whoever asked for the rebuild.
 * It used to be set to `initializing` and left there: the only assignment of `ready`
 * lived in the first-boot path, so after changing a setting that rebuilds the engine
 * — frame rate, output resolution — the panel sat on "Starting engine" forever with
 * Record and Save disabled, and only quitting the app cleared it.
 *
 * A failure has to land on `error` rather than `ready`, or the panel would claim to
 * be recording with no engine behind it.
 */
async function reinitPipeline(reason?: string): Promise<void> {
  await reinitMutex.run(async () => {
    log.info(`Reinitializing OBS pipeline${reason ? ` (${reason})` : ''}...`)
    setStatus(reason ? { status: 'initializing', message: reason } : OBS_STATUS_MESSAGES.initializing, getMainWindow())

    try {
      await shutdownPipeline()
      buildPipeline()
      await startPipeline()
    } catch (e) {
      log.error(`Pipeline reinit failed${reason ? ` (${reason})` : ''}:`, e)
      setStatus({ status: 'error', message: errorMessage(e) }, getMainWindow())
      throw e
    }

    // `ready` only if there is genuinely a running buffer behind it.
    if (pipelineActive()) setStatus(OBS_STATUS_MESSAGES.ready, getMainWindow())
    else setStatus(OBS_STATUS_MESSAGES.paused, getMainWindow())
  })
}

/**
 * Recovers a wedged encoder. Falls back to a full relaunch when the in-process
 * reinit doesn't produce a live buffer, since a wedged OBS can poison itself.
 */
async function recoverFromWedge(): Promise<void> {
  await reinitPipeline('Restarting recording...')
  if (pipelineActive()) return
  log.warn('OBS reinit after wedge failed; relaunching for a clean process')
  app.relaunch()
  app.quit()
}

function scheduleWedgeRecovery(): void {
  if (wedgeRecoveryInFlight) return
  void (async () => {
    wedgeRecoveryInFlight = true
    try {
      log.warn('Detected wedged obs64; force-killing and reinitializing OBS')
      await recoverFromWedge()
    } catch (e) {
      log.error('OBS wedge recovery failed:', e)
    } finally {
      wedgeRecoveryInFlight = false
    }
  })()
}

function setStatus(status: { status: ObsStatus; message?: string }, win = getMainWindow()): void {
  currentStatus = status
  if (win && !win.isDestroyed()) win.webContents.send('obs-status', status)
}

// ---------------------------------------------------------------------------
// Hotkey / tray entry points
// ---------------------------------------------------------------------------

/** Message text for any thrown value, used to classify failures. */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Shows a popup, honouring the user's notification and sound settings.
 *
 * The sound fires even when the popup is suppressed (disabled, or an app is in
 * exclusive fullscreen) — the user still needs to know the clip was saved.
 */
function showNotification(type: BufferStatus, message?: string): void {
  notify(
    type,
    {
      getMainWindow,
      enabled: () => getSetting('notificationsEnabled'),
      soundEnabled: () => getSetting('notificationSoundEnabled'),
      rendererDir: RENDERER_DIR,
    },
    message,
  )
}

async function saveFromHotkey(): Promise<void> {
  if (!pipelineActive() || !obsCore || !replay || !capture) {
    log.warn('Shortcut save ignored: recording not ready')
    showNotification('error', 'Recording not ready')
    return
  }

  try {
    // `saveClipAndNotify` emits `clip-saved` itself, so every entry point (hotkey,
    // tray, button) refreshes the library the same way.
    await saveClipAndNotify(services)
  } catch (e) {
    log.error('Failed to save replay:', e)
    const wedged = errorMessage(e).includes('Timeout waiting for replay buffer')
    showNotification('error', wedged ? 'Recording stopped responding - restarting it...' : 'Failed to save clip')
    if (wedged) scheduleWedgeRecovery()
  }
}

async function saveScreenshotFromHotkey(): Promise<void> {
  try {
    await takeScreenshot(services)
  } catch (e) {
    log.error('Failed to take screenshot:', e)
    showNotification('error', 'Failed to take screenshot')
  }
}

// ---------------------------------------------------------------------------
// Services handed to the IPC layer
// ---------------------------------------------------------------------------

const services = {
  get obsCore() {
    return obsCore
  },
  get capture() {
    return capture
  },
  get replay() {
    return replay
  },
  get detector() {
    return detector
  },
  get audioMix() {
    return audioMix
  },
  get audioDevices() {
    return audioDevices
  },
  getMainWindow,
  saveClipHotkey: () => void saveFromHotkey(),
  takeScreenshotHotkey: () => saveScreenshotFromHotkey(),
  reinitPipeline,
  notify: (type: BufferStatus, message?: string) => showNotification(type, message),
  status: {
    get: () => currentStatus,
    set: (s: { status: ObsStatus; message?: string }) => setStatus(s),
  },
  openEditorWindow: (clipPath: string) => openEditorWindow(clipPath, PRELOAD, RENDERER_DIR),
  currentEditorClip,
  closeEditorWindow,
  saveEditorClip: (req: any) =>
    saveClip(req, {
      getMainWindow,
      onCopied: (p, recordedAt, source) =>
        setClipMeta(p, { recordedAt, source: source ?? undefined, edited: true, editedAt: Date.now() }),
      onReplaced: (p, editedAt) => setClipMeta(p, { edited: true, editedAt }),
      getClipMeta,
      getAudioTrackLabels: () => obsCore?.audioTrackLabels() ?? ['Mix'],
    }),
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

function main(): void {
  // Safe before ready: the log file, the scheme privilege table, and the protocol
  // client registration all only read command-line/config state.
  logger.init()
  declareClipScheme()

  process.defaultApp
    ? app.setAsDefaultProtocolClient('reflect', process.execPath, [path.resolve(process.argv[1])])
    : app.setAsDefaultProtocolClient('reflect')

  // Everything below needs a live app: `app.getPath('videos')` (default output
  // location), the session, and the `screen` module all throw before ready.
  // These callbacks are registered before bootstrap's, so ordering is preserved.
  app.whenReady().then(() => {
    buildPipeline()
    registerIpc(services as never)
    registerClipProtocol()
  })

  bootstrap({
    onSaveClip: saveFromHotkey,
    onInitPipeline: initPipeline,
    onPipelineWedge: async () => {
      detector?.stop()
      shutdownHotkeys()
      cleanupEditor()
      dismissPanel()
      await shutdownPipeline()
    },
    onResume: async () => {
      log.info('System resumed from sleep, reinitializing OBS...')
      try {
        await recoverFromWedge()
      } catch (e) {
        log.error('Failed to reinit after resume:', e)
      }
    },
  })

  // Hot-plugging a display or changing its scale invalidates cached endpoint and
  // monitor lists, so drop them and let the next query re-probe. The `screen` module
  // only exists after app-ready.
  app.whenReady().then(() => {
    const invalidateDisplays = () => invalidateDeviceCache()
    screen.on('display-added', invalidateDisplays)
    screen.on('display-removed', invalidateDisplays)
    screen.on('display-metrics-changed', invalidateDisplays)

    if (process.env.REFLECT_SELFTEST === '1') void runSelfTest()
    if (process.env.REFLECT_SELFTEST_RECORD === '1') void runRecordSelfTest()
    if (process.env.REFLECT_SELFTEST_SETTINGS === '1') void runSettingsSelfTest()
  })

/**
 * Times the two rebuild paths so the cost of a setting is a measured number.
 *
 * `full` restarts OBS outright; `chain` only rebuilds the replay chain. Which tier
 * a setting belongs to is a judgement about what actually has to be recreated, and
 * this measures both so that judgement can be checked instead of assumed.
 */
async function runSettingsSelfTest(): Promise<void> {
  if (!replay || !services) {
    log.error('REFLECT_SELFTEST_SETTINGS set without a replay buffer or services')
    app.exit(2)
    return
  }

  const time = async (label: string, fn: () => Promise<unknown>) => {
    const t0 = Date.now()
    try {
      await fn()
      log.info(`TIMING ${label}: ${Date.now() - t0}ms`)
    } catch (e) {
      log.error(`TIMING ${label}: FAILED after ${Date.now() - t0}ms - ${e instanceof Error ? e.message : e}`)
    }
  }

  try {
    await sleep(10_000)

    await time('chain rebuild', () => replay!.rebuildAndRestart())
    await time('chain rebuild (2nd)', () => replay!.rebuildAndRestart())
    await time('buffer duration', () => replay!.setBufferDuration(45))
    await time('buffer duration (2nd)', () => replay!.setBufferDuration(60))
    await time('full reinit', () => services.reinitPipeline())
    await time('full reinit (2nd)', () => services.reinitPipeline())

    fs.writeFileSync(path.join(app.getPath('temp'), 'reflect-settings-timing.txt'), 'done')
    log.info('SETTINGS TIMING: complete')
    app.exit(0)
  } catch (e) {
    log.error('SETTINGS TIMING failed:', e)
    app.exit(1)
  }
}

/**
 * Drives the continuous-recording path and exits.
 *
 * Separate from `runSelfTest` because it needs its own timing budget: it has to
 * start a real recording, hold it long enough to produce a measurable frame rate,
 * and stop it cleanly. It exercises the same `ReplayBuffer` methods the Record
 * button calls, so a pass means the button's path works.
 */
async function runRecordSelfTest(): Promise<void> {
  const outDir = process.env.REFLECT_SELFTEST_OUT
  if (!outDir || !replay) {
    log.error('REFLECT_SELFTEST_RECORD set without an output directory or replay buffer')
    app.exit(2)
    return
  }

  const seconds = Number(process.env.REFLECT_SELFTEST_RECORD_SECONDS ?? '10')

  try {
    log.info(`RECORD TEST: redirecting output to ${outDir}`)
    setSetting('outputPath', outDir)
    detector?.stop()
    setSetting('captureMode', 'display')
    setSetting('displayIndex', 0)
    if (obsCore) await obsCore.setOutputPath(outDir)
    if (capture) await capture.setMonitor(0)

    // Apply the requested frame rate so the harness can verify the real output
    // rate rather than whatever was left over from a previous run.
    const wantFps = Number(process.env.REFLECT_SELFTEST_FPS ?? '0')
    if (wantFps) {
      log.info(`RECORD TEST: requesting ${wantFps} fps`)
      setSetting('fps', wantFps)
      await services.reinitPipeline()
    }

    await sleep(12_000)

    log.info('RECORD TEST: starting continuous recording')
    await replay.startContinuousRecording()
    log.info('RECORD TEST: recording =', replay.isRecordingContinuously())

    if (process.env.REFLECT_SELFTEST_AUDIO === '1') {
      log.info('RECORD TEST: signalling harness to play tone')
      fs.writeFileSync(path.join(outDir, 'PLAY_TONE'), String(Date.now()))
    }

    await sleep(seconds * 1000)

    // A second start while running must be a no-op, not a corrupt restart.
    await replay.startContinuousRecording()

    log.info('RECORD TEST: stopping')
    const file = await replay.stopContinuousRecording()
    log.info(`RECORD TEST: saved ${file}`)
    fs.writeFileSync(path.join(outDir, 'RECORD_DONE'), file)

    await sleep(1500)
    log.info('RECORD TEST: complete')
    app.exit(0)
  } catch (e) {
    log.error('RECORD TEST failed:', e)
    fs.writeFileSync(path.join(outDir, 'RECORD_DONE'), `ERROR: ${e instanceof Error ? e.message : String(e)}`)
    app.exit(1)
  }
}

/**
 * Drives the real save/screenshot/library paths and exits.
 *
 * Only runs when REFLECT_SELFTEST is set, so it is inert in normal use. It
 * deliberately goes through `saveClipAndNotify` / `takeScreenshot` rather than
 * reimplementing them, so a pass means the shipped path works.
 */
async function runSelfTest(): Promise<void> {
  const outDir = process.env.REFLECT_SELFTEST_OUT
  if (!outDir) {
    log.error('REFLECT_SELFTEST set but REFLECT_SELFTEST_OUT is missing')
    app.exit(2)
    return
  }

  try {
    // Point the pipeline at the test directory and disable the game detector.
    // Auto-detect rewrites the capture source every few seconds when it mistakes a
    // fullscreen window for a game, and each switch rebuilds the replay chain — so
    // leaving it on would measure the detector, not the encoder.
    log.info(`SELFTEST: redirecting output to ${outDir}`)
    setSetting('outputPath', outDir)
    setSetting('screenshotPath', outDir)
    detector?.stop()
    setSetting('captureMode', 'display')
    setSetting('displayIndex', 0)
    if (obsCore) await obsCore.setOutputPath(outDir)
    if (capture) await capture.setMonitor(0)

    log.info('SELFTEST: accumulating 30s of footage...')
    await sleep(30_000)

    // With REFLECT_SELFTEST_AUDIO set, ask the harness to play a tone now so the
    // saved clip can be checked for real signal rather than just a valid stream.
    if (process.env.REFLECT_SELFTEST_AUDIO === '1') {
      log.info('SELFTEST: signalling harness to play tone')
      fs.writeFileSync(path.join(outDir, 'PLAY_TONE'), String(Date.now()))
      await sleep(14_000)
    }

    log.info('SELFTEST: buffer active =', replay?.isReplayBufferActive())

    const saved = await saveClipAndNotify(services)
    log.info(`SELFTEST: clip saved to ${saved}`)

    const shot = await takeScreenshot(services)
    log.info(`SELFTEST: screenshot saved to ${shot}`)

    const { scanClips } = require('./clip-manager.js')
    const clips = await scanClips(outDir)
    log.info(`SELFTEST: library reports ${clips.length} clip(s)`)

    await sleep(1500)
    log.info('SELFTEST: complete')
    app.exit(0)
  } catch (e) {
    log.error('SELFTEST: failed', e)
    app.exit(1)
  }
}

  for (const sig of ['SIGINT', 'SIGHUP'] as NodeJS.Signals[]) {
    process.on(sig, () => {
      log.info(`Received ${sig}, quitting`)
      app.quit()
    })
  }

  process.on('uncaughtException', (e) => {
    log.error('Uncaught exception:', e)
    try {
      require('electron').dialog.showErrorBox('Error', 'An unexpected error occurred. Please restart the application.')
    } catch {
      /* headless */
    }
  })

  process.on('unhandledRejection', (e) => {
    log.error('Unhandled rejection:', e)
  })

  // A suspended process that never tears down leaves the capture device locked.
  process.on('exit', () => {
    lifecycle.value = true
    invalidateDeviceCache()
    void startCapture
    void stopCapture
    void setSetting
    void showMainWindow
  })
}

main()
