import { app, ipcMain, shell, dialog, BrowserWindow, screen } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { scope } from './logger.js'
import { IPC } from '@shared/ipc.js'
import { ALLOWED_FPS, DEFAULT_SETTINGS, SCREENSHOT_SUBDIR } from '@shared/constants.js'
import { getSetting, setSetting } from './store.js'
import { setScreenshotMeta, deleteScreenshotMeta } from './clip-meta.js'
import { captureScreenshot } from './ffmpeg.js'
import { isInside, isWritable, nonEmptyString } from './util.js'
import { defaultOutputPath } from './obs-core.js'
import { channelLevel, deviceAvailable, listAudioApps, listDevices, channelDevices } from './audio.js'
import type {
  AudioChannel,
  BufferStatus,
  CaptureMode,
  DeleteScope,
  DeviceKind,
  FolderKind,
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
  reinitPipeline: (reason?: string) => Promise<void>
  notify: (type: BufferStatus, message?: string) => void
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

  /** Runs `fn` while broadcasting a transient status, restoring the previous one after. */
  const withStatus = async <T>(status: { status: ObsStatus; message?: string }, fn: () => Promise<T>): Promise<T> => {
    const win = s.getMainWindow()
    s.status.set(status)
    win?.webContents.send('obs-status', status)
    try {
      return await fn()
    } finally {
      const ready = OBS_STATUS_MESSAGES.ready
      s.status.set(ready)
      win?.webContents.send('obs-status', ready)
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
    try {
      if (replay().isReplayBufferActive()) {
        await replay().pauseReplayBuffer()
        s.status.set(OBS_STATUS_MESSAGES.paused)
      } else {
        await replay().startReplayBuffer(true)
        s.status.set(OBS_STATUS_MESSAGES.ready)
      }
      const win = s.getMainWindow()
      win?.webContents.send('obs-status', s.status.get())
      return ok({ active: replay().isReplayBufferActive() })
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
      const file = await replay().stopContinuousRecording()
      const sourceName = capture().getCurrentSourceName()
      const cm = require('./clip-manager.js')
      const meta = require('./clip-meta.js')

      const moved = cm.moveIntoSourceFolder(file, sourceName, obsCore().getConfig().outputPath)
      meta.setClipMeta(moved, {
        recordedAt: Date.now(),
        source: sourceName,
        audioTracks: obsCore().audioTrackLabels(),
      })

      s.getMainWindow()?.webContents.send('clip-saved', { clipPath: moved })

      void cm
        .describeSavedClip(moved, replay().getActiveEncoderVendor(), replay().getActiveEncoder(), replay().getQualityTarget(), sourceName)
        .then((info: { durationSec: number } | null) => cm.stampDuration(moved, info?.durationSec))
        .catch(() => {
          /* diagnostics only */
        })

      filesLog.info(`Recording saved: ${moved}`)
      return ok({ outputPath: moved })
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
        await replay().startReplayBuffer(true)
        s.status.set(OBS_STATUS_MESSAGES.ready)
      } else {
        await replay().pauseReplayBuffer()
        s.status.set(OBS_STATUS_MESSAGES.paused)
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
    if (!isBufferDuration(seconds)) return fail('Buffer duration must be between 5 and 300 seconds')
    const blocked = notReady()
    if (blocked) return blocked
    try {
      return await withStatus(OBS_STATUS_MESSAGES.changingSettings, async () => {
        obsCore().setBufferDuration(seconds)
        await replay().setBufferDuration(seconds)
        setSetting('bufferDuration', seconds)
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
    const root = getSetting('outputPath') as string
    if (target === undefined || target === null) {
      await shell.openPath(root)
      return ok()
    }
    if (typeof target !== 'string' || !isInsidePath(target, root)) {
      note('Attempted to open folder outside output directory')
      return fail('Invalid folder path')
    }
    await shell.openPath(target)
    return ok()
  })

  handle(IPC.openFile, async (file: unknown) => {
    const resolved = resolveVideo(file, s, 'open-file')
    if ('error' in resolved) return resolved
    await shell.openPath(resolved.path)
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

    try {
      return await withStatus(OBS_STATUS_MESSAGES.changingSettings, async () => {
        setSetting('outputPath', target)
        await obsCore().setOutputPath(target)
        filesLog.info(`Output path set to: ${target}`)
        return ok(target)
      })
    } catch (e) {
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
    await shell.openPath(screenshotPath())
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
    await shell.openPath(resolved.path)
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

  handle(IPC.getAudioDevices, () => ok(require('./audio.js').listDevices(obsCore().obs)))

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

  // Separate-track toggles change the mixer mask, which requires a chain rebuild.
  const applyTrackFlags = async (next: { separateAudioTracks: boolean; perDeviceAudioTracks: boolean }, label: string) => {
    const store = require('./store.js')
    const prev = {
      separateAudioTracks: store.getSetting('separateAudioTracks') as boolean,
      perDeviceAudioTracks: store.getSetting('perDeviceAudioTracks') as boolean,
    }
    if (prev.separateAudioTracks === next.separateAudioTracks && prev.perDeviceAudioTracks === next.perDeviceAudioTracks) {
      return ok()
    }

    store.setSetting('separateAudioTracks', next.separateAudioTracks)
    store.setSetting('perDeviceAudioTracks', next.perDeviceAudioTracks)

    try {
      await withStatus(OBS_STATUS_MESSAGES.changingSettings, () => obsCore().applyAudioTracks())
      log.info(`${label}: separate=${next.separateAudioTracks} perDevice=${next.perDeviceAudioTracks}`)
      return ok()
    } catch (e) {
      // Roll back so the UI never shows a state the engine didn't accept.
      store.setSetting('separateAudioTracks', prev.separateAudioTracks)
      store.setSetting('perDeviceAudioTracks', prev.perDeviceAudioTracks)
      try {
        await obsCore().applyAudioTracks()
      } catch (rollbackErr) {
        log.error('Failed to restore audio tracks after rollback:', rollbackErr)
      }
      return fail(`Failed to apply ${label}: ${messageOf(e)}`)
    }
  }

  handle(IPC.getSeparateAudioTracks, () => ok(getSetting('separateAudioTracks')))
  handle(IPC.setSeparateAudioTracks, async (value: unknown) => {
    if (typeof value !== 'boolean') return fail('Invalid value for Separate audio tracks')
    const store = require('./store.js')
    const perDevice = value ? (store.getSetting('perDeviceAudioTracks') as boolean) : false
    return applyTrackFlags({ separateAudioTracks: value, perDeviceAudioTracks: perDevice }, 'Separate audio tracks')
  })

  handle(IPC.getPerDeviceAudioTracks, () => ok(getSetting('perDeviceAudioTracks')))
  handle(IPC.setPerDeviceAudioTracks, async (value: unknown) => {
    if (typeof value !== 'boolean') return fail('Invalid value for Per-device audio tracks')
    const store = require('./store.js')
    if (value && !(store.getSetting('separateAudioTracks') as boolean)) {
      return fail('Per-device audio tracks need separate audio tracks on')
    }
    return applyTrackFlags(
      { separateAudioTracks: store.getSetting('separateAudioTracks') as boolean, perDeviceAudioTracks: value },
      'Per-device audio tracks',
    )
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
        return s.reinitPipeline(`Applying ${SETTING_LABELS[key] ?? key}...`)
      }
      bufferLog.info(`${key} change: rebuilding replay chain only`)
      await withStatus(OBS_STATUS_MESSAGES.changingSettings, () => replay().rebuildAndRestart())
    }

    try {
      await apply()
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
    key: 'notificationsEnabled' | 'notificationSoundEnabled' | 'launchOnStartup',
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
    if (!hk.registerHotkey(action as any, accelerator, action === 'save-replay' ? s.saveClipHotkey : () => void s.takeScreenshotHotkey())) {
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
      return ok(await require('./editor.js').getClipInfo(resolved.path, obsCore().audioTrackLabels()))
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
export async function saveClipAndNotify(s: Services): Promise<string> {
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
  s.notify('saved')

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

export async function takeScreenshot(s: Services): Promise<string> {
  const displayIndex = s.capture.getCurrentMonitor?.() ?? getSetting('displayIndex')
  const dir = screenshotPath()
  const file = await captureScreenshot(displayIndex, dir)

  setScreenshotMeta(file, {
    capturedAt: Date.now(),
    source: s.capture.getCurrentSourceName(),
  })

  s.notify('screenshot')
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
  const configured = getSetting('outputPath')
  if (configured && path.isAbsolute(configured)) return configured
  return defaultOutputPath()
}

export function screenshotPath(): string {
  const configured = getSetting('screenshotPath')
  if (configured && path.isAbsolute(configured)) return configured
  return path.join(outputRoot(), SCREENSHOT_SUBDIR)
}

async function scanScreenshots(s: Services): Promise<ScreenshotInfo[]> {
  const dir = screenshotPath()
  if (!fs.existsSync(dir)) return []

  const meta = require('./store.js').getScreenshotMeta?.() ?? {}
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

    out.push({
      id: full,
      path: full,
      name: entry.name,
      size,
      capturedAt: meta[full]?.capturedAt ?? mtimeMs,
      source: meta[full]?.source ?? null,
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
const isChannel = (v: unknown): v is AudioChannel => v === 'desktop' || v === 'microphone'
const isDeleteScope = (v: unknown): v is DeleteScope => v === 'both' || v === 'local' || v === 'cloud'
const isBufferDuration = (v: unknown): v is number => typeof v === 'number' && v >= 5 && v <= 300

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

export { DEFAULT_SETTINGS }
