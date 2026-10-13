import { screen, type Display } from 'electron'
import os from 'node:os'
import { scope } from './logger.js'
import { Mutex, withTimeout, type ObsModule } from './obs-bind.js'
import { getSetting, setSetting } from './store.js'
import { DISPLAY_CAPTURE_FOLDER, GAME_CAPTURE_FOLDER, TIMING } from '@shared/constants.js'
import type { CaptureMode, MonitorInfo } from '@shared/types.js'

const log = scope('Capture')

/** OBS window_capture `method`. 2 = WGC, 0 = automatic. */
export const CAPTURE_METHOD = { AUTOMATIC: 0, WGC: 2 } as const

/**
 * Windows 10 build 20344+ (Win11 22H2) shipped the game-capture hooks needed for
 * OBS's `game_capture` source. Below that we fall back to WGC window capture.
 */
const GAME_HOOK_MIN_BUILD = 20344

export const hasGameHook = (): boolean => {
  if (process.platform !== 'win32') return false
  // os.release() is "10.0.<build>" on Windows; the build is the third field.
  const build = Number(os.release().split('.')[2] ?? 0)
  return build >= GAME_HOOK_MIN_BUILD
}

/**
 * One OBS source is live at a time. Switching stops the replay buffer, swaps the
 * source in the scene, and restarts — so every source switch is serialized through
 * `switchMutex` and stamped with a generation counter that lets stale async work
 * detect it has been superseded.
 */
export class CaptureManager {
  scene: any = null
  displaySource: any = null
  displaySceneItem: any = null

  currentMonitor = 0
  currentWindowId: string | null = null
  captureMode: CaptureMode = 'display'

  obsMonitors: { id: string; label: string; display?: Display; width: number; height: number }[] = []
  obsWindows: { value: string; name: string }[] = []

  canvasWidth = 0
  canvasHeight = 0

  replayBuffer: any = null
  gameDetector: any = null

  /**
   * Called with the file when a display change finished a recording in flight.
   * Wired to the same registration the pause path uses, so the clip still lands
   * in the library with its metadata.
   */
  onRecordingFinished: ((file: string) => void) | null = null

  private windowListProbed = false
  private lastWindowListProbeAt = 0
  private switchMutex = new Mutex()
  private sourceGeneration = 0
  private hookWaiter: { sourceName: string; processName: string; resolve: () => void } | null = null
  private onHookFallback = false
  /** True while the buffer is paused; no source should be live in that state. */
  private capturePaused = false

  constructor(private readonly obsCore: {
    obs: ObsModule | null
    isInitialized(): boolean
    setOutputScene?(scene: any): void
    ensureOutputScene?(): boolean
    /** Resizes the OBS canvas to the display. Returns whether it changed. */
    syncCanvasToDisplay?(): { changed: boolean; base: { width: number; height: number }; previous: string | null }
    /** Whether the canvas is out of step with the display, without writing anything. */
    canvasChangePending?(): { changed: boolean }
  }) {}

  setReplayBuffer(rb: any): void {
    this.replayBuffer = rb
  }

  setGameDetector(gd: any): void {
    this.gameDetector = gd
  }

  acquireSourceLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.switchMutex.run(fn)
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  setupScene(): void {
    const obs = this.obsCore.obs
    if (!obs) throw new Error('OBS not loaded')

    this.scene = obs.SceneFactory.create('main-scene')
    this.obsCore.setOutputScene?.(this.scene)
    // Bind the scene to video output channel 0 now rather than waiting for the first
    // recording: a recorder started before this has nothing to encode and silently
    // produces nothing.
    this.obsCore.ensureOutputScene?.()
    obs.NodeObs.RegisterSourceCallback((sources) => this.onSourceSizes(sources))

    const primary = screen.getPrimaryDisplay()
    this.canvasWidth = Math.round(primary.bounds.width * (primary.scaleFactor || 1))
    this.canvasHeight = Math.round(primary.bounds.height * (primary.scaleFactor || 1))

    // OBS enumerates monitors independently of Electron, so the two orderings can
    // differ. Probe OBS's list, then reconcile against Electron's by resolution.
    const probed = probeObsMonitors(obs, 'monitor_id')
      .filter((m) => m.value !== 'Auto')
      .map((m) => ({ id: m.value, label: m.name }))

    this.obsMonitors = reconcileMonitors(probed, screen.getAllDisplays())
    this.createSourceFromConfig(this.buildMonitorSourceConfig(this.currentMonitor))

    log.info(`Display capture configured (monitor ${this.currentMonitor})`)
  }

  /** Fired by OBS when any source reports new dimensions; used to detect a live game hook. */
  onSourceSizes(sources: { name: string; width: number; height: number }[]): void {
    const waiter = this.hookWaiter
    if (waiter && sources.some((s) => s.name === waiter.sourceName && s.width > 0)) {
      waiter.resolve()
    }
  }

  // -------------------------------------------------------------------------
  // Monitor helpers
  // -------------------------------------------------------------------------

  private getOBSMonitorId(index: number): string {
    const m = this.obsMonitors[index]
    if (m) return m.id
    log.warn(`Monitor index ${index} not found in OBS monitor list, using Auto`)
    return 'Auto'
  }

  private isPrimary(index: number): boolean {
    return this.obsMonitors[index]?.display?.id === screen.getPrimaryDisplay().id
  }

  primaryMonitorIndex(): number {
    const idx = this.obsMonitors.findIndex((_, i) => this.isPrimary(i))
    return Math.max(0, idx)
  }

  getDisplayName(index: number): string {
    return `Display ${index + 1}${this.isPrimary(index) ? ' (Primary)' : ''}`
  }

  getMonitors(): MonitorInfo[] {
    return this.obsMonitors.map((m, i) => ({
      id: m.id,
      name: this.getDisplayName(i),
      width: m.width,
      height: m.height,
      isPrimary: this.isPrimary(i),
    }))
  }

  private getMonitorResolution(index: number): { width: number; height: number } {
    const m = this.obsMonitors[index]
    if (m && m.width > 0 && m.height > 0) return { width: m.width, height: m.height }
    const p = screen.getPrimaryDisplay()
    return { width: Math.round(p.bounds.width * (p.scaleFactor || 1)), height: Math.round(p.bounds.height * (p.scaleFactor || 1)) }
  }

  // -------------------------------------------------------------------------
  // Source configs
  // -------------------------------------------------------------------------

  buildMonitorSourceConfig(index: number) {
    return {
      sourceType: 'monitor_capture',
      sourceName: `screen-capture-${Date.now()}`,
      settings: {
        monitor_id: this.getOBSMonitorId(index),
        capture_cursor: true,
        method: CAPTURE_METHOD.AUTOMATIC,
      },
      resolution: this.getMonitorResolution(index),
    }
  }

  /**
   * `useGameHook` selects OBS's `game_capture` (injection-based, anti-cheat friendly
   * on Win11) over `window_capture` (WGC, injection-free but no anti-cheat bypass).
   */
  buildWindowSourceConfig(windowId: string, useGameHook = false) {
    return useGameHook
      ? {
          sourceType: 'game_capture',
          sourceName: `game-capture-${Date.now()}`,
          settings: {
            capture_mode: 'window',
            window: windowId,
            capture_cursor: true,
            capture_audio: false,
            // Without this the hook copies frames at up to twice the video frame
            // rate, and a replay buffer only ever needs one copy per tick. The
            // extra copies are pure overhead inside the game process.
            limit_framerate: true,
          },
        }
      : {
          sourceType: 'window_capture',
          sourceName: `window-capture-${Date.now()}`,
          settings: {
            window: windowId,
            method: CAPTURE_METHOD.WGC,
            cursor: true,
            client_area: true,
            capture_audio: false,
          },
        }
  }

  createSourceFromConfig(config: any): void {
    const obs = this.obsCore.obs
    this.displaySource = obs!.InputFactory.create(config.sourceType, config.sourceName, config.settings)
    if (!this.displaySource) throw new Error(`Failed to create ${config.sourceType} source`)
    this.addSourceToScene(config.resolution)
  }

  /** Adds the live source to the scene, letterboxing it if it doesn't match the canvas. */
  private addSourceToScene(resolution?: { width: number; height: number }): void {
    if (!this.displaySource) return

    const r = resolution && resolution.width > 0 && resolution.height > 0
      ? resolution
      : { width: this.canvasWidth, height: this.canvasHeight }

    this.displaySceneItem = this.scene.add(this.displaySource)
    if (this.displaySceneItem) {
      const scale = Math.min(this.canvasWidth / r.width, this.canvasHeight / r.height)
      this.displaySceneItem.visible = true
      this.displaySceneItem.scale = { x: scale, y: scale }
      this.displaySceneItem.position = {
        x: Math.round((this.canvasWidth - r.width * scale) / 2),
        y: Math.round((this.canvasHeight - r.height * scale) / 2),
      }
      if (scale !== 1) {
        log.info(`Source fitted to canvas: src=${r.width}x${r.height} canvas=${this.canvasWidth}x${this.canvasHeight} scale=${scale.toFixed(3)}`)
      }
    }

    this.obsCore.obs?.Global.setOutputSource(0, this.scene.source ?? this.scene)
  }

  /**
   * Resizes the OBS canvas to the current display and re-fits the live source.
   *
   * Single entry point for a display change, because the two halves have to
   * happen together and obsCore is private here: OBS's canvas and this
   * manager's canvasWidth/Height are the same idea stored twice, and updating
   * one without the other is what produced the mismatched scaling.
   *
   * The replay chain comes down around the reset. OBS refuses to reset the video
   * context while an output holds it -- measured: the section said 1280x720, the
   * reset was called with the buffer live, and the next saved clip still came out
   * 2560x1440 -- so without this the canvas kept the size it was built with while
   * this manager's numbers moved to the new one. That disagreement is the black
   * half-screen and the zoomed-in crop.
   *
   * The cost is the rolling buffer: the frames held before the change are gone,
   * because an encode cannot change dimensions partway through. A clip already on
   * disk is untouched, and a recording still in flight is finished and handed to
   * `onRecordingFinished` rather than dropped.
   *
   * Returns null when nothing actually changed, so a caller can stay quiet about
   * an event that was not a real resolution change.
   */
  async applyDisplayChange(): Promise<{ from: string; to: string } | null> {
    const core = this.obsCore
    if (!core?.isInitialized?.()) return null
    if (!core.syncCanvasToDisplay) return null

    // Read before stopping anything: a metrics event that did not change the size (a
    // scale factor, a colour depth) must not cost the rolling buffer a restart.
    if (core.canvasChangePending && !core.canvasChangePending().changed) return null

    const buffer = this.replayBuffer
    const wasActive = buffer?.isReplayBufferActive?.() === true

    // stopReplayBuffer, never pauseReplayBuffer: `userPaused` is the user's flag,
    // and the chain goes straight back up below.
    if (wasActive) await buffer.stopReplayBuffer(true)

    let changed = false
    let from: string | null = null
    try {
      const result = core.syncCanvasToDisplay()
      changed = result.changed
      if (changed) {
        // What the section said, not what this manager believed: the two disagreed
        // for exactly as long as the reset was being refused.
        from = result.previous
        this.refreshCanvasForDisplay()
      }
    } finally {
      if (wasActive) {
        try {
          await buffer.startReplayBuffer(true)
        } catch (e) {
          // A dead buffer is worse than a stale canvas, and the panel can restart it.
          log.error('Display change: could not restart the replay buffer', e)
        }
      }
      const finished = buffer?.takeFinishedOnTeardown?.() ?? null
      if (finished) this.onRecordingFinished?.(finished)
    }

    if (!changed) return null
    const to = `${this.canvasWidth}x${this.canvasHeight}`
    log.info(`Capture canvas synced to the display: ${from ?? '(unknown)'} -> ${to}`)
    return { from: from ?? '(unknown)', to }
  }

  /**
   * Re-reads the display and re-fits the live source, without rebuilding it.
   *
   * The canvas size was captured once, in initialize(), and the scene item's
   * scale and offset were computed from it. After a resolution change that maths
   * is stale: a source larger than the canvas is scaled and cropped, a smaller
   * one is letterboxed into the middle of it, and the black half-screen and the
   * zoomed crop both come from here.
   *
   * Only the transform is recomputed. The source object itself is untouched, so
   * a recording already in flight keeps encoding the frames it was capturing and
   * does not get dropped mid-clip -- an encode cannot change dimensions partway
   * through, so the clip finishes at the size it started at and the next one
   * picks up the new size.
   *
   * Returns the new canvas size, or null when the display did not actually
   * change size.
   */
  refreshCanvasForDisplay(): { width: number; height: number } | null {
    const primary = screen.getPrimaryDisplay()
    const width = Math.round(primary.bounds.width * (primary.scaleFactor || 1))
    const height = Math.round(primary.bounds.height * (primary.scaleFactor || 1))
    if (width === this.canvasWidth && height === this.canvasHeight) return null

    const previous = `${this.canvasWidth}x${this.canvasHeight}`
    this.canvasWidth = width
    this.canvasHeight = height

    // A window or game source reports its own size, so it needs re-fitting.
    // A display source is the canvas, and OBS sizes it to match.
    if (this.displaySceneItem && this.captureMode !== 'display') {
      const resolution =
        this.captureMode === 'window' && this.currentWindowId
          ? undefined
          : this.getMonitorResolution(this.currentMonitor)
      this.fitSceneItem(resolution)
    } else if (this.displaySceneItem) {
      this.displaySceneItem.scale = { x: 1, y: 1 }
      this.displaySceneItem.position = { x: 0, y: 0 }
    }

    log.info(`Capture canvas ${previous} -> ${width}x${height}`)
    return { width, height }
  }

  /** Recomputes a scene item's scale and centring against the current canvas. */
  private fitSceneItem(resolution?: { width: number; height: number }): void {
    const item = this.displaySceneItem
    if (!item) return
    const r = resolution && resolution.width > 0 && resolution.height > 0
      ? resolution
      : { width: this.canvasWidth, height: this.canvasHeight }
    if (r.width <= 0 || r.height <= 0) return

    const scale = Math.min(this.canvasWidth / r.width, this.canvasHeight / r.height)
    item.scale = { x: scale, y: scale }
    item.position = {
      x: Math.round((this.canvasWidth - r.width * scale) / 2),
      y: Math.round((this.canvasHeight - r.height * scale) / 2),
    }
    log.info(
      `Source re-fitted: src=${r.width}x${r.height} canvas=${this.canvasWidth}x${this.canvasHeight} scale=${scale.toFixed(3)}`,
    )
  }

  private removeCurrentSource(): void {
    try {
      this.displaySceneItem?.remove?.()
    } catch {
      /* noop */
    }
    this.displaySceneItem = null
    try {
      this.displaySource?.release?.()
    } catch {
      /* noop */
    }
    this.displaySource = null
  }

  /**
   * The single choke point for changing what is being captured. Stopping the buffer
   * first means no frames are encoded from a half-removed source.
   */
  async switchCaptureSource(config: any): Promise<void> {
    this.sourceGeneration++
    this.onHookFallback = false

    // Stopping first means no frames are encoded from a half-removed source.
    await this.replayBuffer.stopReplayBuffer(true)

    // While the buffer is paused there is nothing to capture for. The requested
    // source is remembered in settings and installed by `resumeCapture`, so a
    // source change made in the paused state costs nothing now.
    if (this.capturePaused) {
      log.info('Capture is paused; the source change applies on resume')
      return
    }

    try {
      this.removeCurrentSource()
      this.createSourceFromConfig(config)
    } catch (e) {
      log.error('Failed to install capture source; leaving the buffer paused', e)
      throw e
    }

    // Restart even if the source looks wrong: a running buffer on a bad source is
    // recoverable, whereas a dead buffer leaves the user with nothing to save.
    await this.replayBuffer.startReplayBuffer(true)
  }

  private assertReady(): void {
    if (!this.obsCore.isInitialized() || !this.scene) throw new Error('OBS not initialized')
  }

  // -------------------------------------------------------------------------
  // Public source operations
  // -------------------------------------------------------------------------

  async switchToMonitor(index: number): Promise<{ width: number; height: number }> {
    const config = this.buildMonitorSourceConfig(index)
    await this.switchCaptureSource(config)
    this.currentMonitor = index
    this.currentWindowId = null
    return config.resolution
  }

  async setMonitor(index: number): Promise<void> {
    this.assertReady()
    await this.switchMutex.run(async () => {
      const { width, height } = await this.switchToMonitor(index)
      this.captureMode = 'display'
      log.info(`Switched to monitor ${index} (${width}x${height})`)
    })
  }

  async setWindow(windowId: string): Promise<void> {
    this.assertReady()
    await this.switchMutex.run(async () => {
      await this.switchCaptureSource(this.buildWindowSourceConfig(windowId))
      this.currentMonitor = this.primaryMonitorIndex()
      this.currentWindowId = windowId
      this.captureMode = 'window'
      this.windowListProbed = false
      log.info('Switched to window capture (WGC)')
    })
  }

  async autoDetectSwitchToWindow(windowId: string, bounds: Electron.Rectangle, processName = ''): Promise<void> {
    await this.switchMutex.run(async () => {
      await this.switchCaptureSource(this.buildWindowSourceConfig(windowId, hasGameHook()))
      this.currentWindowId = windowId
      this.windowListProbed = false
      log.info(`Auto-detect: switched to game window (${hasGameHook() ? 'game hook' : 'WGC'})`)
      this.watchHookOrFallBack(this.monitorIndexForRect(bounds), processName)
    })
  }

  /**
   * OBS's game hook can fail silently (anti-cheat, protected process). If the source
   * produces no frame within the timeout, revert to the monitor the game sits on.
   */
  private watchHookOrFallBack(fallbackIndex: number, processName = ''): void {
    if (!hasGameHook() || !this.displaySource) return

    const generation = this.sourceGeneration
    const sourceName = this.displaySource.name

    const firstFrame = (this.displaySource.width ?? 0) > 0
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          this.hookWaiter = { sourceName, processName, resolve }
        })

    withTimeout(firstFrame, TIMING.GAME_HOOK_TIMEOUT, 'Game capture hook timed out')
      .then(() => log.info('Game capture hooked'))
      .catch(() =>
        this.switchMutex.run(async () => {
          if (generation !== this.sourceGeneration) return
          log.warn(`Game capture hook produced no frame in ${TIMING.GAME_HOOK_TIMEOUT}ms, falling back to Display ${fallbackIndex + 1}`)
          await this.switchCaptureSource(this.buildMonitorSourceConfig(fallbackIndex))
          this.currentMonitor = fallbackIndex
          this.onHookFallback = true

          // Tell the detector to leave this process alone. Every fallback rebuilds
          // the replay chain, which empties the rolling buffer, so re-detecting the
          // same window repeatedly would leave nothing to save.
          this.gameDetector?.excludeProcess?.(this.lastHookedProcessName())
        }),
      )
      .catch((e) => log.error('Game capture hook fallback failed:', e))
      .finally(() => {
        if (this.hookWaiter?.sourceName === sourceName) this.hookWaiter = null
      })
  }

  /** Name of the process whose window the hook was waiting on, for exclusion. */
  private lastHookedProcessName(): string {
    return this.hookWaiter?.processName ?? ''
  }

  isOnHookFallback(): boolean {
    return this.onHookFallback
  }

  /** Maps a window rect to the monitor index that contains it. */
  monitorIndexForRect(rect: Electron.Rectangle): number {
    const center = screen.getDisplayNearestPoint({
      x: Math.round(rect.x + rect.width / 2),
      y: Math.round(rect.y + rect.height / 2),
    })
    const idx = this.obsMonitors.findIndex((m) => m.display?.id === center.id)
    return idx >= 0 ? idx : this.primaryMonitorIndex()
  }

  async autoDetectSwitchToDisplay(index: number): Promise<void> {
    await this.switchMutex.run(async () => {
      await this.switchToMonitor(index)
      this.captureMode = 'game'
      log.info(`Auto-detect mode: started with Display ${index + 1}`)
    })
    this.gameDetector?.setFallbackDisplayIndex?.(index)
    this.gameDetector?.start?.()
  }

  async setAutoDetectCapture(displayIndex: number): Promise<void> {
    this.assertReady()
    await this.autoDetectSwitchToDisplay(displayIndex)
  }

  stopGameDetector(): void {
    const gd = this.gameDetector
    if (gd?.isRunning?.()) {
      gd.stop()
      log.info('Game detector stopped')
    }
  }

  /**
   * Stops capture entirely: the detector stops, the live source is removed and the
   * game hook goes with it.
   *
   * OBS's game capture only stops copying frames once its source is gone; pausing
   * the replay buffer alone left it reading the game's frames at up to twice the
   * video rate, burning CPU and GPU for an output nothing consumed.
   */
  async pauseCapture(): Promise<void> {
    this.capturePaused = true
    // Invalidate any hook watch already in flight, or it can install a fresh
    // source moments after this teardown.
    this.sourceGeneration++
    this.hookWaiter = null
    this.stopGameDetector()
    await this.switchMutex.run(async () => {
      this.removeCurrentSource()
    })
    log.info('Capture stopped (buffer paused)')
  }

  /**
   * Re-installs the source the user last selected, restarts auto-detect and lets
   * the buffer start ride on the source install.
   */
  async resumeCapture(): Promise<void> {
    this.assertReady()
    this.capturePaused = false

    const mode = getSetting('captureMode')
    const displayIndex = getSetting('displayIndex')
    const windowId = getSetting('windowId')

    if (mode === 'game') {
      await this.setAutoDetectCapture(displayIndex)
      log.info('Capture resumed (auto-detect)')
      return
    }
    if (mode === 'window' && windowId) {
      try {
        await this.setWindow(windowId)
        this.refreshWindowList()
      } catch {
        log.warn('Failed to restore window capture, falling back to display')
        await this.setMonitor(displayIndex)
      }
      log.info('Capture resumed (window)')
      return
    }
    await this.setMonitor(displayIndex)
    log.info('Capture resumed (display)')
  }

  isCapturePaused(): boolean {
    return this.capturePaused
  }

  // -------------------------------------------------------------------------
  // Window list
  // -------------------------------------------------------------------------

  refreshWindowList(): { value: string; name: string }[] {
    // When switching INTO window mode we can read the live source's own property list,
    // which avoids a second probe source.
    const canReadFromLive =
      !this.windowListProbed && this.displaySource !== null && this.captureMode === 'window'
    this.windowListProbed = true

    const list = canReadFromLive
      ? readObsProperty(this.displaySource, 'window')
      : probeObsWindows(this.obsCore.obs)

    this.obsWindows = list.filter((w) => w.name)
    this.lastWindowListProbeAt = Date.now()
    return this.obsWindows
  }

  refreshWindowListIfStale(): { value: string; name: string }[] {
    if (this.windowListProbed && this.obsWindows.length > 0 && Date.now() - this.lastWindowListProbeAt < 30_000) {
      return this.obsWindows
    }
    return this.refreshWindowList()
  }

  isWindowListProbed(): boolean {
    return this.windowListProbed
  }

  getCaptureMode(): CaptureMode {
    return this.captureMode
  }

  /** Label shown in the UI's "Capturing" field. */
  getCurrentSourceName(): string {
    const gd = this.gameDetector
    if (gd?.isRunning?.()) {
      if (gd.isCapturingGame?.()) return gd.getActiveGameName?.() || GAME_CAPTURE_FOLDER
      return GAME_CAPTURE_FOLDER
    }
    if (this.captureMode === 'window' && this.currentWindowId) {
      const found = this.obsWindows.find((w) => w.value === this.currentWindowId)
      return found ? stripWindowTitle(found.name) : 'Window'
    }
    return DISPLAY_CAPTURE_FOLDER
  }

  getCurrentMonitor(): number {
    return this.currentMonitor
  }

  releaseScene(): void {
    try {
      this.obsCore.obs?.Global.setOutputSource(0, null)
    } catch {
      /* noop */
    }
    try {
      this.obsCore.obs?.NodeObs.RemoveSourceCallback()
    } catch {
      /* noop */
    }
    this.hookWaiter = null
    try {
      this.scene?.release?.()
    } catch {
      /* noop */
    }
    this.scene = null
  }
}

// ---------------------------------------------------------------------------
// OBS property probing
// ---------------------------------------------------------------------------

/**
 * Creates a throwaway source purely to enumerate the valid values of one property.
 * OBS exposes device lists only through live source objects, so probing is the only
 * way to get monitor ids / window handles.
 */
function probeProps(obs: ObsModule, sourceType: string, prop: string): { value: string; name: string }[] {
  let probe: any = null
  try {
    probe = obs.InputFactory.create(sourceType, `probe-${prop}-${Date.now()}`, {})
    return readObsProperty(probe, prop)
  } catch (e) {
    log.warn(`Failed to create ${sourceType} probe for '${prop}':`, e)
    return []
  } finally {
    try {
      probe?.release?.()
    } catch {
      /* noop */
    }
  }
}

function probeObsMonitors(obs: ObsModule, prop: string): { value: string; name: string }[] {
  return probeProps(obs, 'monitor_capture', prop)
}

function probeObsWindows(obs: ObsModule | null): { value: string; name: string }[] {
  if (!obs) return []
  return probeProps(obs, 'window_capture', 'window')
}

/**
 * Reads the value list of a list property (window handles, device ids, monitors).
 *
 * obs-studio-node exposes these as `IListProperty.details.items`, a plain array.
 * The `properties` object itself is a linked list of *properties*, not of values.
 */
function readObsProperty(source: any, prop: string): { value: string; name: string }[] {
  try {
    const props = source?.properties
    if (!props) return []

    const list = props.get?.(prop) ?? null
    const items = list?.details?.items
    if (!Array.isArray(items)) return []

    return items.map((i: { name: string; value: string | number }) => ({
      value: String(i.value),
      name: i.name,
    }))
  } catch (e) {
    log.warn(`Failed to read OBS property '${prop}':`, e)
    return []
  }
}

/**
 * Pairs OBS monitor entries with Electron displays.
 *
 * Neither side guarantees the same ordering, and the same resolution can appear more
 * than once, so we match on resolution first (consuming matches to keep duplicates
 * distinct) and fall back to positional pairing.
 */
function reconcileMonitors(
  obsList: { id: string; label: string }[],
  displays: Display[],
): { id: string; label: string; display?: Display; width: number; height: number }[] {
  const sizeOf = (d: Display) => ({
    width: Math.round(d.bounds.width * (d.scaleFactor || 1)),
    height: Math.round(d.bounds.height * (d.scaleFactor || 1)),
  })

  const byLabel = (label: string) => {
    const m = /(\d+)\s*x\s*(\d+)/.exec(label)
    if (!m) return null
    const w = Number(m[1])
    const h = Number(m[2])
    return w && h ? { width: w, height: h } : null
  }

  // Bucket Electron displays by resolution so duplicate monitors stay distinguishable.
  const buckets = new Map<string, Display[]>()
  for (const d of displays) {
    const { width, height } = sizeOf(d)
    const key = `${width - (width % 2)}x${height - (height % 2)}`
    buckets.set(key, [...(buckets.get(key) ?? []), d])
  }

  const out = obsList.map((o, i) => {
    const labelled = byLabel(o.label)
    const bucketKey = labelled ? `${labelled.width - (labelled.width % 2)}x${labelled.height - (labelled.height % 2)}` : null
    const match = bucketKey ? (buckets.get(bucketKey)?.shift() ?? null) : (displays[i] ?? null)
    const size = match ? sizeOf(match) : (labelled ?? { width: 0, height: 0 })
    return { ...o, display: match ?? undefined, width: size.width, height: size.height }
  })

  log.info(
    'OBS monitor order: ' +
      out.map((o, i) => `[${i}] ${o.label} -> ${o.display ? `electron#${displays.indexOf(o.display)}${o.display.internal ? ' internal' : ''}` : 'unmatched'} ${o.width}x${o.height}`).join('; '),
  )

  return out
}

/**
 * Normalizes an OBS window name for display.
 *
 * Window handles surface as `[exe.exe]: Title - Class (process: exe)`; the UI
 * wants the recognizable middle part, or the exe name when there is no title.
 */
export function stripWindowTitle(name: string): string {
  let s = name.trim()
  s = s.replace(/^\[[^\]]+\]\s*:?\s*/, '').trim()

  const proc = s.match(/\(process[:\s]+([^)]+)\)/i)
  if (proc) s = proc[1].replace(/\.exe$/i, '').trim()

  // Trailing " - Class" suffix, but only when something precedes it.
  const dash = s.lastIndexOf(' - ')
  if (dash > 0) s = s.slice(0, dash).trim()

  return s || name
}

export { getSetting, setSetting }