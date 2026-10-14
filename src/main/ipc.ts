import { app, ipcMain, shell, dialog, BrowserWindow, screen, clipboard } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { scope } from './logger.js'
import { IPC } from '@shared/ipc.js'
import {
  ALLOWED_FPS,
  BUFFER_DURATION_MAX,
  BUFFER_DURATION_MIN,
  DEFAULT_SETTINGS,
  MIC_GAIN,
  QUICK_CLIP_MAX,
  QUICK_CLIP_MIN,
  SCREENSHOT_SUBDIR,
  VISUAL_QUALITIES,
  clampQuickClip,
} from '@shared/constants.js'
import { getSetting, setSetting } from './store.js'
import { hotkeyTitle } from './hotkey.js'
import { getClipMeta, getScreenshotMeta, setScreenshotMeta, deleteScreenshotMeta } from './clip-meta.js'
import { captureScreenshot } from './ffmpeg.js'
import { isInside, isWritable, nonEmptyString } from './util.js'
import type { Profile } from '@shared/types.js'
import { defaultOutputPath, rewindRoot } from './obs-core.js'
import { channelLevel, deviceAvailable, listAudioApps, listDevices, channelDevices } from './audio.js'
import type {
  AudioChannel,
  BufferStatus,
  CaptureMode,
  DeleteScope,
  DeviceKind,
  FolderKind,
  HotkeyAction,
  IpcResult,
  ObsStatus,
  ScreenshotInfo,
} from '@shared/types.js'

const log = scope('IPC')
const filesLog = scope('Files')
const bufferLog = scope('Buffer')
const replayLog = scope('Replay')

export type ErrorCode = 'obs-not-initialized' | 'obs-wedged-recovering'

/** Wraps a payload in the uniform result envelope the preload bridge expects. */
export function ok<T>(data?: T): IpcResult<T> {
  return data === undefined ? ({ success: true } as IpcResult<T>) : ({ success: true, data } as IpcResult<T>)
}

export function fail(error: string, code?: ErrorCode): IpcResult<never> {
  return { success: false, error, code }
}

/** Runs a handler, converting any throw into a failed result with a logged reason. */
async function handle<A extends unknown[], R>(
  channel: string,
  fn: (...args: A) => Promise<R> | R,
): Promise<void> {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      const result = await fn(...(args as A))

      // A handler that returns nothing resolves the renderer call to `undefined`,
      // which then blows up in the caller as "Cannot read properties of undefined".
      // Normalising here turns that into a clean failure and names the channel.
      if (result === undefined || result === null) {
        log.error(`IPC ${channel} returned no result; converting to a failure`)
        return fail('This action is not supported yet')
      }
      return result
    } catch (e) {
      log.error(`IPC ${channel} failed:`, e)
      const message = e instanceof Error ? e.message : String(e)
      return fail(message)
    }
  })
}

/** Synonym used by the original for logging a message before failing. */
const note = (msg: string) => log.warn(msg)

// ---------------------------------------------------------------------------
// Services passed in from index.ts
// ---------------------------------------------------------------------------

export interface Services {
  obsCore: any
  capture: any
  replay: any
  detector: any
  audioMix: any
  audioDevices: any
  getMainWindow: () => BrowserWindow | null
  saveClipHotkey: () => void
  takeScreenshotHotkey: () => Promise<void>
  /** Starts or stops the replay buffer. Shared with the start/stop hotkey. */
  toggleReplay: () => Promise<{ active: boolean }>
  /** Starts or stops the manual recording. Driven by the Start/Stop Recording hotkey. */
  toggleRecording: () => Promise<void>
  /** Stops a running recording and registers the file. The panel's Stop button. */
  stopRecording: () => Promise<string>
  /** Saves the last N seconds of the buffer. Hotkey-only (startup and rebind). */
  saveQuickClip: () => Promise<void>
  /**
   * Registers a recording the buffer finished on teardown.
   *
   * Called by `setReplayBufferActive(false)`, which the panel's Stop button
   * uses. That path pauses the buffer directly rather than going through
   * `toggleReplay`, so nothing else consumes `finishedOnTeardown` for it.
   */
  registerFinishedFromBufferStop: (finished: string) => void
  /** Switches to a profile and returns the index that ended up applied. */
  applyProfile: (index: number) => Promise<number>
  getProfiles: () => { profiles: Profile[]; activeProfile: number }
  reinitPipeline: (reason?: string, opts?: { preservePaused?: boolean }) => Promise<void>
  /** `title` names the action and key on hotkey popups; `message` is the body line. */
  notify: (type: BufferStatus, message?: string, title?: string) => void
  status: {
    get: () => { status: ObsStatus; message?: string }
    set: (s: { status: ObsStatus; message?: string }) => void
  }
  openEditorWindow: (clipPath: string) => void
  currentEditorClip: () => { clipPath: string } | null
  closeEditorWindow: () => void
  saveEditorClip: (req: any) => Promise<string>
}

/** Human names for settings, so restart messages read as English. */
const SETTING_LABELS: Record<string, string> = {
  fps: 'frame rate',
  outputResolution: 'output resolution',
  videoEncoder: 'encoder',
  videoCodec: 'codec',
  visualQuality: 'visual quality',
  nvencPreset: 'encoder preset',
  nvencMultipass: 'multipass setting',
}

export const OBS_STATUS_MESSAGES = {
  initializing: { status: 'initializing' as ObsStatus },
  ready: { status: 'ready' as ObsStatus },
  paused: { status: 'paused' as ObsStatus },
  saving: { status: 'saving' as ObsStatus },
  changingSource: { status: 'initializing' as ObsStatus, message: 'Switching capture source...' },
  changingSettings: { status: 'initializing' as ObsStatus, message: 'Rebuilding the replay buffer with your new settings...' },
}

export function registerIpc(s: Services): void {
  /**
   * These services are replaced wholesale on every OBS reinit, so they must be read
   * through `s` at each use. Capturing them here (the obvious-looking version) left
   * every handler talking to the disposed instance after a settings change, which
   * surfaced as "OBS not initialized" while the log showed a healthy restart.
   */
  const obsCore = () => s.obsCore
  const capture = () => s.capture
  const replay = () => s.replay
  const detector = () => s.detector
  const audioMix = () => s.audioMix
  const audioDevices = () => s.audioDevices

  /**
   * Runs `fn` while broadcasting a transient status, then reports the truth.
   *
   * The restore step used to be an unconditional `finally`, so a settings change
   * that threw still left the panel reading "ready" over a dead buffer. Every
   * caller reports the real outcome through its own return value, so the status
   * now follows the same rule `reinitPipeline` already uses: `ready` only when
   * there is genuinely a buffer running behind it, otherwise `paused`.
   */
  const withStatus = async <T>(status: { status: ObsStatus; message?: string }, fn: () => Promise<T>): Promise<T> => {
    const win = s.getMainWindow()
    s.status.set(status)
    win?.webContents.send('obs-status', status)
    try {
      return await fn()
    } finally {
      const settled = replay().isReplayBufferActive() ? OBS_STATUS_MESSAGES.ready : OBS_STATUS_MESSAGES.paused
      s.status.set(settled)
      win?.webContents.send('obs-status', settled)
    }
  }

  /**
   * Returns a failure result when OBS isn't ready, or null when it is.
   *
   * Callers return this instead of throwing: a handler that throws surfaces as an
   * exception in the renderer's error toast rather than the intended message, which
   * is how the record toggle ended up reporting a bare "not-ready" error.
   */
  const notReady = (): IpcResult<never> | null =>
    obsCore().isInitialized() ? null : fail('OBS not initialized', 'obs-not-initialized')

  // -------------------------------------------------------------------------
  // Replay / buffer
  // -------------------------------------------------------------------------

  handle(IPC.saveReplay, async () => {
    const blocked = notReady()
    if (blocked) return blocked
    return ok(await saveClipAndNotify(s))
  })

  handle(IPC.takeScreenshot, async () => ok(await takeScreenshot(s)))

  handle(IPC.toggleReplayBuffer, async () => {
    const blocked = notReady()
    if (blocked) return blocked
    // The logic lives in main/index.ts so the start/stop hotkey runs the identical
    // path. Duplicating it here is how the hotkey and the panel end up disagreeing
    // about whether a continuous recording gets finished or dropped on the floor.
    try {
      return ok(await s.toggleReplay())
    } catch (e) {
      bufferLog.error('Failed to toggle replay buffer:', e)
      return fail(messageOf(e), wedgedIfNeeded(e))
    }
  })

  handle(IPC.getStatus, () => ok(s.status.get()))

  // -------------------------------------------------------------------------
  // Continuous recording
  // -------------------------------------------------------------------------

  handle(IPC.startRecording, async () => {
    const blocked = notReady()
    if (blocked) return blocked
    if (replay().isRecordingContinuously?.()) return ok({ alreadyRecording: true })

    try {
      await replay().startContinuousRecording()
      return ok({ started: true })
    } catch (e) {
      replayLog.error('Failed to start recording:', e)
      return fail(messageOf(e))
    }
  })

  handle(IPC.stopRecording, async () => {
    if (!replay().isRecordingContinuously?.()) return fail('Not currently recording')

    try {
      // One implementation with the start/stop hotkey, so the two cannot drift in
      // what they do with the finished file.
      return ok({ outputPath: await s.stopRecording() })
    } catch (e) {
      replayLog.error('Failed to stop recording:', e)
      return fail(messageOf(e))
    }
  })

  handle(IPC.getRecordingState, () =>
    ok({
      recording: replay().isRecordingContinuously?.() ?? false,
      elapsedMs: replay().continuousElapsedMs?.() ?? 0,
    }),
  )

  handle(IPC.getConfig, () => ok(obsCore().getConfig()))

  /**
   * Explicitly starts or stops the rolling buffer.
   *
   * Separate from the toggle because a toggle can only ever express "do the
   * opposite of now". Two buttons that both stay enabled whichever state the
   * buffer is in need idempotence: pressing Start on a running buffer should do
   * nothing rather than silently pause it.
   */
  handle(IPC.setReplayBufferActive, async (active: unknown) => {
    const blocked = notReady()
    if (blocked) return blocked
    const want = active === true

    try {
      if (want === replay().isReplayBufferActive()) {
        return ok({ active: want, changed: false })
      }

      if (want) {
        // Resume re-installs the capture source the pause removed; the buffer start
        // rides on that install, so pausing genuinely stops the capture stack.
        await capture().resumeCapture()
        s.status.set(OBS_STATUS_MESSAGES.ready)
      } else {
        await replay().pauseReplayBuffer()
        await capture().pauseCapture()
        s.status.set(OBS_STATUS_MESSAGES.paused)

        /*
         * Pausing finishes a continuous recording rather than discarding it, and
         * parks the path in `finishedOnTeardown`. Registering it is this layer's
         * job -- the stitching needs the output still alive and so happens inside
         * replay-buffer. Without this the panel's Stop button leaves the finished
         * clip in the library root, unregistered, and it surfaces only on a later
         * rescan with its timestamp guessed from the filename.
         *
         * Read after the await: `destroyRunningChain` populates it during the
         * pause, so reading before would always see null.
         */
        const finished = replay().takeFinishedOnTeardown?.() ?? null
        if (finished) {
          try {
            s.registerFinishedFromBufferStop(finished)
          } catch (e) {
            bufferLog.error('Recording finished by buffer stop but could not be registered:', e)
          }
        }
      }

      s.getMainWindow()?.webContents.send('obs-status', s.status.get())
      return ok({ active: replay().isReplayBufferActive(), changed: true })
    } catch (e) {
      bufferLog.error(`Failed to ${want ? 'start' : 'stop'} replay buffer:`, e)
      return fail(messageOf(e), wedgedIfNeeded(e))
    }
  })

  handle(IPC.isReplayBufferActive, () =>
    ok({ active: replay().isReplayBufferActive(), startedAt: replay().bufferStartedAt() }))

  handle(IPC.getBufferDuration, () =>
    ok(obsCore().isInitialized() ? obsCore().getConfig().bufferDuration : getSetting('bufferDuration')),
  )

  handle(IPC.setBufferDuration, async (seconds: unknown) => {
    if (!isBufferDuration(seconds)) {
      return fail(`Buffer duration must be between ${BUFFER_DURATION_MIN} and ${BUFFER_DURATION_MAX} seconds`)
    }
    const blocked = notReady()
    if (blocked) return blocked
    try {
      return await withStatus(OBS_STATUS_MESSAGES.changingSettings, async () => {
        obsCore().setBufferDuration(seconds)
        await replay().setBufferDuration(seconds)
        setSetting('bufferDuration', seconds)
        require('./profiles.js').captureActiveProfileValues()
        return ok()
      })
    } catch (e) {
      bufferLog.error('Failed to set duration:', e)
      return fail(messageOf(e), wedgedIfNeeded(e))
    }
  })

  handle(IPC.recoverReplayBuffer, async () => {
    const blocked = notReady()
    if (blocked) return blocked
    try {
      await replay().recover()
      const win = s.getMainWindow()
      win?.webContents.send('obs-status', OBS_STATUS_MESSAGES.ready)
      return ok()
    } catch (e) {
      bufferLog.error('Failed to recover replay buffer:', e)
      return fail(messageOf(e), wedgedIfNeeded(e))
    }
  })

  handle(IPC.reinitOBS, async () => {
    try {
      await s.reinitPipeline()
      if (pipelineReady(obsCore, replay)) return ok()
      return fail('OBS reinit completed but buffer is not active')
    } catch (e) {
      log.error('Failed to reinit OBS:', e)
      return fail(messageOf(e))
    }
  })

  handle(IPC.retryOBSInit, async () => {
    if (pipelineReady(obsCore, replay)) return ok({ alreadyReady: true })
    log.info('Retrying OBS initialization...')
    await s.reinitPipeline()
    return ok({ success: pipelineReady(obsCore, replay) })
  })

  // -------------------------------------------------------------------------
  // Capture sources
  // -------------------------------------------------------------------------

  handle(IPC.getDisplays, () => {
    const list = capture().getMonitors?.() ?? []
    if (list.length > 0) return ok(list)
    // OBS not up yet: fall back to Electron's own enumeration so the picker is usable.
    const primary = screen.getPrimaryDisplay()
    return ok(
      screen.getAllDisplays().map((d: Electron.Display, i: number) => ({
        id: String(i),
        name: `Display ${i + 1}${d.id === primary.id ? ' (Primary)' : ''}`,
        width: Math.round(d.bounds.width * (d.scaleFactor || 1)),
        height: Math.round(d.bounds.height * (d.scaleFactor || 1)),
        isPrimary: d.id === primary.id,
      })),
    )
  })

  handle(IPC.getWindows, () => {
    if (!obsCore().isInitialized() || !capture) return ok([])
    try {
      return ok(capture().refreshWindowList().map((w: any) => ({ id: w.value, name: w.name })))
    } catch (e) {
      log.error('Failed to get windows:', e)
      return ok([])
    }
  })

  handle(IPC.setDisplay, async (index: unknown) => {
    if (!isIndex(index)) return fail('Invalid display index')
    const blocked = notReady()
    if (blocked) return blocked
    if (index >= (capture().getMonitors?.()?.length ?? 0)) return fail('Display index out of range')
    try {
      return await withStatus(OBS_STATUS_MESSAGES.changingSource, async () => {
        capture().stopGameDetector()
        await capture().setMonitor(index)
        const store = require('./store.js')
        store.setSetting('captureMode', 'display')
        store.setSetting('displayIndex', index)
        store.setSetting('windowName', null)
        filesLog.info(`Display set to index: ${index}`)
        return ok()
      })
    } catch (e) {
      log.error('Failed to set display:', e)
      return fail(messageOf(e))
    }
  })

  handle(IPC.setWindow, async (windowId: unknown) => {
    if (typeof windowId !== 'string' || windowId.length === 0 || windowId.length >= 1000) {
      return fail('Invalid window ID')
    }
    const blocked = notReady()
    if (blocked) return blocked
    try {
      return await withStatus(OBS_STATUS_MESSAGES.changingSource, async () => {
        const windows = capture().refreshWindowList()
        await capture().setWindow(windowId)
        const store = require('./store.js')
        store.setSetting('captureMode', 'window')
        store.setSetting('windowId', windowId)
        store.setSetting('windowName', windows.find((w: any) => w.value === windowId)?.name ?? null)
        return ok()
      })
    } catch (e) {
      log.error('Failed to set window:', e)
      return fail(messageOf(e))
    }
  })

  handle(IPC.setGameCapture, async () => {
    const blocked = notReady()
    if (blocked) return blocked
    try {
      const store = require('./store.js')
      const index = store.getSetting('displayIndex') as number
      return await withStatus(OBS_STATUS_MESSAGES.changingSource, async () => {
        await capture().setAutoDetectCapture(index)
        store.setSetting('captureMode', 'game')
        store.setSetting('windowId', null)
        store.setSetting('windowName', null)
        log.info('Auto detect game capture enabled')
        return ok()
      })
    } catch (e) {
      log.error('Failed to enable auto-detect capture:', e)
      return fail(messageOf(e))
    }
  })

  handle(IPC.getCurrentMonitor, () => ok(getSetting('displayIndex')))
  handle(IPC.getCurrentWindow, () => ok(getSetting('windowId')))
  handle(IPC.getCurrentWindowName, () => ok(getSetting('windowName')))
  handle(IPC.getCaptureMode, () => ok(getSetting('captureMode')))

  handle(IPC.getCurrentSourceName, () => {
    if (!capture) return ok({ name: describeSourceFromSettings(), inactive: false })
    if (capture().isCapturePaused?.()) {
      // Nothing is live while the buffer is paused; naming a source here would
      // claim it is being captured. Screenshots read the capture service directly,
      // so their metadata is unaffected by this field.
      return ok({ name: 'Not capturing', inactive: true })
    }
    const mode = getSetting('captureMode') as CaptureMode
    const isWindow = mode === 'window'
    if (isWindow) capture().refreshWindowListIfStale()
    const name = capture().getCurrentSourceName()
    const inactive = isWindow && name === 'Window' && capture().isWindowListProbed()
    return ok({ name: isWindow && name === 'Window' ? getSetting('windowName') || 'Window' : name, inactive })
  })

  // -------------------------------------------------------------------------
  // Paths and folders
  // -------------------------------------------------------------------------

  handle(IPC.openFolder, async (target?: unknown) => {
    // The effective root (`<pick>\Rewind`), not the raw setting: it is where clips
    // actually land and what the settings row shows.
    const root = outputRoot()
    if (target === undefined || target === null) {
      // openPath resolves with an error string rather than throwing.
      const rootErr = await shell.openPath(root)
      if (rootErr) return fail(rootErr)
      return ok()
    }
    if (typeof target !== 'string' || !isInsidePath(target, root)) {
      note('Attempted to open folder outside output directory')
      return fail('Invalid folder path')
    }
    const targetErr = await shell.openPath(target)
    if (targetErr) return fail(targetErr)
    return ok()
  })

  /**
   * Reveals a folder that belongs to Rewind rather than to the output setting.
   *
   * The existing openFolder handler deliberately confines paths to outputPath,
   * so it cannot reach userData or the log directory. Those are two fixed,
   * caller-known locations, so this takes no path from the renderer at all --
   * there is nothing here to validate and nothing to traverse.
   */
  handle(IPC.openAppFolder, async (which?: unknown) => {
    let dir: string
    if (which === 'logs') dir = path.join(app.getPath('userData'), 'logs')
    else if (which === 'data' || which === undefined || which === null) {
      dir = app.getPath('userData')
    } else {
      return fail('Unknown folder')
    }

    try {
      await fs.promises.mkdir(dir, { recursive: true })
    } catch (e) {
      // The log directory may not exist yet on a very first run; mkdir covers it,
      // but a failure here should not stop us from revealing what does exist.
      note(`Could not create ${dir}: ${messageOf(e)}`)
    }

    // openPath reports failures in its return value rather than by throwing.
    const err = await shell.openPath(dir)
    if (err) return fail(err)
    return ok()
  })

  /**
   * Writes the process exclusion list to disk and reveals it.
   *
   * The list itself is compiled in (see EXCLUDED_PROCESSES in game-detector.ts)
   * and is not read back at runtime -- this is an export, so there is a file for
   * the user to see, keep a copy of, or reference when reporting an app that is
   * wrongly treated as a game.
   */
  handle(IPC.openExclusionList, async () => {
    const { EXCLUDED_PROCESSES } = require('./game-detector.js')
    const dir = app.getPath('userData')
    const file = path.join(dir, 'exclusion-list.json')

    const payload = { excludedProcesses: [...EXCLUDED_PROCESSES] }
    // Tabs, matching the file format the app already writes elsewhere.
    const text = JSON.stringify(payload, null, '\t') + '\n'

    try {
      await fs.promises.mkdir(dir, { recursive: true })
      await fs.promises.writeFile(file, text, 'utf8')
    } catch (e) {
      return fail(`Could not write the exclusion list: ${messageOf(e)}`)
    }

    const err = await shell.openPath(file)
    if (err) return fail(err)
    return ok()
  })

  handle(IPC.openFile, async (file: unknown) => {
    const resolved = resolveVideo(file, s, 'open-file')
    if ('error' in resolved) return resolved
    const openErr = await shell.openPath(resolved.path)
    if (openErr) return fail(openErr)
    return ok()
  })

  handle(IPC.showClipInFolder, async (file: unknown) => {
    const resolved = resolveVideo(file, s, 'show-clip-in-folder')
    if ('error' in resolved) return resolved
    if (!fs.existsSync(resolved.path)) return fail('Clip is no longer on disk')
    shell.showItemInFolder(resolved.path)
    return ok()
  })

  handle(IPC.getOutputPath, () => ok(outputRoot()))
  handle(IPC.getScreenshotPath, () => ok(screenshotPath()))

  handle(IPC.setOutputPath, async (target: unknown) => {
    if (typeof target !== 'string' || target.length === 0) return fail('Invalid path')
    const problem = validateDirectory(target)
    if (problem) return fail(problem)
    const blocked = notReady()
    if (blocked) return blocked

    const effective = rewindRoot(target)
    const previous = getSetting('outputPath')
    try {
      // Create the app's own folder the moment a location is picked: it is where
      // clips actually land (`rewindRoot`), and OBS's output needs it to exist.
      // Returning the effective path is what lets the panel show where files go
      // rather than the raw pick, which the app never writes into directly.
      fs.mkdirSync(effective, { recursive: true })
      return await withStatus(OBS_STATUS_MESSAGES.changingSettings, async () => {
        // The engine first. The setting is what the library scans, so saving it before
        // OBS agrees would leave the panel showing an empty folder while clips keep
        // landing in the old one.
        await obsCore().setOutputPath(effective)
        setSetting('outputPath', target)
        filesLog.info(`Output path set to: ${target} (clips land in ${effective})`)
        return ok(effective)
      })
    } catch (e) {
      // Best effort: put the engine back where it was. The setting never moved.
      if (previous) {
        try {
          await obsCore().setOutputPath(rewindRoot(previous))
        } catch {
          /* the engine is the thing that just failed; report the original error */
        }
      }
      log.error('Failed to set output path:', e)
      return fail(messageOf(e))
    }
  })

  handle(IPC.setScreenshotPath, (target: unknown) => {
    if (typeof target !== 'string' || target.length === 0) return fail('Invalid path')
    const problem = validateDirectory(target)
    if (problem) return fail(problem)
    setSetting('screenshotPath', target)
    filesLog.info(`Screenshot path set to: ${target}`)
    return ok(target)
  })

  handle(IPC.openScreenshotFolder, async () => {
    const shotErr = await shell.openPath(screenshotPath())
    if (shotErr) return fail(shotErr)
    return ok()
  })

  handle(IPC.selectFolder, async (kind: unknown) => {
    const win = s.getMainWindow()
    if (!win) return fail('No main window')
    const titles: Record<FolderKind, string> = {
      replays: 'Select Replay Save Location',
      screenshots: 'Select Screenshot Save Location',
    }
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      title: titles[kind === 'screenshots' ? 'screenshots' : 'replays'],
    })
    if (result.canceled || result.filePaths.length === 0) return ok({ canceled: true, path: null })
    return ok({ canceled: false, path: result.filePaths[0] })
  })

  // -------------------------------------------------------------------------
  // Clips
  // -------------------------------------------------------------------------

  handle(IPC.getSavedClips, async () => {
    try {
      return ok(await require('./clip-manager.js').scanClips(outputRoot()))
    } catch (e) {
      filesLog.error('Failed to get saved clips:', e)
      return ok([])
    }
  })

  handle(IPC.getClipThumbnail, async (file: unknown) => {
    const resolved = resolveVideo(file, s, 'get-clip-thumbnail')
    if ('error' in resolved) return resolved
    return ok(await require('./thumbnail.js').clipThumbnail(resolved.path))
  })

  handle(IPC.deleteClip, async (file: unknown, scope: unknown) => {
    const resolved = resolveVideo(file, s, 'delete-clip')
    if ('error' in resolved) return resolved
    if (scope !== undefined && !isDeleteScope(scope)) return fail('Invalid delete scope')
    if (scope !== 'cloud' && s.currentEditorClip()?.clipPath === resolved.path) {
      return fail('Close the clip editor before deleting this clip')
    }
    try {
      const { deleteClip } = require('./clip-manager.js')
      const { deleteThumbnail } = require('./thumbnail.js')
      deleteClip(resolved.path, (scope ?? 'local') as DeleteScope, (p: string) => deleteThumbnail(p))
      return ok()
    } catch (e) {
      filesLog.error('Failed to delete clip:', e)
      return fail(messageOf(e))
    }
  })

  handle(IPC.renameClip, async (file: unknown, newName: unknown) => {
    if (typeof newName !== 'string' || newName.length === 0) return fail('Invalid rename request')
    const resolved = resolveVideo(file, s, 'rename-clip')
    if ('error' in resolved) return resolved
    if (s.currentEditorClip()?.clipPath === resolved.path) {
      return fail('Close the clip editor before renaming this clip')
    }
    try {
      const { renameClip, RenameRejected } = require('./clip-manager.js')
      const thumb = require('./thumbnail.js')
      return ok(
        renameClip(resolved.path, newName, (from: string, to: string) => {
          const src = thumb.thumbnailPath(from)
          const dst = thumb.thumbnailPath(to)
          if (fs.existsSync(src)) fs.renameSync(src, dst)
        }),
      )
    } catch (e) {
      if (e instanceof (require('./clip-manager.js').RenameRejected)) {
        log.warn('Rename refused:', messageOf(e))
      } else {
        filesLog.error('Failed to rename clip:', e)
      }
      return fail(messageOf(e))
    }
  })

  handle(IPC.getAppVersion, () => ok(app.getVersion()))

  handle(IPC.openExternal, async (url: unknown) => {
    if (typeof url !== 'string' || url.length === 0) return ok()
    try {
      const parsed = new URL(url)
      // Rewind is offline; refuse anything that isn't plain web navigation.
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        note(`Blocked open-external with non-http protocol: ${parsed.protocol}`)
        return ok()
      }
      await shell.openExternal(url)
    } catch (e) {
      log.warn('Invalid URL for open-external:', e)
    }
    return ok()
  })

  // -------------------------------------------------------------------------
  // Screenshots
  // -------------------------------------------------------------------------

  handle(IPC.getScreenshots, async () => {
    try {
      return ok(await scanScreenshots(s))
    } catch (e) {
      filesLog.error('Failed to get screenshots:', e)
      return ok([])
    }
  })

  handle(IPC.getScreenshotThumbnail, async (file: unknown) => {
    const resolved = resolveScreenshot(file, s, 'get-screenshot-thumbnail')
    if ('error' in resolved) return resolved
    return ok(await require('./thumbnail.js').screenshotThumbnail(resolved.path))
  })

  handle(IPC.openScreenshot, async (file: unknown) => {
    const resolved = resolveScreenshot(file, s, 'open-screenshot')
    if ('error' in resolved) return resolved
    const shotErr = await shell.openPath(resolved.path)
    if (shotErr) return fail(shotErr)
    return ok()
  })

  handle(IPC.showScreenshotInFolder, async (file: unknown) => {
    const resolved = resolveScreenshot(file, s, 'show-screenshot-in-folder')
    if ('error' in resolved) return resolved
    if (!fs.existsSync(resolved.path)) return fail('Screenshot is no longer on disk')
    shell.showItemInFolder(resolved.path)
    return ok()
  })

  handle(IPC.deleteScreenshot, async (file: unknown) => {
    const resolved = resolveScreenshot(file, s, 'delete-screenshot')
    if ('error' in resolved) return resolved
    try {
      if (fs.existsSync(resolved.path)) {
        fs.unlinkSync(resolved.path)
        filesLog.info(`Deleted screenshot: ${resolved.path}`)
      } else {
        filesLog.info('Screenshot was already gone, clearing its leftovers')
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        /* already gone; still clear metadata below */
      } else {
        return fail(messageOf(e))
      }
    }

    try {
      deleteScreenshotMeta(resolved.path)
      // Same as the clip path above: the cached thumbnail is ours, so deleting the
      // shot has to take it along or the cache grows for the life of the install.
      const { deleteThumbnail } = require('./thumbnail.js')
      deleteThumbnail(resolved.path)
    } catch (e) {
      filesLog.warn('Deleted screenshot but failed to drop its metadata:', e)
    }
    return ok()
  })

  // -------------------------------------------------------------------------
  // Audio
  // -------------------------------------------------------------------------

  handle(IPC.getAudioLevels, () => {
    const { channelLevel } = require('./audio.js')
    return ok({ desktop: channelLevel('desktop'), microphone: channelLevel('microphone') })
  })

  handle(IPC.setChannelVolume, (channel: unknown, volume: unknown) => {
    if (!isChannel(channel)) return fail('Invalid audio channel')
    if (!isUnitInterval(volume)) return fail('Volume must be between 0 and 1')
    try {
      setSetting(channel === 'desktop' ? 'desktopVolume' : 'micVolume', volume)
      // Dragging a volume implies unmuting, which is what the slider does.
      setSetting(channel === 'desktop' ? 'desktopMuted' : 'micMuted', false)
      obsCore().applyChannelLevel(channel)
      return ok()
    } catch (e) {
      return fail(`Failed to set ${channel} volume: ${messageOf(e)}`)
    }
  })

  handle(IPC.setChannelMuted, (channel: unknown, muted: unknown) => {
    if (!isChannel(channel)) return fail('Invalid audio channel')
    if (typeof muted !== 'boolean') return fail('Invalid value for muted')
    try {
      setSetting(channel === 'desktop' ? 'desktopMuted' : 'micMuted', muted)
      obsCore().applyChannelLevel(channel)
      return ok()
    } catch (e) {
      return fail(`Failed to set ${channel} muted: ${messageOf(e)}`)
    }
  })

  /**
   * Mic input gain is a multiplier on an fader that already exists, so it lands live —
   * the same tier as volume and mute. Rebuilding the audio graph is what costs a
   * pipeline restart, and nothing here does that.
   */
  handle(IPC.getQuickClipSeconds, () => ok(clampQuickClip(getSetting('quickClipSeconds'))))

  handle(IPC.setQuickClipSeconds, (seconds: unknown) => {
    // Capped at the longest option, so the hotkey always delivers what it promises
    // and nothing can set a longer window behind the picker's back.
    if (typeof seconds !== 'number' || seconds < QUICK_CLIP_MIN || seconds > QUICK_CLIP_MAX) {
      return fail(`Quick clip length must be between ${QUICK_CLIP_MIN} and ${QUICK_CLIP_MAX} seconds`)
    }
    setSetting('quickClipSeconds', Math.round(seconds))
    return ok()
  })

  handle(IPC.getMicGain, () => ok(getSetting('micGain')))

  handle(IPC.setMicGain, (value: unknown) => {
    if (!isMicGain(value)) return fail(`Input gain must be between ${MIC_GAIN.MIN} and ${MIC_GAIN.MAX}`)
    try {
      setSetting('micGain', value)
      // Live tier, same as volume and mute: the gain is an OBS filter on the
      // existing mic source, so nothing about the audio graph is rebuilt.
      obsCore().applyChannelLevel('microphone')
      return ok()
    } catch (e) {
      return fail(`Failed to set microphone input gain: ${messageOf(e)}`)
    }
  })

  handle(IPC.getAudioSessions, () => ok(require('./audio.js').listAudioApps()))

  handle(IPC.setAppVolume, (exe: unknown, volume: unknown) => {
    if (typeof exe !== 'string' || exe.length === 0) return fail('Invalid app identifier')
    if (!isUnitInterval(volume)) return fail('Volume must be between 0 and 1')
    try {
      audioMix().setAppLevel(exe, { volume })
      return ok()
    } catch (e) {
      return fail(`Failed to set app volume: ${messageOf(e)}`)
    }
  })

  handle(IPC.setAppMuted, (exe: unknown, muted: unknown) => {
    if (typeof exe !== 'string' || exe.length === 0) return fail('Invalid app identifier')
    if (typeof muted !== 'boolean') return fail('Invalid value for muted')
    try {
      audioMix().setAppLevel(exe, { muted })
      return ok()
    } catch (e) {
      return fail(`Failed to set app muted: ${messageOf(e)}`)
    }
  })

  handle(IPC.resetAppMix, () => {
    try {
      audioMix().resetMix()
      return ok()
    } catch (e) {
      return fail(`Failed to reset app mix: ${messageOf(e)}`)
    }
  })

  // ---------------------------------------------------------------------------
  // Updates
  //
  // All four are user-initiated. Nothing here runs on a timer or at startup,
  // which is what lets the app claim it stays off the network by itself.
  // ---------------------------------------------------------------------------

  handle(IPC.getUpdateState, () => ok(require('./updater.js').getUpdateState()))

  handle(IPC.checkForUpdates, async () => ok(await require('./updater.js').checkForUpdates()))

  handle(IPC.downloadUpdate, async () => ok(await require('./updater.js').downloadUpdate()))

  handle(IPC.quitAndInstall, () => {
    // Installing means the installer kills this process seconds later, so a recording
    // still running would be cut off mid-stitch and never register. Refuse it, and say
    // what to do, rather than losing the recording silently.
    // `replay()` is null while the pipeline is being rebuilt, and the guard is read
    // through optional chaining for exactly that window: a TypeError here would
    // surface as a raw "Error invoking remote method" on the Install button.
    if (replay()?.isRecordingContinuously?.()) {
      return fail('Stop the recording first — installing now would cut it off')
    }
    // The process is replaced by the installer, so this never really returns.
    require('./updater.js').quitAndInstall()
    return ok()
  })

  handle(IPC.getAudioDevices, () => ok(audioDevices().getDevices()))

  handle(IPC.getChannelDevices, () => ok(require('./audio.js').channelDevices()))

  handle(IPC.setChannelDevice, (channel: unknown, deviceId: unknown) => {
    if (!isChannel(channel)) return fail('Invalid audio channel')
    if (typeof deviceId !== 'string' || deviceId.length === 0 || deviceId.length >= 500) {
      return fail('Invalid audio device id')
    }
    if (obsCore().isInitialized()) {
      const kind: DeviceKind = channel === 'desktop' ? 'output' : 'input'
      if (!require('./audio.js').deviceAvailable(obsCore().obs, deviceId, kind)) {
        return fail('That audio device is no longer available')
      }
    }
    try {
      const store = require('./store.js')
      store.setSetting(channel === 'desktop' ? 'desktopDeviceId' : 'micDeviceId', deviceId)
      obsCore().applyChannelDevice(channel)
      return ok()
    } catch (e) {
      return fail(`Failed to set ${channel} device: ${messageOf(e)}`)
    }
  })

  handle(IPC.addAudioDeviceChannel, async (deviceId: unknown) => {
    if (typeof deviceId !== 'string' || deviceId.length === 0 || deviceId.length >= 500) {
      return fail('Invalid audio device id')
    }
    try {
      audioDevices().addChannel(deviceId)
      await withStatus(OBS_STATUS_MESSAGES.changingSettings, () => obsCore().applyAudioTracks())
      return ok()
    } catch (e) {
      return fail(`Failed to add audio device channel: ${messageOf(e)}`)
    }
  })

  handle(IPC.removeAudioDeviceChannel, async (deviceId: unknown) => {
    if (typeof deviceId !== 'string' || deviceId.length === 0 || deviceId.length >= 500) {
      return fail('Invalid audio device id')
    }
    try {
      audioDevices().removeChannel(deviceId)
      await withStatus(OBS_STATUS_MESSAGES.changingSettings, () => obsCore().applyAudioTracks())
      return ok()
    } catch (e) {
      return fail(`Failed to remove audio device channel: ${messageOf(e)}`)
    }
  })

  handle(IPC.setDeviceVolume, (deviceId: unknown, volume: unknown) => {
    if (typeof deviceId !== 'string' || deviceId.length === 0 || deviceId.length >= 500) {
      return fail('Invalid audio device id')
    }
    if (!isUnitInterval(volume)) return fail('Volume must be between 0 and 1')
    try {
      audioDevices().setLevel(deviceId, { volume })
      return ok()
    } catch (e) {
      return fail(`Failed to set device volume: ${messageOf(e)}`)
    }
  })

  handle(IPC.setDeviceMuted, (deviceId: unknown, muted: unknown) => {
    if (typeof deviceId !== 'string' || deviceId.length === 0 || deviceId.length >= 500) {
      return fail('Invalid audio device id')
    }
    if (typeof muted !== 'boolean') return fail('Invalid value for muted')
    try {
      audioDevices().setLevel(deviceId, { muted })
      return ok()
    } catch (e) {
      return fail(`Failed to set device muted: ${messageOf(e)}`)
    }
  })

  // -------------------------------------------------------------------------
  // Profiles
  // -------------------------------------------------------------------------

  handle(IPC.getProfiles, () => ok(s.getProfiles()))

  handle(IPC.setProfile, async (index: unknown) => {
    const { getProfiles } = require('./profiles.js')
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= getProfiles().profiles.length) {
      return fail('Invalid profile')
    }
    try {
      await withStatus(OBS_STATUS_MESSAGES.changingSettings, () => s.applyProfile(index))
      return ok(s.getProfiles())
    } catch (e) {
      return fail(messageOf(e))
    }
  })

  /**
   * Edits one profile. Editing the active one applies the change like a switch would;
   * editing any other only stores it.
   */
  handle(IPC.setProfileValues, async (index: unknown, patch: unknown) => {
    const { getProfiles, writeProfileValues } = require('./profiles.js')
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= getProfiles().profiles.length) {
      return fail('Invalid profile')
    }
    if (!patch || typeof patch !== 'object') return fail('Invalid profile values')
    const p = patch as Record<string, unknown>
    if (p.name !== undefined && (typeof p.name !== 'string' || p.name.length > 24)) return fail('Invalid profile name')
    if (p.bufferDuration !== undefined && !isBufferDuration(p.bufferDuration)) {
      return fail(`Buffer duration must be between ${BUFFER_DURATION_MIN} and ${BUFFER_DURATION_MAX} seconds`)
    }
    if (p.fps !== undefined && !ALLOWED_FPS.includes(p.fps as (typeof ALLOWED_FPS)[number])) return fail('Invalid FPS value')
    if (p.visualQuality !== undefined && !VISUAL_QUALITIES.includes(p.visualQuality as never)) {
      return fail('Invalid visual quality value')
    }

    const before = getProfiles().profiles[index]
    writeProfileValues(index, p)
    const { activeProfile } = getProfiles()
    if (index === activeProfile) {
      try {
        await withStatus(OBS_STATUS_MESSAGES.changingSettings, () => s.applyProfile(index))
      } catch (e) {
        // The stored profile was written before the engine was asked to apply it, so a
        // failure has to put it back: otherwise the panel keeps values the engine
        // refused and the next switch would try them again.
        writeProfileValues(index, before)
        return fail(messageOf(e))
      }
    }
    return ok(s.getProfiles())
  })

  handle(IPC.addProfile, () => {
    const result = require('./profiles.js').addProfile()
    return typeof result === 'string' ? fail(result) : ok(result)
  })

  handle(IPC.duplicateProfile, (index: unknown) => {
    const { getProfiles, duplicateProfile } = require('./profiles.js')
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= getProfiles().profiles.length) {
      return fail('Invalid profile')
    }
    const result = duplicateProfile(index)
    return typeof result === 'string' ? fail(result) : ok(result)
  })

  handle(IPC.removeProfile, (index: unknown) => {
    const { getProfiles, removeProfile } = require('./profiles.js')
    if (typeof index !== 'number' || !Number.isInteger(index)) return fail('Invalid profile')
    const result = removeProfile(index)
    return typeof result === 'string' ? fail(result) : ok(result)
  })

  /** The panel's "Save current settings": live settings become the active profile's values. */
  handle(IPC.saveActiveProfile, () => {
    require('./profiles.js').captureActiveProfileValues()
    return ok(s.getProfiles())
  })

  // -------------------------------------------------------------------------
  // Quality / encoder
  // -------------------------------------------------------------------------

  handle(IPC.getFps, () => ok(getSetting('fps')))
  handle(IPC.getNvencMultipass, () => ok(getSetting('nvencMultipass')))
  handle(IPC.getNvencPreset, () => ok(getSetting('nvencPreset')))
  handle(IPC.getOutputResolution, () => ok(getSetting('outputResolution')))
  handle(IPC.getVisualQuality, () => ok(getSetting('visualQuality')))
  handle(IPC.getVideoCodec, () => ok(getSetting('videoCodec')))
  handle(IPC.getAvailableCodecs, () => ok(replay().getAvailableCodecs?.() ?? ['h264']))

  handle(IPC.getVideoEncoder, () => ok(getSetting('videoEncoder')))
  handle(IPC.getAvailableEncoderVendors, () => {
    const { ENCODER_AUTO_LABEL } = require('@shared/constants.js')
    return ok([
      { vendor: 'auto', label: ENCODER_AUTO_LABEL, isHardware: true, codecs: ['h264'] },
      ...(replay().getAvailableEncoderVendors?.() ?? [{ vendor: 'x264', label: 'x264', isHardware: false, codecs: ['h264'] }]),
    ])
  })
  handle(IPC.getActiveEncoderVendor, () => ok(replay().getActiveEncoderVendor?.() ?? 'x264'))

  /**
   * Applies an encoder-related setting and restarts only what it invalidates.
   *
   * Two tiers, because a full OBS reinit costs about ten seconds:
   * - 'full':  the canvas or the detected encoder set changes (fps, output
   *   resolution, encoder vendor), so the video context must be rebuilt.
   * - 'chain': only the encoder's parameters change (quality tier, NVENC
   *   preset, multipass), which just needs the replay chain rebuilt.
   */
  const applyEncoderSetting = async (
    key: 'fps' | 'nvencMultipass' | 'nvencPreset' | 'visualQuality' | 'videoCodec' | 'videoEncoder' | 'outputResolution',
    value: unknown,
    allowed: readonly unknown[],
    message: string,
    tier: 'full' | 'chain' = 'full',
  ) => {
    if (!allowed.includes(value)) return fail(message)
    const store = require('./store.js')
    if (store.getSetting(key) === value) return ok()

    const prev = store.getSetting(key)
    store.setSetting(key, value)

    const apply = async () => {
      // Name the change so the panel can say what is happening. A bare "restarting"
      // for thirteen seconds tells someone nothing about whether it worked.
      if (tier === 'full' || !obsCore()?.isInitialized()) {
        return s.reinitPipeline(`Applying ${SETTING_LABELS[key] ?? key}...`, { preservePaused: true })
      }
      bufferLog.info(`${key} change: rebuilding replay chain only`)
      await withStatus(OBS_STATUS_MESSAGES.changingSettings, () => replay().rebuildAndRestart())
    }

    try {
      await apply()
      // The live settings are the active profile's values: an edit made in Settings
      // belongs to the profile that is active, and is not lost on the next switch.
      const { captureActiveProfileValues } = require('./profiles.js')
      captureActiveProfileValues()
      // Must return a result: `apply()` resolves to void, and returning that would
      // resolve the renderer call to `undefined`, which surfaces as
      // "Cannot read properties of undefined (reading 'success')" even on success.
      return ok()
    } catch (e) {
      store.setSetting(key, prev)
      log.error(`Failed to apply ${key} change:`, e)
      return fail(messageOf(e))
    }
  }

  handle(IPC.setFps, (value: unknown) => applyEncoderSetting('fps', value, ALLOWED_FPS, 'Invalid FPS value', 'full'))
  handle(IPC.setNvencMultipass, (value: unknown) =>
    applyEncoderSetting('nvencMultipass', value, ['disabled', 'qres'], 'Invalid multipass value', 'chain'),
  )
  handle(IPC.setNvencPreset, (value: unknown) =>
    applyEncoderSetting('nvencPreset', value, ['p3', 'p4', 'p5'], 'Invalid preset value', 'chain'),
  )
  handle(IPC.setVisualQuality, (value: unknown) =>
    applyEncoderSetting('visualQuality', value, ['low', 'standard', 'high', 'highest'], 'Invalid visual quality value', 'chain'),
  )

  handle(IPC.setVideoCodec, async (value: unknown) => {
    if (!['h264', 'hevc', 'av1'].includes(value as string)) return fail('Invalid codec value')
    if (replay().getAvailableCodecs && !replay().getAvailableCodecs().includes(value as any)) {
      return fail('Codec not supported on this system')
    }
    return applyEncoderSetting('videoCodec', value, ['h264', 'hevc', 'av1'], 'Invalid codec value', 'chain')
  })

  handle(IPC.setVideoEncoder, async (value: unknown) => {
    if (!['auto', 'nvenc', 'amf', 'qsv', 'x264'].includes(value as string)) return fail('Invalid encoder value')
    const store = require('./store.js')
    if (store.getSetting('videoEncoder') === value) return ok()

    const available = replay().getAvailableEncoderVendors?.() ?? []
    if (available.length > 0 && value !== 'auto' && !available.some((v: any) => v.vendor === value)) {
      return fail('Encoder not supported on this system')
    }

    // Picking a vendor whose codec list lacks the current codec would fail on restart,
    // so normalize the codec alongside the encoder.
    const resolvedVendor =
      value === 'auto' ? (available.find((v: any) => v.vendor !== 'auto' && v.vendor !== 'x264')?.vendor ?? 'x264') : (value as string)
    const codecs = available.find((v: any) => v.vendor === resolvedVendor)?.codecs ?? []
    const current = store.getSetting('videoCodec') as string
    if (codecs.length > 0 && !codecs.includes(current as any)) {
      store.setSetting('videoCodec', codecs[0])
      log.info(`Normalized videoCodec '${current}' -> '${codecs[0]}' (not supported by ${resolvedVendor})`)
    }

    return applyEncoderSetting('videoEncoder', value, ['auto', 'nvenc', 'amf', 'qsv', 'x264'], 'Invalid encoder value', 'chain')
  })

  handle(IPC.setOutputResolution, async (value: unknown) => {
    if (!['native', '1080p', '720p'].includes(value as string)) return fail('Invalid output resolution')
    const store = require('./store.js')
    if (store.getSetting('outputResolution') === value) return ok()

    // Skip the restart when the target display is already smaller than the ceiling.
    const { screen } = require('electron')
    const { resolveOutputSize } = require('./obs-core.js')
    const primary = screen.getPrimaryDisplay()
    const w = Math.round(primary.bounds.width * (primary.scaleFactor || 1))
    const h = Math.round(primary.bounds.height * (primary.scaleFactor || 1))
    const next = resolveOutputSize(w, h, value as any)
    const prev = resolveOutputSize(w, h, store.getSetting('outputResolution') as any)

    if (next.width === prev.width && next.height === prev.height) {
      store.setSetting('outputResolution', value)
      log.info(`Output resolution mode: ${value} (${next.width}x${next.height}) - dims unchanged, skipped reinit`)
      return ok()
    }

    return applyEncoderSetting('outputResolution', value, ['native', '1080p', '720p'], 'Invalid output resolution')
  })

  // -------------------------------------------------------------------------
  // Simple toggles
  // -------------------------------------------------------------------------

  const toggle = (
    getCh: string,
    setCh: string,
    key: 'notificationsEnabled' | 'notificationSoundEnabled' | 'launchOnStartup' | 'startMinimized',
    label: string,
    onChange?: (v: boolean) => void,
  ) => {
    handle(getCh, () => ok(getSetting(key)))
    handle(setCh, (value: unknown) => {
      if (typeof value !== 'boolean') return fail(`Invalid value for ${label}`)
      onChange?.(value)
      setSetting(key, value)
      log.info(`${label} ${value ? 'enabled' : 'disabled'}`)
      return ok()
    })
  }

  toggle(IPC.getNotificationsEnabled, IPC.setNotificationsEnabled, 'notificationsEnabled', 'Notifications')
  toggle(IPC.getNotificationSoundEnabled, IPC.setNotificationSoundEnabled, 'notificationSoundEnabled', 'Notification sound')
  toggle(
    IPC.getLaunchOnStartup,
    IPC.setLaunchOnStartup,
    'launchOnStartup',
    'Launch on startup',
    (v) => app.setLoginItemSettings({ openAtLogin: v }),
  )
  toggle(IPC.getStartMinimized, IPC.setStartMinimized, 'startMinimized', 'Start minimized')

  // -------------------------------------------------------------------------
  // Hotkeys
  // -------------------------------------------------------------------------

  handle(IPC.getHotkeys, () => ok(require('./hotkey.js').getHotkeys()))

  handle(IPC.setHotkey, (action: unknown, accelerator: unknown) => {
    const hk = require('./hotkey.js')
    if (!hk.ACTIONS.includes(action as any)) return fail('Unknown hotkey action')
    if (typeof accelerator !== 'string' || accelerator.length === 0 || accelerator.length >= 100) {
      return fail('Invalid hotkey format')
    }
    const conflict = hk.conflictingAction(action as any, accelerator)
    if (conflict) return fail(`Already used by ${hk.HOTKEYS[conflict].label}`)

    /*
     * One callback per action, looked up by name.
     *
     * This used to be a binary ternary -- `save-replay` got its own callback and
     * everything else got the screenshot one -- so rebinding Start / Stop
     * Recording took a screenshot instead of toggling. The startup path
     * (`index.ts:215-219`) always mapped all three correctly, which is why the
     * bug was invisible until someone rebound a hotkey.
     *
     * Typed as an exhaustive Record rather than an index signature: adding a
     * fourth hotkey then fails to compile here instead of silently inheriting
     * someone else's callback a second time.
     */
    const HOTKEY_CALLBACKS: Record<import('./hotkey.js').HotkeyAction, () => void> = {
      'save-replay': s.saveClipHotkey,
      screenshot: () => void s.takeScreenshotHotkey(),
      'save-quick-clip': () => void s.saveQuickClip(),
      'toggle-record': () => void s.toggleRecording?.(),
    }

    if (!hk.registerHotkey(action as any, accelerator, HOTKEY_CALLBACKS[action as import('./hotkey.js').HotkeyAction])) {
      return fail('Unsupported key combination')
    }
    setSetting(hk.HOTKEYS[action as any].setting, accelerator)
    return ok()
  })

  ipcMain.handle(IPC.startHotkeyCapture, (event) => {
    require('./hotkey.js').startCapture((hotkey: string) => {
      if (!event.sender.isDestroyed()) event.sender.send('hotkey-capture-key', hotkey)
    })
    return ok()
  })

  handle(IPC.stopHotkeyCapture, () => {
    require('./hotkey.js').stopCapture()
    return ok()
  })

  // -------------------------------------------------------------------------
  // Editor
  // -------------------------------------------------------------------------

  handle(IPC.openClipEditor, (file: unknown) => {
    const resolved = resolveVideo(file, s, 'open-clip-editor')
    if ('error' in resolved) return resolved
    if (!fs.existsSync(resolved.path)) return fail('Source clip not found')
    s.openEditorWindow(resolved.path)
    return ok()
  })

  handle(IPC.editorGetClipInfo, async (file: unknown) => {
    const resolved = resolveVideo(file, s, 'editor-get-clip-info')
    if ('error' in resolved) return resolved
    if (!fs.existsSync(resolved.path)) return fail('Source clip not found')
    try {
      // The clip's own recorded layout, not what the app is set to right now: turning
      // separate tracks off afterwards must not collapse a multi-track clip to one mix.
      const recorded = getClipMeta(resolved.path)?.audioTracks ?? ['Mix']
      return ok(await require('./editor.js').getClipInfo(resolved.path, recorded))
    } catch (e) {
      replayLog.error('Failed to load clip info:', e)
      return fail(messageOf(e))
    }
  })

  handle(IPC.editorGetTrackPeaks, async (file: unknown, stream: unknown) => {
    const resolved = resolveVideo(file, s, 'editor-get-track-peaks')
    if ('error' in resolved) return resolved
    if (!Number.isInteger(stream) || (stream as number) < 0 || (stream as number) >= 6) {
      return fail('Invalid audio track')
    }
    try {
      return ok(await require('./editor.js').getTrackPeaks(resolved.path, stream as number))
    } catch (e) {
      replayLog.error('Failed to read audio waveform:', e)
      return fail(messageOf(e))
    }
  })

  handle(IPC.editorSaveClip, async (args: unknown) => {
    if (!isSaveClipArgs(args)) return fail('Invalid save arguments')
    const resolved = resolveVideo((args as any).clipPath, s, 'editor-save-clip')
    if ('error' in resolved) return resolved
    try {
      const out = await s.saveEditorClip({ ...(args as any), clipPath: resolved.path })
      s.getMainWindow()?.webContents.send('clip-saved', { clipPath: out })
      log.info(`Editor saved (${(args as any).mode}): ${out}`)
      return ok({ outputPath: out })
    } catch (e) {
      replayLog.error('Failed to save trimmed clip:', e)
      return fail(messageOf(e))
    }
  })

  handle(IPC.editorCancel, () => {
    require('./editor.js').cleanupEditor()
    s.closeEditorWindow()
    return ok()
  })

  /**
   * Export (compressed copy).
   *
   * Raw `ipcMain.handle` rather than `handle()`: progress is pushed to the sender
   * while the job runs, and the wrapper does not hand the event through.
   */
  ipcMain.handle(IPC.editorExport, async (event, req: unknown) => {
    if (!isExportRequest(req)) return fail('Invalid export arguments')
    const resolved = resolveVideo(req.clipPath, s, 'editor-export')
    if ('error' in resolved) return resolved
    const sender = event.sender
    const onProgress = (percent: number) => {
      if (!sender.isDestroyed()) sender.send('export-progress', { percent })
    }
    try {
      const result = await require('./export.js').exportClip(
        { ...req, clipPath: resolved.path },
        { onProgress, outputRoot: outputRoot() },
      )
      log.info(`Export finished: ${result.path}`)
      return ok(result)
    } catch (e) {
      if (require('./ffmpeg.js').isCancelled(e)) return fail('Export cancelled')
      replayLog.error('Export failed:', e)
      return fail(messageOf(e))
    }
  })

  handle(IPC.getExportThreads, () => ok(getSetting('exportThreads')))

  handle(IPC.setExportThreads, (value: unknown) => {
    if (typeof value !== 'number' || !Number.isInteger(value) || (value !== 0 && (value < 2 || value > 16))) {
      return fail('Threads must be auto (0) or between 2 and 16')
    }
    setSetting('exportThreads', value)
    log.info(`Export threads (CPU fallback): ${value === 0 ? 'auto' : value}`)
    return ok(value)
  })

  handle(IPC.editorExportCancel, () => {
    require('./export.js').cancelExport()
    return ok()
  })

  /**
   * Copy a clip file to the clipboard so it can be pasted into a chat.
   *
   * Windows has no Electron API for a real file copy (CF_HDROP needs a native
   * module), so this writes the FileNameW format, which is what Explorer and most
   * chat apps read as "a file was copied". An app that insists on CF_HDROP gets
   * the path as text from the fallback instead of nothing at all.
   */
  handle(IPC.copyClip, (file: unknown) => {
    const resolved = resolveVideo(file, s, 'copy-clip')
    if ('error' in resolved) return resolved
    const target = resolved.path
    try {
      clipboard.writeBuffer('FileNameW', Buffer.from(`${target}\u0000`, 'ucs2'))
      log.info(`Clip copied to the clipboard as a file: ${target}`)
      return ok({ mode: 'file' as const })
    } catch (e) {
      clipboard.writeText(target)
      log.warn(`FileNameW clipboard write failed (${messageOf(e)}); copied the path instead`)
      return ok({ mode: 'path' as const })
    }
  })

  handle(IPC.notificationClick, () => {
    s.getMainWindow()?.show()
    s.getMainWindow()?.focus()
    require('./notification.js').dismissPanel()
    return ok()
  })
}

// ---------------------------------------------------------------------------
// Shared operations
// ---------------------------------------------------------------------------

class NotReadyError extends Error {
  constructor(readonly result: IpcResult<never>) {
    super('not-ready')
  }
}

/** Persist and notify. Shared by the IPC channel, the hotkey, and the tray. */
export async function saveClipAndNotify(s: Services, action?: HotkeyAction): Promise<string> {
  // Guards here rather than only at the callers so the panel button, the hotkey
  // and anything added later all refuse the same way. Without it the failure
  // surfaces from deep inside the flush as an opaque error.
  if (!s.replay.isReplayBufferActive()) {
    throw new Error('The buffer is off - start it to save a clip')
  }

  const sourceName = s.capture.getCurrentSourceName()
  const outputRoot = s.obsCore.getConfig().outputPath
  const cm = require('./clip-manager.js')
  const meta = require('./clip-meta.js')
  const { REPLAY_RESTARTED } = require('./replay-buffer.js')

  // A capture-source switch rebuilds the replay chain, which aborts an in-flight
  // save. That is transient, so wait for the new chain and try once more rather than
  // making the user press the key again.
  let savedPath: string
  try {
    savedPath = await s.replay.saveReplayBuffer(s.capture.getCaptureMode())
  } catch (e) {
    const message = messageOf(e)
    if (message !== REPLAY_RESTARTED) throw e

    replayLog.warn('Save interrupted by a capture source switch; retrying...')
    await new Promise((r) => setTimeout(r, 1500))
    savedPath = await s.replay.saveReplayBuffer(s.capture.getCaptureMode())
  }

  const moved = cm.moveIntoSourceFolder(savedPath, sourceName, outputRoot)

  meta.setClipMeta(moved, {
    recordedAt: Date.now(),
    source: sourceName,
    audioTracks: s.obsCore.audioTrackLabels(),
  })

  // Notify immediately so the user gets instant feedback; probing for the log line
  // and duration stamp happens after, since it can take a moment.
  // The body is where the clip landed; `action` (hotkey/tray) names the key too.
  s.notify('saved', path.dirname(moved), action ? hotkeyTitle(action, 'Clip saved') : undefined)

  // Tell the renderer to refresh. This must live here rather than in the hotkey
  // path, otherwise saving from the button (or the tray) leaves the list stale.
  s.getMainWindow()?.webContents.send('clip-saved', { clipPath: moved })

  void cm
    .describeSavedClip(moved, s.replay.getActiveEncoderVendor(), s.replay.getActiveEncoder(), s.replay.getQualityTarget(), sourceName)
    .then(async (info: { durationSec: number } | null) => {
      const duration = await cm.stampDuration(moved, info?.durationSec)
      if (duration !== undefined) meta.setClipMeta(moved, { duration })
    })
    .catch(() => {
      /* diagnostics only; the clip is already saved and notified */
    })

  return moved
}

/**
 * Saves only the last `seconds` of the buffer.
 *
 * The buffer is the ceiling: it holds `bufferDuration` seconds and older footage
 * is overwritten, so this can only ever return a *shorter* clip. Asking for more
 * than the buffer holds therefore returns the whole buffer rather than failing,
 * which is also what a user who has just lengthened the buffer expects.
 *
 * Shares the save, folder, metadata and notification path with `saveClipAndNotify`
 * so a quick clip is an ordinary clip everywhere downstream -- the editor, the
 * library, and the per-game folders all see no difference.
 *
 * The notification quotes what `keepTail` measured, so a request the buffer was too
 * short to satisfy says so instead of announcing a length no file has.
 */
export async function saveQuickClipAndNotify(s: Services, seconds: number, action?: HotkeyAction): Promise<string> {
  if (!s.replay.isReplayBufferActive()) {
    throw new Error('The buffer is off - start it to save a clip')
  }

  const sourceName = s.capture.getCurrentSourceName()
  const outputRoot = s.obsCore.getConfig().outputPath
  const cm = require('./clip-manager.js')
  const meta = require('./clip-meta.js')
  const { REPLAY_RESTARTED } = require('./replay-buffer.js')

  let savedPath: string
  try {
    savedPath = await s.replay.saveReplayBuffer(s.capture.getCaptureMode())
  } catch (e) {
    if (messageOf(e) !== REPLAY_RESTARTED) throw e
    replayLog.warn('Quick save interrupted by a capture source switch; retrying...')
    await new Promise((r) => setTimeout(r, 1500))
    savedPath = await s.replay.saveReplayBuffer(s.capture.getCaptureMode())
  }

  const tail = await require('./ffmpeg.js').keepTail(savedPath, seconds)
  const moved = cm.moveIntoSourceFolder(tail.file, sourceName, outputRoot)

  meta.setClipMeta(moved, {
    recordedAt: Date.now(),
    source: sourceName,
    audioTracks: s.obsCore.audioTrackLabels(),
  })

  // Reports the length the file actually has, not the one that was asked for.
  //
  // Two ways to come back with less than requested: the buffer simply held less
  // (`wholeClip`), or the keyframe the cut snapped to was a little early. The first
  // is worth naming -- someone who asked for 60s and got the whole 25s buffer
  // deserves to know the buffer was the limit, not left guessing whether the
  // hotkey misfired. On the hotkey path that number rides in the title ("Last 15s
  // saved — Ctrl + Alt + 1") and the body carries the folder.
  const kept = tail.seconds
  const title = action
    ? hotkeyTitle(action, kept <= 0 ? 'Clip saved' : tail.wholeClip ? `Saved all ${kept}s` : `Last ${kept}s saved`)
    : undefined
  const body =
    kept <= 0
      ? 'Clip saved'
      : tail.wholeClip
        ? `The buffer held no more than ${kept}s`
        : path.dirname(moved)
  s.notify('saved', body, title)
  s.getMainWindow()?.webContents.send('clip-saved', { clipPath: moved })

  void cm
    .describeSavedClip(moved, s.replay.getActiveEncoderVendor(), s.replay.getActiveEncoder(), s.replay.getQualityTarget(), sourceName)
    .then(async (info: { durationSec: number } | null) => {
      const duration = await cm.stampDuration(moved, info?.durationSec)
      if (duration !== undefined) meta.setClipMeta(moved, { duration })
    })
    .catch(() => {
      /* diagnostics only; the clip is already saved and notified */
    })

  return moved
}

export async function takeScreenshot(s: Services, action?: HotkeyAction): Promise<string> {
  const displayIndex = s.capture.getCurrentMonitor?.() ?? getSetting('displayIndex')
  const dir = screenshotPath()
  const file = await captureScreenshot(displayIndex, dir)

  setScreenshotMeta(file, {
    capturedAt: Date.now(),
    source: s.capture.getCurrentSourceName(),
  })

  s.notify('screenshot', path.dirname(file), action ? hotkeyTitle(action, 'Screenshot taken') : undefined)
  s.getMainWindow()?.webContents.send('screenshot-saved', { path: file })
  return file
}

/**
 * The directory clips are recorded into and read from.
 *
 * `outputPath` is empty until the user picks a folder, so it must resolve to the
 * same default the recorder used. When these two disagreed, clips were written to
 * `<Videos>\Rewind` while every path guard compared against `''`, which made the
 * library look empty and rejected every thumbnail, open and delete.
 */
export function outputRoot(): string {
  return rewindRoot(getSetting('outputPath'))
}

export function screenshotPath(): string {
  const configured = getSetting('screenshotPath')
  if (configured && path.isAbsolute(configured)) return configured
  return path.join(outputRoot(), SCREENSHOT_SUBDIR)
}

async function scanScreenshots(s: Services): Promise<ScreenshotInfo[]> {
  const dir = screenshotPath()
  if (!fs.existsSync(dir)) return []

  /*
   * Metadata is keyed by absolute path, which is what `captureScreenshot` returns
   * and what `setScreenshotMeta` writes. Reading it from the store's raw map means
   * re-deriving that key by hand; `getScreenshotMeta` already does the lookup and
   * lives beside the writer.
   *
   * This used to call `getScreenshotMeta` on `./store.js`, which does not export
   * it. The optional call swallowed the TypeError and produced `{}`, so every
   * screenshot rendered as "Unknown Source" with no error anywhere.
   */
  const out: ScreenshotInfo[] = []

  for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    if (path.extname(entry.name).toLowerCase() !== '.png') continue

    const full = path.join(dir, entry.name)
    let size = 0
    let mtimeMs = Date.now()
    try {
      const st = await fs.promises.stat(full)
      size = st.size
      mtimeMs = st.mtimeMs
    } catch {
      continue
    }

    const meta = getScreenshotMeta(full)

    out.push({
      id: full,
      path: full,
      name: entry.name,
      size,
      capturedAt: meta?.capturedAt ?? mtimeMs,
      source: meta?.source ?? null,
      localExists: true,
    })
  }

  return out.sort((a, b) => b.capturedAt - a.capturedAt)
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function isInsidePath(child: string, parent: string): boolean {
  const { isInside } = require('./util.js')
  return isInside(child, parent)
}

function resolveVideo(file: unknown, _s: Services, label: string): { path: string } | { error: string; success: false } {
  const { resolveClipPath } = require('./clip-manager.js')
  const resolved = resolveClipPath(file, outputRoot(), label)
  // `resolveClipPath` always returns an object; only the failure branch carries `error`.
  return 'error' in resolved && resolved.error
    ? { error: resolved.error, success: false }
    : { path: (resolved as { path: string }).path }
}

function resolveScreenshot(file: unknown, _s: Services, label: string): { path: string } | { error: string; success: false } {
  const { isInside, nonEmptyString } = require('./util.js')
  const p = file as string
  if (!nonEmptyString(p)) return { error: 'Invalid file path', success: false }
  if (!isInside(p, screenshotPath())) return { error: 'Invalid file path', success: false }
  if (path.extname(p).toLowerCase() !== '.png') return { error: 'Only screenshots are supported', success: false }
  void label
  return { path: p }
}

function validateDirectory(target: string): string | null {
  if (!path.isAbsolute(target)) return 'Please choose an absolute folder path'
  try {
    if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true })
    if (!fs.statSync(target).isDirectory()) return 'Path is not a directory'
    const { isWritable } = require('./util.js')
    if (!isWritable(target)) return 'Cannot write to this folder. Please choose a folder you have write access to.'
    return null
  } catch (e) {
    log.error('Failed to prepare directory:', e)
    return messageOf(e)
  }
}

function describeSourceFromSettings(): string {
  const store = require('./store.js')
  const mode = store.getSetting('captureMode') as CaptureMode
  if (mode === 'game') return 'Auto Game Capture'
  if (mode === 'window') {
    const name = store.getSetting('windowName') as string | null
    if (name) return name.split(' - ')[0].trim() || name
    return 'Window'
  }
  return `Display ${(store.getSetting('displayIndex') as number) + 1}`
}

function pipelineReady(obsCore: any, replay: any): boolean {
  return !!(obsCore?.isInitialized?.() && replay?.isReplayBufferActive?.())
}

const WEDGE_PATTERNS = ['Timeout waiting for replay buffer', 'Failed to make IPC call', 'Lost IPC Connection']

/** Distinguishes a wedged encoder from an ordinary failure so the UI can offer recovery. */
function wedgedIfNeeded(e: unknown): ErrorCode | undefined {
  const msg = messageOf(e)
  return WEDGE_PATTERNS.some((p) => msg.includes(p)) ? 'obs-wedged-recovering' : undefined
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const isIndex = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0
const isUnitInterval = (v: unknown): v is number => typeof v === 'number' && v >= 0 && v <= 1
const isMicGain = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= MIC_GAIN.MIN && v <= MIC_GAIN.MAX
const isChannel = (v: unknown): v is AudioChannel => v === 'desktop' || v === 'microphone'
const isDeleteScope = (v: unknown): v is DeleteScope => v === 'both' || v === 'local' || v === 'cloud'
/**
 * Buffer length bounds, in seconds.
 *
 * The ceiling is 10 minutes because that is what the homepage slider offers.
 * OBS has no byte ceiling on this output (see replay-buffer.ts), so the upper
 * bound is the only thing standing between a user and an unbounded RAM
 * allocation -- it is a deliberate limit, not an arbitrary one.
 */
// Bounds come from @shared/constants so the panel's custom-limit field and this
// validator use exactly the same range.
const isBufferDuration = (v: unknown): v is number =>
  typeof v === 'number' && v >= BUFFER_DURATION_MIN && v <= BUFFER_DURATION_MAX

function isSaveClipArgs(v: unknown): v is {
  clipPath: string
  startSec: number
  endSec: number
  mode: 'overwrite' | 'copy'
  trackVolumes?: { stream: number; volume: number }[]
} {
  if (!v || typeof v !== 'object') return false
  const a = v as any
  if (typeof a.clipPath !== 'string' || a.clipPath.length === 0) return false
  if (typeof a.startSec !== 'number' || !Number.isFinite(a.startSec) || a.startSec < 0) return false
  if (typeof a.endSec !== 'number' || !Number.isFinite(a.endSec) || a.endSec <= a.startSec) return false
  if (a.mode !== 'overwrite' && a.mode !== 'copy') return false
  if (a.trackVolumes === undefined) return true
  return (
    Array.isArray(a.trackVolumes) &&
    a.trackVolumes.length <= 6 &&
    a.trackVolumes.every(
      (t: any) =>
        t &&
        typeof t === 'object' &&
        Number.isInteger(t.stream) &&
        t.stream >= 0 &&
        t.stream < 6 &&
        isUnitInterval(t.volume),
    )
  )
}

function isExportRequest(v: unknown): v is {
  clipPath: string
  startSec: number
  endSec: number
  targetMb: number
} {
  if (!v || typeof v !== 'object') return false
  const a = v as any
  if (typeof a.clipPath !== 'string' || a.clipPath.length === 0) return false
  if (typeof a.startSec !== 'number' || !Number.isFinite(a.startSec) || a.startSec < 0) return false
  if (typeof a.endSec !== 'number' || !Number.isFinite(a.endSec) || a.endSec <= a.startSec) return false
  if (typeof a.targetMb !== 'number' || !Number.isFinite(a.targetMb) || a.targetMb < 0.1 || a.targetMb > 500) {
    return false
  }
  return true
}

export { DEFAULT_SETTINGS }
