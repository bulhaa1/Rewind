import { app, protocol, screen } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scope } from './logger.js'
import { bootstrap, getMainWindow, lifecycle, PRELOAD, RENDERER_DIR, showMainWindow } from './window.js'
import { log as logger } from './logger.js'
import { ObsCore, defaultOutputPath, rewindRoot, killObsChildren } from './obs-core.js'
import { ReplayBuffer } from './replay-buffer.js'
import { CaptureManager } from './capture.js'
import { GameDetector } from './game-detector.js'
import { AudioDeviceChannels, AudioMix, invalidateDeviceCache } from './audio.js'
import { notify, dismissPanel } from './notification.js'
import { installDefaultHotkeys, shutdown as shutdownHotkeys, startCapture, stopCapture } from './hotkey.js'
import {
  registerIpc,
  saveClipAndNotify,
  saveQuickClipAndNotify,
  takeScreenshot,
  outputRoot,
  OBS_STATUS_MESSAGES,
} from './ipc.js'
import { getClipMeta, setClipMeta } from './clip-meta.js'
import { openEditorWindow, currentEditorClip, closeEditorWindow, cleanupEditor, saveClip } from './editor.js'
import { getSetting, setSetting } from './store.js'
import { measureStreamVolume, probe } from './ffmpeg.js'
import { isInside } from './util.js'
import { Mutex, sleep, withTimeout } from './obs-bind.js'
import { TIMING, clampQuickClip } from '@shared/constants.js'
import type { BufferStatus, ObsStatus } from '@shared/types.js'

const log = scope('App')
const protocolLog = scope('ClipProtocol')

// ---------------------------------------------------------------------------
// Custom protocol
// ---------------------------------------------------------------------------

const CLIP_SCHEME = 'rewind-clip'
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
  previewRoot = path.join(os.tmpdir(), 'rewind-editor-preview')

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
    'save-quick-clip': () => void saveQuickClipFromHotkey(),
    screenshot: () => void saveScreenshotFromHotkey(),
    'toggle-record': () => void toggleRecordingFromHotkey(),
  })

  try {
    // Once at startup, before anything reads the library. Safe to repeat: the
    // legacy folders stop existing after the first run.
    require('./clip-manager.js').renameLegacySourceFolders(rewindRoot(getSetting('outputPath')))
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
async function reinitPipeline(reason?: string, opts: { preservePaused?: boolean } = {}): Promise<void> {
  await reinitMutex.run(async () => {
    /*
     * A rebuild boots the engine the way the app boots: buffer running. A user who
     * paused before changing a setting stays paused — the boot path cannot know
     * about the pause, and the alternative is a recording they did not ask for.
     * Wedge recovery deliberately does not pass this: its whole point is a live
     * buffer again.
     */
    const wasPaused = opts.preservePaused === true && currentStatus.status === 'paused'

    log.info(`Reinitializing OBS pipeline${reason ? ` (${reason})` : ''}...`)
    setStatus(reason ? { status: 'initializing', message: reason } : OBS_STATUS_MESSAGES.initializing, getMainWindow())

    try {
      await shutdownPipeline()
      buildPipeline()
      await startPipeline()
      if (wasPaused) {
        await replay!.pauseReplayBuffer()
        await capture!.pauseCapture()
      }
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
  if (!obsCore?.isInitialized() || !replay || !capture) {
    log.warn('Shortcut save ignored: recording not ready')
    showNotification('error', 'Recording not ready')
    return
  }

  // Kept separate from the guard above because the two mean different things and
  // only one of them is the user's to fix. `pipelineActive()` folds "the engine
  // is up" together with "the buffer is rolling", so a save with the buffer off
  // used to report "Recording not ready" -- which sends you looking for a
  // recording you never started. What actually happened is that you asked for a
  // clip when there was nothing rolling to take it from.
  if (!replay.isReplayBufferActive()) {
    log.warn('Shortcut save ignored: the rolling buffer is stopped')
    showNotification('error', 'Buffer is off - start it to save a clip')
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

/**
 * Ctrl+Alt+1: saves the last N seconds rather than the whole buffer.
 *
 * Goes through the same buffer guard as the plain save so an off buffer says so
 * plainly instead of surfacing whatever the flush would have thrown.
 */
async function saveQuickClipFromHotkey(): Promise<void> {
  if (!obsCore?.isInitialized() || !replay || !capture) {
    showNotification('error', 'Recording not ready')
    return
  }
  if (!replay.isReplayBufferActive()) {
    log.warn('Shortcut quick save ignored: the rolling buffer is stopped')
    showNotification('error', 'Buffer is off - start it to save a clip')
    return
  }

  try {
    await saveQuickClipAndNotify(services, clampQuickClip(getSetting('quickClipSeconds')))
  } catch (e) {
    log.error('Failed to save quick clip:', e)
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

/**
 * Starts or stops the replay buffer, from the panel button or the hotkey.
 *
 * One function for both, because the part that is easy to get wrong is
 * stopping: a continuous recording in flight has to be finished and registered
 * rather than dropped, and that has to happen identically whichever way the user
 * asked for it. A hotkey-only copy of this is how a stopped recording ends up
 * orphaned on disk with no entry in the library.
 *
 * Returns the resulting state so the panel can report it.
 */
/**
 * Registers a recording the buffer finished on teardown, and tells the renderer.
 *
 * Shared by the panel's Stop button (`setReplayBufferActive`) and the Start/Stop
 * hotkey. Both end the buffer, and both leave a finished recording unregistered
 * unless they say so here -- an unregistered recording sits in the library root
 * with no source and a timestamp guessed from its filename.
 */
function registerFinishedFromBufferStop(finished: string): void {
  if (!obsCore || !capture) throw new Error('Recording not ready')
  const sourceName = capture.getCurrentSourceName()
  const moved = require('./clip-manager.js').registerFinishedRecording(
    finished,
    sourceName,
    obsCore.getConfig().outputPath,
    obsCore.audioTrackLabels(),
  )
  services.getMainWindow()?.webContents.send('clip-saved', { clipPath: moved })
  log.info(`Recording finished because the buffer stopped: ${moved}`)
}

/**
 * Stops the manual recording and puts the finished clip in the library.
 *
 * Lives here rather than in the IPC layer because the hotkey and the panel
 * button both stop recordings, and they must not drift apart in what they do
 * with the file afterwards.
 */
async function stopRecordingAndRegister(): Promise<string> {
  if (!replay || !obsCore || !capture) throw new Error('Recording not ready')
  const file = await replay.stopContinuousRecording()
  const sourceName = capture.getCurrentSourceName()
  const cm = require('./clip-manager.js')
  const moved = cm.registerFinishedRecording(
    file,
    sourceName,
    obsCore.getConfig().outputPath,
    obsCore.audioTrackLabels(),
  )
  services.getMainWindow()?.webContents.send('clip-saved', { clipPath: moved })

  void cm
    .describeSavedClip(moved, replay.getActiveEncoderVendor(), replay.getActiveEncoder(), replay.getQualityTarget(), sourceName)
    .then((info: { durationSec: number } | null) => cm.stampDuration(moved, info?.durationSec))
    .catch(() => {
      /* diagnostics only */
    })

  log.info(`Recording saved: ${moved}`)
  return moved
}

/**
 * One key does both halves of manual recording: press once to start, again to
 * stop. This is what Alt+3 drives now.
 *
 * It replaced the rolling-buffer toggle, so the buffer keeps running throughout a
 * recording and is still there for clipping afterwards.
 */
let recordingToggleInFlight = false

async function toggleRecordingForUser(): Promise<{ recording: boolean }> {
  if (!replay || !obsCore) throw new Error('Recording not ready')

  if (replay.isRecordingContinuously?.()) {
    await stopRecordingAndRegister()
    showNotification('saved')
    return { recording: false }
  }

  await replay.startContinuousRecording()
  showNotification('recorded')
  return { recording: true }
}

async function toggleRecordingFromHotkey(): Promise<void> {
  if (recordingToggleInFlight) return
  recordingToggleInFlight = true
  try {
    await toggleRecordingForUser()
  } catch (e) {
    log.error('Failed to toggle recording:', e)
    showNotification('error', 'Recording not ready')
  } finally {
    recordingToggleInFlight = false
  }
}

async function toggleReplayForUser(): Promise<{ active: boolean }> {
  const buffer = replay
  if (!obsCore || !buffer || !capture) throw new Error('Recording not ready')

  if (buffer.isReplayBufferActive()) {
    await buffer.pauseReplayBuffer()
    await capture.pauseCapture()
    services.status.set(OBS_STATUS_MESSAGES.paused)

    // Stopping while a continuous recording was running finishes that recording
    // rather than discarding it. The stitching happens inside replay-buffer
    // because it needs the output still alive; registering the file in the
    // library and telling the renderer is this layer's job.
    const finished = buffer.takeFinishedOnTeardown?.() ?? null
    if (finished) {
      try {
        registerFinishedFromBufferStop(finished)
      } catch (e) {
        log.error('Recording finished by buffer stop but could not be registered:', e)
      }
    }
  } else {
    await capture.resumeCapture()
    services.status.set(OBS_STATUS_MESSAGES.ready)
  }

  const win = services.getMainWindow()
  win?.webContents.send('obs-status', services.status.get())
  return { active: buffer.isReplayBufferActive() }
}

/**
 * Hotkey wrapper around {@link toggleReplayForUser}.
 *
 * Guarded against re-entry: a held key delivers repeats, and a second
 * startReplayBuffer() while one is still initialising races on the same OBS
 * scene.
 */
let replayToggleInFlight = false

async function toggleReplayFromHotkey(): Promise<void> {
  if (replayToggleInFlight) return
  replayToggleInFlight = true
  try {
    const { active } = await toggleReplayForUser()
    showNotification(active ? 'buffer-on' : 'buffer-off')
  } catch (e) {
    log.error('Failed to toggle recording:', e)
    showNotification('error', 'Recording not ready')
  } finally {
    replayToggleInFlight = false
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
  /** Shared by the panel's toggle and the start/stop hotkey. */
  toggleReplay: () => toggleReplayForUser(),
  toggleRecording: () => toggleRecordingForUser(),
  saveQuickClip: () => saveQuickClipAndNotify(services, clampQuickClip(getSetting('quickClipSeconds'))),
  /**
   * Registers a recording the buffer finished on teardown.
   *
   * `ipc.ts` needs this for the panel's Stop button, which pauses the buffer
   * through `setReplayBufferActive` rather than going through
   * `toggleReplayForUser`, and so never touched `finishedOnTeardown`.
   */
  registerFinishedFromBufferStop,
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
      getAudioTrackLabels: () => getClipMeta(currentEditorClip()?.clipPath ?? '')?.audioTracks ?? ['Mix'],
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
    ? app.setAsDefaultProtocolClient('rewind', process.execPath, [path.resolve(process.argv[1])])
    : app.setAsDefaultProtocolClient('rewind')

  // Everything below needs a live app: `app.getPath('videos')` (default output
  // location), the session, and the `screen` module all throw before ready.
  // These callbacks are registered before bootstrap's, so ordering is preserved.
  app.whenReady().then(() => {
    buildPipeline()
    registerIpc(services as never)
    registerClipProtocol()
    // Pushes the initial update state to the panel. This does not check for
    // updates -- it only reports whether checking is possible at all, which in a
    // dev build it is not. No network call happens here.
    require('./updater.js').initUpdater((state: unknown) => {
      getMainWindow()?.webContents.send('update-state', state)
    })
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

    /*
     * Resolution changes also have to reach OBS.
     *
     * This used to be invalidateDisplays alone, which only refreshed the
     * settings UI list. The capture canvas was sized once at startup and never
     * again, so changing resolution left OBS rendering a canvas of the old size
     * around a source of the new one -- which OBS resolves by scaling and
     * cropping. That was the black half-screen, the zoomed-in crop, and the
     * part of a virtual display going missing. Restarting appeared to fix it
     * because startup re-runs the sizing.
     *
     * Debounced: Windows emits several metrics events for one resolution change
     * (and one for changes that do not alter size at all), and each real sync
     * resets the OBS video context.
     */
    let canvasSyncTimer: NodeJS.Timeout | null = null
    const syncCanvasToDisplay = () => {
      if (canvasSyncTimer) clearTimeout(canvasSyncTimer)
      canvasSyncTimer = setTimeout(() => {
        canvasSyncTimer = null
        try {
          services.capture?.syncCanvasToDisplay()
        } catch (e) {
          // Never let a display event take the app down with it.
          console.error('Failed to sync the capture canvas to a display change:', e)
        }
      }, 750)
    }

    screen.on('display-added', invalidateDisplays)
    screen.on('display-removed', invalidateDisplays)
    screen.on('display-metrics-changed', () => {
      invalidateDisplays()
      syncCanvasToDisplay()
    })

    if (process.env.REWIND_SELFTEST === '1') void runSelfTest()
    if (process.env.REWIND_SELFTEST_RECORD === '1') void runRecordSelfTest()
    if (process.env.REWIND_SELFTEST_SETTINGS === '1') void runSettingsSelfTest()
    if (process.env.REWIND_SELFTEST_AUDIOTRACKS === '1') void runAudioTrackSelfTest()
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
    log.error('REWIND_SELFTEST_SETTINGS set without a replay buffer or services')
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

    fs.writeFileSync(path.join(app.getPath('temp'), 'rewind-settings-timing.txt'), 'done')
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
  const outDir = process.env.REWIND_SELFTEST_OUT
  if (!outDir || !replay) {
    log.error('REWIND_SELFTEST_RECORD set without an output directory or replay buffer')
    app.exit(2)
    return
  }

  const seconds = Number(process.env.REWIND_SELFTEST_RECORD_SECONDS ?? '10')

  // Declared out here rather than inside the try: block-scoped consts are not
  // visible to a sibling finally, and the whole point is to reach them on the way out.
  const realOutputPath = getSetting('outputPath')
  const realScreenshotPath = getSetting('screenshotPath')

  // app.exit() does not unwind the stack, so it cannot be called from the try.
  let exitCode = 0

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
    const wantFps = Number(process.env.REWIND_SELFTEST_FPS ?? '0')
    if (wantFps) {
      log.info(`RECORD TEST: requesting ${wantFps} fps`)
      setSetting('fps', wantFps)
      await services.reinitPipeline()
    }

    await sleep(12_000)

    log.info('RECORD TEST: starting continuous recording')
    await replay.startContinuousRecording()
    log.info('RECORD TEST: recording =', replay.isRecordingContinuously())

    if (process.env.REWIND_SELFTEST_AUDIO === '1') {
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
    exitCode = 0
  } catch (e) {
    log.error('RECORD TEST failed:', e)
    fs.writeFileSync(path.join(outDir, 'RECORD_DONE'), `ERROR: ${e instanceof Error ? e.message : String(e)}`)
    exitCode = 1
  } finally {
    // See runSelfTest: these settings persist, and the process exits immediately
    // above, so an unrestored redirect leaves the app saving into temp forever.
    if (realOutputPath) {
      setSetting('outputPath', realOutputPath)
      await obsCore?.setOutputPath(realOutputPath).catch(() => {})
    }
    if (realScreenshotPath) setSetting('screenshotPath', realScreenshotPath)
    log.info('RECORD TEST: restored the configured output folders')
  }

  app.exit(exitCode)
}

/**
 * Records with the default audio layout and measures the saved file.
 *
 * Split tracks are unconditional as of 1.1.0, so there is nothing to force: this
 * asserts what a normal recording produces, and `REWIND_SELFTEST_MIC=absent` runs
 * the same thing with a microphone that cannot resolve, which is how the
 * "one fewer track" branch is exercised without unplugging hardware.
 *
 * A tone is played during the window so the desktop track has something
 * measurable in it, and the stream layout and per-stream loudness are reported.
 * Exit code: 0 when the file has at least two audio streams, 1 when it has fewer, 2 on
 * a harness failure. Only the stream count gates it — whether the tracks hold
 * *different* audio is a judgement the caller makes from the two numbers together.
 */
async function runAudioTrackSelfTest(): Promise<void> {
  const outDir = process.env.REWIND_SELFTEST_OUT
  if (!outDir || !replay) {
    log.error('REWIND_SELFTEST_AUDIOTRACKS set without an output directory or replay buffer')
    app.exit(2)
    return
  }

  // Out here, not inside the try, so the finally below can see them. Every one of
  // these is persisted, and app.exit() does not unwind the stack, so an unrestored
  // value would outlive the run: the app would keep splitting tracks, keep saving to
  // the temp directory, or keep capturing a display the user did not choose.
  const realOutputPath = getSetting('outputPath')
  const realCaptureMode = getSetting('captureMode')
  const realDisplayIndex = getSetting('displayIndex')
  const realMicDeviceId = getSetting('micDeviceId')

  /*
   * There is no longer a setting to force. The test asserts what the default
   * configuration produces, which is the only thing worth asserting now: split
   * tracks are unconditional.
   *
   * `REWIND_SELFTEST_MIC=absent` points the microphone at a device id that does
   * not resolve, which is how the "no capturable microphone means one fewer
   * track" case gets exercised without unplugging hardware.
   */
  const micAbsent = process.env.REWIND_SELFTEST_MIC === 'absent'

  let exitCode = 0

  try {
    log.info(`AUDIO TRACK TEST: redirecting output to ${outDir}`)
    setSetting('outputPath', outDir)
    if (micAbsent) setSetting('micDeviceId', '__rewind_selftest_no_such_device__')
    // Auto-detect rewrites the capture source every few seconds and each switch
    // rebuilds the replay chain, which would measure the detector instead of the
    // encoder.
    detector?.stop()
    setSetting('captureMode', 'display')
    setSetting('displayIndex', 0)

    // The mixer mask is baked into the replay chain when it is built, so the setting
    // has to be in place *before* the rebuild rather than after it.
    await services.reinitPipeline('audio track self-test')

    log.info(
      `AUDIO TRACK TEST: mask=0b${(obsCore?.audioTrackMask() ?? 0).toString(2)} ` +
        `labels=${JSON.stringify(obsCore?.audioTrackLabels() ?? [])}`,
    )

    log.info('AUDIO TRACK TEST: accumulating audio...')
    await sleep(12_000)

    // Signal the harness to play a tone now, so the desktop track has known signal and
    // the microphone track does not. Without this both tracks measure whatever the
    // room happened to be doing, and a silent machine reports two identical zeros.
    if (process.env.REWIND_SELFTEST_AUDIO === '1') {
      log.info('AUDIO TRACK TEST: signalling harness to play tone')
      fs.writeFileSync(path.join(outDir, 'PLAY_TONE'), String(Date.now()))
      await sleep(18_000)
    }

    log.info(`AUDIO TRACK TEST: buffer active = ${replay.isReplayBufferActive()}`)
    const file = await replay.saveReplayBuffer('display')
    log.info(`AUDIO TRACK TEST: saved ${file}`)

    const info = await probe(file)
    if (!info) throw new Error('ffprobe could not read the saved clip')

    const audio = info.streams.filter((s) => s.codec_type === 'audio')
    log.info(`AUDIO TRACK TEST: ${audio.length} audio stream(s), tags=${JSON.stringify(audio.map((s) => s.tags ?? {}))}`)

    const meanVolumes: (number | null)[] = []
    let measurementFailed = false
    for (let i = 0; i < audio.length; i++) {
      const v = await measureStreamVolume(file, i)
      // A failed measurement must not be recorded as a silent stream: the two look the
      // same in the report, and a silent stream is a claim about the audio while a
      // failure is a claim about the harness.
      if (!v.ok) {
        measurementFailed = true
        meanVolumes.push(null)
        log.error(`AUDIO TRACK TEST: audio stream ${i} could not be measured: ${v.error}`)
        continue
      }
      meanVolumes.push(v.meanDb)
      log.info(`AUDIO TRACK TEST: audio stream ${i}: mean=${v.meanDb ?? '-inf'} dB max=${v.maxDb ?? '-inf'} dB`)
    }

    // `micAbsent` is what was requested, not what came out: the stream count is the
    // evidence, and collapsing the two would hide a broken gate behind a true flag.
    const report = {
      micAbsent,
      streamCount: audio.length,
      streamLabels: audio.map((s) => s.tags?.handler_name ?? s.tags?.title ?? null),
      meanVolumes,
      // Travels with the numbers so a reader of the JSON can tell "this track is
      // silent" from "this track was never measured".
      measurementFailed,
    }
    fs.writeFileSync(path.join(outDir, 'audiotracks-report.json'), JSON.stringify(report, null, 2))
    fs.writeFileSync(path.join(outDir, 'AUDIOTRACKS_DONE'), file)
    log.info(`AUDIO TRACK TEST: ${JSON.stringify(report)}`)

    // Both cases are judged by a count, and both can fail. With a capturable
    // microphone the file must carry at least two streams; without one it must
    // carry exactly two (mix + desktop) and no third. The second is what proves
    // the gate is a real condition rather than a constant: if the microphone bit
    // were always set, "no microphone" would also produce three.
    if (measurementFailed) {
      exitCode = 2
    } else if (micAbsent) {
      exitCode = audio.length === 2 ? 0 : 1
    } else {
      exitCode = audio.length >= 3 ? 0 : 1
    }
  } catch (e) {
    log.error('AUDIO TRACK TEST failed:', e)
    try {
      fs.writeFileSync(path.join(outDir, 'AUDIOTRACKS_DONE'), `ERROR: ${errorMessage(e)}`)
    } catch {
      /* the harness cannot even read its own directory */
    }
    exitCode = 2
  } finally {
    log.info(
      `AUDIO TRACK TEST: restoring output=${realOutputPath ?? 'UNDEFINED'} ` +
        `captureMode=${realCaptureMode} displayIndex=${realDisplayIndex} micDeviceId=${realMicDeviceId}`,
    )
    if (micAbsent) setSetting('micDeviceId', realMicDeviceId)
    // The capture source was switched the same way the other two were, through the
    // same persisted store, so it is restored the same way. Skipping these two left a
    // user on 'game' or on their second monitor permanently recording display 0.
    setSetting('captureMode', realCaptureMode)
    setSetting('displayIndex', realDisplayIndex)
    if (realOutputPath) {
      setSetting('outputPath', realOutputPath)
      await obsCore?.setOutputPath(realOutputPath).catch(() => {})
    }
  }

  app.exit(exitCode)
}

/**
 * Drives the real save/screenshot/library paths and exits.
 *
 * Only runs when REWIND_SELFTEST is set, so it is inert in normal use. It
 * deliberately goes through `saveClipAndNotify` / `takeScreenshot` rather than
 * reimplementing them, so a pass means the shipped path works.
 */
async function runSelfTest(): Promise<void> {
  const outDir = process.env.REWIND_SELFTEST_OUT
  if (!outDir) {
    log.error('REWIND_SELFTEST set but REWIND_SELFTEST_OUT is missing')
    app.exit(2)
    return
  }

  // Out here, not inside the try, so the finally below can see them.
  const realOutputPath = getSetting('outputPath')
  const realScreenshotPath = getSetting('screenshotPath')

  // `app.exit()` terminates the process immediately and does not unwind the stack,
  // so calling it from inside the try meant the finally never ran and the settings
  // stayed redirected. The exit is deferred until after the restore instead.
  let exitCode = 0

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

    // With REWIND_SELFTEST_AUDIO set, ask the harness to play a tone now so the
    // saved clip can be checked for real signal rather than just a valid stream.
    if (process.env.REWIND_SELFTEST_AUDIO === '1') {
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
    exitCode = 0
  } catch (e) {
    log.error('SELFTEST: failed', e)
    exitCode = 1
  } finally {
    // Put the user's real folders back.
    //
    // These settings are persisted, and the process exits a few lines above, so
    // without this a single `npm run selftest` left the app permanently writing
    // clips and screenshots into the temp directory. Nothing warned: the app
    // simply stopped saving where the user had asked it to, and the library view
    // showed the handful of test files instead.
    log.info(
      `SELFTEST: restoring output folders (output=${realOutputPath ?? 'UNDEFINED'}, screenshots=${realScreenshotPath ?? 'UNDEFINED'})`,
    )
    if (realOutputPath) {
      setSetting('outputPath', realOutputPath)
      await obsCore?.setOutputPath(realOutputPath).catch(() => {})
    }
    if (realScreenshotPath) setSetting('screenshotPath', realScreenshotPath)
    log.info('SELFTEST: restored the configured output folders')
  }

  app.exit(exitCode)
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
