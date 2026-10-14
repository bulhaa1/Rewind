import path from 'node:path'
import { app } from 'electron'
import { screen } from 'electron'
import { scope } from './logger.js'
import {
  getSettingSection,
  loadObs,
  saveSettingSection,
  setSettingValue,
  sleep,
  withTimeout,
  type ObsModule,
} from './obs-bind.js'
import { APP_FOLDER, MONITOR_LOG_INTERVAL_MS, OBS_SOURCE_NAMES, TIMING } from '@shared/constants.js'
import { writeProfileVideoSettings } from './obs-profile.js'
import { bindChildren, killChildren, OBS_EXE } from './process-lifetime.js'
import { getSetting } from './store.js'

const log = scope('OBS')

export interface ObsConfig {
  bufferDuration: number
  fps: number
  outputPath: string
  outputResolution: 'native' | '1080p' | '720p'
}

/**
 * The location the user picks; `rewindRoot` puts the app folder inside it.
 */
export function defaultOutputPath(): string {
  return app.getPath('videos')
}

/**
 * The directory clips actually live in: `<chosen location>\Rewind`.
 *
 * Every consumer goes through this rather than through the stored setting, so
 * the app owns one level of the chosen location instead of writing straight into
 * it.
 *
 * A stored path that already ends in `Rewind` is used as the root rather than
 * nested again. Without that, a user whose setting already pointed at the app
 * folder -- which is what every pre-1.1.0 install has -- would get
 * `...\Rewind\Rewind` the moment they upgraded.
 */
export function rewindRoot(configured?: string): string {
  const base = configured && path.isAbsolute(configured) ? configured : defaultOutputPath()
  if (path.basename(base).toLowerCase() === APP_FOLDER.toLowerCase()) return base
  return path.join(base, APP_FOLDER)
}

/**
 * Output size to write into the OBS profile at startup.
 *
 * Split out from `configureVideo` because the profile has to be on disk before OBS
 * starts, at which point there is no scene or source list to work from.
 */
function resolveStartupSize(config: ObsConfig, primary: Electron.Display): { width: number; height: number } {
  const size = { width: physicalWidth(primary), height: physicalHeight(primary) }
  return resolveOutputSize(size.width, size.height, config.outputResolution)
}
/**
 * Flattens an OBS config section into `{ settingName: currentValue }`.
 *
 * Sections come back as an array of entries, each holding a `parameters` list, so
 * reading one back means walking that structure rather than indexing it.
 */
function readSectionParams(section: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!Array.isArray(section)) return out
  for (const entry of section) {
    const params = (entry as { parameters?: { name: string; currentValue?: unknown }[] })?.parameters
    if (!Array.isArray(params)) continue
    for (const p of params) out[p.name] = p.currentValue
  }
  return out
}

export function resolveOutputSize(
  width: number,
  height: number,
  mode: ObsConfig['outputResolution'],
): { width: number; height: number } {
  if (mode === 'native') return { width, height }
  const ceiling = mode === '1080p' ? 1080 : 720
  if (height <= ceiling) return { width, height }
  const scale = ceiling / height
  const w = Math.round(width * scale)
  return { width: w - (w % 2), height: ceiling }
}

/**
 * Owns the OBS process lifetime and global configuration.
 *
 * Everything global (video canvas, audio context, monitor enumeration, scene) lives
 * here; per-source concerns are delegated to the services wired in via `wire()`.
 */
export class ObsCore {
  private initialized = false
  private abandoned = false
  private config: ObsConfig

  microphone: any = null

  captureService: any = null
  replayBufferService: any = null
  audioMixService: any = null
  audioDeviceChannelService: any = null

  /** Capture scene claimed for output channel 0; see `ensureOutputScene`. */
  private outputScene: any = null
  private outputSceneBound = false

  private pipeCounter = 0

  constructor(config?: Partial<ObsConfig>) {
    this.config = {
      bufferDuration: 60,
      fps: 60,
      outputResolution: 'native',
      ...config,
      // An unset path means the user hasn't chosen one yet; fall back to the default.
      outputPath: rewindRoot(config?.outputPath),
    }
  }

  wire(capture: any, replay: any, audioMix: any, audioDevices: any): void {
    this.captureService = capture
    this.replayBufferService = replay
    this.audioMixService = audioMix
    this.audioDeviceChannelService = audioDevices
  }

  get obs(): ObsModule | null {
    return loadObs().mod
  }

  getOBSDataPath(): string {
    return path.join(app.getPath('userData'), 'obs-data')
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      log.info('Already initialized')
      return
    }

    const { mod, error } = loadObs()
    if (error || !mod) {
      throw new Error(`obs-studio-node failed to load: ${error?.message ?? 'Unknown error'}`)
    }

    const dataPath = this.getOBSDataPath()
    log.info('Path:', path.join(process.resourcesPath, 'obs-studio-node'))
    log.info('Data Path:', dataPath)

    try {
      require('fs').mkdirSync(dataPath, { recursive: true })
    } catch {
      /* created lazily below if missing */
    }

    // OBS reads the frame rate out of the profile while starting, and its runtime
    // settings API quietly refuses to change it, so the file is written first.
    const startupSize = resolveStartupSize(this.config, screen.getPrimaryDisplay())
    let wroteProfile = writeProfileVideoSettings(dataPath, startupSize, this.config.fps)
    if (wroteProfile) {
      log.info(`Profile written for ${this.config.fps} fps at ${startupSize.width}x${startupSize.height}`)
    } else {
      log.warn('OBS profile does not exist yet; it is written once the engine has created it')
    }

    // Host our own IPC pipe so we own the obs64 child process. The counter lets a
    // reinit reuse the same name without colliding with the previous instance.
    const pipe = `rewind-${process.pid}-${++this.pipeCounter}`
    log.info(`Hosting OBS IPC pipe: ${pipe}`)
    mod.NodeObs.IPC.host(pipe)

    bindObsChildLifetime()

    mod.NodeObs.SetWorkingDirectory(obsWorkingDirectory())

    const rc = mod.NodeObs.OBS_API_initAPI('en-US', dataPath, '1.0.0')
    if (rc !== 0) throw new Error(`OBS initialization failed with code: ${rc}`)

    log.info('API initialized successfully')

    if (!wroteProfile) {
      // First run: OBS just created its profile. Writing it now takes effect on the
      // next start; without this, a fresh install silently stayed on OBS's 30 fps
      // default until something else restarted the engine.
      wroteProfile = writeProfileVideoSettings(dataPath, startupSize, this.config.fps)
      log.warn(
        wroteProfile
          ? 'OBS profile written after engine start; the frame rate applies from the next restart'
          : 'OBS profile still missing; the frame rate is left at OBS defaults',
      )
    }

    this.configureVideo()
    this.configureAudio()

    this.captureService.setupScene()
    this.setupAudioSources()
    this.replayBufferService.setupReplayBuffer()

    this.initialized = true
    log.info('ObsCore fully initialized')
  }

  /**
   * Video config is pushed through OBS's own settings API rather than `Video.video`,
   * then the render context is reset. This is the same path OBS's preferences use,
   * so it survives a reinit cleanly.
   */
  private configureVideo(): void {
    const mod = this.obs
    if (!mod) return

    // The canvas follows the primary display's physical pixel size. Using DIPs here
    // would silently halve the resolution on a 150%-scaled display.
    const primary = screen.getPrimaryDisplay()
    const size = { width: physicalWidth(primary), height: physicalHeight(primary) }

    const section = getSettingSection('Video')
    const out = resolveOutputSize(size.width, size.height, this.config.outputResolution)

    setSettingValue(section, 'Base', `${size.width}x${size.height}`)
    setSettingValue(section, 'Output', `${out.width}x${out.height}`)

    saveSettingSection('Video', section)

    const back = readSectionParams(getSettingSection('Video'))
    log.info(`Video configured: base=${size.width}x${size.height} output=${out.width}x${out.height} @ ${this.config.fps}fps`)
    log.info(
      'Video settings as OBS stored them: ' +
        (['Base', 'Output', 'FPSType', 'FPSCommon']
          .filter((k) => k in back)
          .map((k) => `${k}=${back[k]}`)
          .join(' ') || '(section empty)'),
    )

    // The frame rate cannot be changed live: the settings-section readback carries no
    // FPSNum, and OBS only reads [Video] while starting — the profile writer is what
    // actually applies it. The OBS-side log's `video info set` block remains the
    // authoritative readback; obs-studio-node's own stats getters (Global.cpuPercentage,
    // currentFrameRate, …) return garbage on this build (measured: 3.4e8 "fps").

    this.resetVideoContext('startup')
  }

  /**
   * Resets the video context and reports what OBS said.
   *
   * This is the only call that makes OBS adopt a new canvas size, and OBS refuses
   * it while an output holds the video context -- so the result is the difference
   * between "the canvas changed" and "the settings file changed". It used to be
   * discarded, which is why a refused reset looked exactly like a successful one.
   */
  private resetVideoContext(why: string): unknown {
    if (!this.obs) return undefined
    try {
      const call = this.obs.NodeObs as unknown as { OBS_service_resetVideoContext: () => unknown }
      const result = call.OBS_service_resetVideoContext()
      log.info(`Video context reset (${why}) returned ${typeof result === 'number' ? result : String(result)}`)
      return result
    } catch (e) {
      log.warn(`Could not reset video context (${why}):`, e)
      return undefined
    }
  }

  /**
   * Resizes the OBS canvas to the primary display without reinitialising.
   *
   * configureVideo() sizes the canvas once, at initialize(). That is fine until
   * the display changes -- 1080p to 720p, a laptop onto an external 4K, or a
   * virtual display appearing at a smaller size -- after which the canvas keeps
   * the size it was built with while the capture source reports the new one.
   * OBS scales the mismatch, which is the black half-screen and the zoomed-in
   * crop, and restarting used to be the only thing that cleared it.
   *
   * This is deliberately not a full reinit. reinitPipeline() costs about ten
   * seconds and tears down the replay chain; all a resize needs is
   * OBS_service_resetVideoContext(), which is the same call configureVideo()
   * ends on.
   *
   * Frame rate is deliberately left alone. It is applied by the profile writer at
   * engine start and cannot be changed live, so a resize must not reopen that.
   *
   * Returns whether anything actually changed, so the caller can skip a refit
   * when a metrics event fires without a real resolution change (a scale-factor
   * change, a colour-depth change, a spurious event).
   */
  /**
   * Whether the canvas is out of step with the primary display, without touching OBS.
   *
   * A metrics event fires for changes that do not alter the size at all -- a scale
   * factor, a colour depth, a monitor waking -- and acting on those would stop and
   * restart the replay chain, throwing away the rolling buffer, for a canvas that
   * was already correct.
   */
  canvasChangePending(): {
    changed: boolean
    base: { width: number; height: number }
    out: { width: number; height: number }
    previous: string | null
  } {
    const primary = screen.getPrimaryDisplay()
    const size = { width: physicalWidth(primary), height: physicalHeight(primary) }
    const out = resolveOutputSize(size.width, size.height, this.config.outputResolution)

    if (!this.obs) return { changed: false, base: size, out, previous: null }

    const before = readSectionParams(getSettingSection('Video'))
    if (before.Base === `${size.width}x${size.height}` && before.Output === `${out.width}x${out.height}`) {
      return { changed: false, base: size, out, previous: null }
    }
    return { changed: true, base: size, out, previous: typeof before.Base === 'string' ? before.Base : null }
  }

  syncCanvasToDisplay(): {
    changed: boolean
    base: { width: number; height: number }
    previous: string | null
  } {
    const pending = this.canvasChangePending()
    if (!pending.changed) return { changed: false, base: pending.base, previous: null }

    const section = getSettingSection('Video')
    setSettingValue(section, 'Base', `${pending.base.width}x${pending.base.height}`)
    setSettingValue(section, 'Output', `${pending.out.width}x${pending.out.height}`)
    saveSettingSection('Video', section)

    log.info(
      `Display changed: canvas ${pending.previous ?? 'unset'} -> ${pending.base.width}x${pending.base.height}, ` +
        `output ${pending.out.width}x${pending.out.height}`,
    )

    this.resetVideoContext('display change')

    return { changed: true, base: pending.base, previous: pending.previous }
  }

  /**
   * Test-only: forces the canvas to a size the display is not.
   *
   * A real resolution change is the only thing that normally moves the canvas, and
   * a test cannot ask the machine to change resolution without disrupting whoever
   * is using it. This writes Base and Output and then asks OBS to adopt them --
   * exactly what a display change does -- so the display tests can put OBS on a
   * stale canvas and watch what a save produces. Unreachable unless
   * `REWIND_SELFTEST_DISPLAY=1`; see scripts/displaytest.js.
   */
  forceCanvasSize(width: number, height: number): unknown {
    if (process.env.REWIND_SELFTEST_DISPLAY !== '1') throw new Error('forceCanvasSize is a test hook')
    const section = getSettingSection('Video')
    setSettingValue(section, 'Base', `${width}x${height}`)
    setSettingValue(section, 'Output', `${width}x${height}`)
    saveSettingSection('Video', section)
    log.info(`Display test: canvas forced to ${width}x${height}`)
    return this.resetVideoContext('forced by the display test')
  }

  private configureAudio(): void {
    const mod = this.obs
    if (!mod) return
    try {
      const section = getSettingSection('Audio')
      setSettingValue(section, 'SampleRate', '44100')
      setSettingValue(section, 'ChannelSetup', 'Stereo')
      // Disable the legacy OBS device routing; Rewind binds devices per-source.
      for (const name of ['Desktop1Device', 'Desktop2Device', 'AuxDevice1', 'AuxDevice2', 'AuxDevice3', 'AuxDevice4']) {
        setSettingValue(section, name, 'disabled')
      }
      saveSettingSection('Audio', section)
      try {
        mod.NodeObs.OBS_service_resetAudioContext()
      } catch (e) {
        log.warn('Could not reset audio context:', e)
      }
    } catch (e) {
      log.warn('Could not configure audio settings:', e)
    }
  }

  /**
   * OBS canvas follows the *primary* display's physical pixel size, matching the
   * original. A scale factor is applied so a non-native capture is letterboxed
   * rather than stretched.
   */
  private setupAudioSources(): void {
    this.audioMixService.setupDesktopMix()

    const mod = this.obs
    if (!mod) return

    this.microphone = createAudioSource(mod, {
      type: 'wasapi_input_capture',
      name: OBS_SOURCE_NAMES.microphone,
      settings: { device_id: getSetting('micDeviceId') },
      slot: 2,
      track: 3,
      boostable: true,
    })

    this.applyChannelLevel('microphone')
    this.audioDeviceChannelService.setup()

    // Report what actually got bound. A silently-missing source is the difference
    // between "no audio" and "audio you chose not to capture", and it is otherwise
    // invisible from the outside.
    log.info(`Audio sources: desktop=${this.audioMixService.describeSources()} microphone=${describeAudioSource(this.microphone)}`)
  }

  applyChannelLevel(channel: 'desktop' | 'microphone'): void {
    if (channel === 'desktop') {
      this.audioMixService.applyMaster()
      return
    }
    if (!this.microphone) return
    const { muted } = readChannelLevel('microphone')
    // Volume stays on the fader and gain goes through the filter, because only the
    // filter can amplify. The order in the signal is the reverse of this line: gain
    // first, volume second, so a zero volume is still complete silence.
    applyGain(this.microphone, muted ? 0 : getSetting('micVolume'), 'microphone')
    applyInputGain(this.microphone, getSetting('micGain'), 'microphone')
  }

  applyChannelDevice(channel: 'desktop' | 'microphone'): void {
    if (channel === 'desktop') {
      this.audioMixService.applyDesktopDevice()
      return
    }
    if (!this.microphone) return
    const id = getSetting('micDeviceId')
    try {
      this.microphone.source.update({ device_id: id })
      log.info(`Microphone device set to ${id}`)
    } catch (e) {
      log.error('Failed to switch microphone device:', e)
    }
  }

  /**
   * Recomputes the audio-track mixer mask and rebuilds the chain when it changed,
   * because OBS bakes the mixer into the replay buffer at start time.
   */
  async applyAudioTracks<T>(withRestart: (fn: () => Promise<T>) => Promise<T> = (f) => f()): Promise<void> {
    if (!this.initialized) return

    if (this.microphone) setSourceTrack(this.microphone, 3)
    this.audioMixService.applyTracks()
    this.audioDeviceChannelService.applyTracks()

    if (this.replayBufferService.isAudioTrackMaskStale()) {
      if (this.replayBufferService.isReplayBufferActive()) {
        await withRestart(() => this.replayBufferService.rebuildAndRestart())
      } else {
        this.replayBufferService['destroyReplayBufferInstances']?.()
      }
      log.info(`Audio tracks now 0b${this.audioTrackMask().toString(2)}`)
    }
  }

  /**
   * Bitmask of active tracks: the mix and desktop audio, the microphone when one
   * is capturable, and any extra device tracks.
   *
   * Split tracks are unconditional as of 1.1.0 -- there is no setting for it.
   * The microphone bit is the one condition worth testing, because a machine with
   * no capture-capable input otherwise writes a third AAC stream of digital
   * silence into every clip.
   */
  audioTrackMask(): number {
    const tracks = this.audioDeviceChannelService.channelTracks?.().map((t: any) => t.track) ?? []
    return computeMixerMask(this.hasCapturableMicrophone(), tracks)
  }

  /**
   * Whether a microphone is actually capturable.
   *
   * Device *presence*, not configuration: `setupAudioSources` always creates the
   * source and the picker offers only "Windows Default" plus real devices, so
   * "is a microphone configured" is true for essentially every user and would
   * gate nothing.
   *
   * Deliberately ignores mute and volume. The mask is only recomputed in
   * `applyAudioTracks`, and a stale mask triggers `rebuildAndRestart`, which
   * tears down and rebuilds the chain -- so gating on mute would empty the
   * rolling buffer on every toggle. Mute stays a live-tier control.
   */
  hasCapturableMicrophone(): boolean {
    if (!this.microphone) return false
    // Lazy: audio.ts imports from this module, so a static import back would be
    // circular. Same pattern the rest of the main process uses for audio.
    return require('./audio.js').deviceAvailable(this.obs, getSetting('micDeviceId'), 'microphone')
  }

  audioTrackLabels(): string[] {
    const channelTracks = this.audioDeviceChannelService.channelTracks?.() ?? []
    return buildTrackLabels(this.hasCapturableMicrophone(), channelTracks)
  }

  async setOutputPath(p: string): Promise<void> {
    this.config.outputPath = p
    if (!this.initialized) return
    if (this.replayBufferService.isReplayBufferActive()) {
      await this.replayBufferService.rebuildAndRestart()
    } else {
      this.replayBufferService['destroyReplayBufferInstances']?.()
    }
    log.info(`Output path set to: ${p}`)
  }

  getConfig(): ObsConfig {
    return { ...this.config }
  }

  setBufferDuration(seconds: number): void {
    this.config.bufferDuration = seconds
  }

  /**
   * The scene OBS renders for outputs that are not bound to an explicit channel.
   *
   * obs-studio-node's outputs connect through `obs_get_output_source(N)`, which is
   * null for every channel unless something claims it. A recording output with
   * nothing on its video channel never starts and emits no signals at all, so the
   * capture scene is registered here once and reused.
   */
  setOutputScene(scene: any): void {
    this.outputScene = scene
    // A new scene has not claimed the channel yet.
    this.outputSceneBound = false
  }

  /**
   * Claims video output channel 0 for the capture scene. Idempotent.
   *
   * obs-studio-node's outputs connect through `obs_get_output_source(0)`, and with
   * nothing bound there an advanced recording output has no video at all: it starts
   * nothing and emits no signal, which is indistinguishable from the encoder being
   * at fault. The setter lives on `Global` — the same object the audio path already
   * uses to bind its source slots — not on `NodeObs`.
   */
  ensureOutputScene(): boolean {
    const mod = this.obs
    if (!mod || !this.outputScene) return false
    if (this.outputSceneBound) return true
    try {
      const set = mod.Global?.setOutputSource
      if (!set) throw new Error('Global.setOutputSource is unavailable on this OBS build')
      set.call(mod.Global, 0, this.outputScene)

      // Read it back. A silent no-op here would leave the recorder broken in
      // exactly the same way while logging success, so confirm rather than assume.
      const bound = mod.Global.getOutputSource?.(0)
      if (bound?.name !== this.outputScene.name) {
        throw new Error(`channel 0 reports "${bound?.name ?? 'nothing'}" after binding`)
      }

      this.outputSceneBound = true
      log.info(`Output scene bound to channel 0: ${this.outputScene.name}`)
      return true
    } catch (e) {
      log.warn('Could not bind the output scene:', e)
      return false
    }
  }

  isInitialized(): boolean {
    return this.initialized
  }

  /**
   * Graceful teardown with escalating bailouts. If shutdown stalls past its budget
   * we mark the instance abandoned so the caller can force-kill obs64 instead of
   * leaving a half-torn-down process attached.
   */
  async shutdown(): Promise<void> {
    log.info('Shutting down...')
    try {
      if (!this.initialized) return

      if (this.replayBufferService) await this.replayBufferService.dispose()
      if (this.abandoned) return

      await sleep(TIMING.SHUTDOWN_STOP_DELAY)
      if (this.abandoned) return

      try {
        this.obs?.NodeObs.InitShutdownSequence()
      } catch {
        /* best effort */
      }

      this.captureService?.removeCurrentSource()
      this.audioDeviceChannelService?.teardown()
      this.audioMixService?.teardown()

      if (this.microphone) {
        destroyAudioSource(this.obs, this.microphone)
        this.microphone = null
      }

      this.captureService?.releaseScene()

      try {
        this.obs?.NodeObs.OBS_service_removeCallback()
      } catch {
        /* best effort */
      }

      await sleep(TIMING.SHUTDOWN_POST_DISCONNECT)
      if (this.abandoned) return

      try {
        this.obs?.NodeObs.IPC.disconnect()
      } catch {
        /* best effort */
      }

      await sleep(TIMING.SHUTDOWN_FINAL_CLEANUP)
    } catch (e) {
      log.error('Error during shutdown:', e)
    } finally {
      this.initialized = false
      if (!this.abandoned) killObsChildren()
    }
  }

  markAbandoned(): void {
    this.abandoned = true
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function obsWorkingDirectory(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'obs-studio-node')
  return path.dirname(require.resolve('@streamlabs/obs-studio-node'))
}

/** Binding the spawned obs64.exe to a kill-on-close job means it dies with us. */
function bindObsChildLifetime(): void {
  try {
    bindChildren(OBS_EXE)
  } catch {
    /* non-fatal: worst case obs64 outlives us and the next run cleans it up */
  }
}

/** Force-kills obs64 children; the recovery path after a failed shutdown. */
export function killObsChildren(): void {
  try {
    killChildren(OBS_EXE)
  } catch {
    /* noop */
  }
}

function physicalWidth(d: Electron.Display): number {
  return d.bounds.width * (d.scaleFactor || 1)
}
function physicalHeight(d: Electron.Display): number {
  return d.bounds.height * (d.scaleFactor || 1)
}

export function createAudioSource(
  mod: ObsModule,
  spec: { type: string; name: string; settings: Record<string, unknown>; slot: number; track: number; boostable?: boolean },
): any | null {
  let source: any = null
  try {
    source = mod.InputFactory.create(spec.type, spec.name, spec.settings)
    if (!source) {
      log.error(`Failed to create audio source (null): ${spec.name}`)
      return null
    }
    setSourceTrack({ source }, spec.track)
    mod.Global.setOutputSource(spec.slot, source)
    const fader = mod.FaderFactory.create(1)
    fader.attach(source)
    // Boost has to be a filter, not a louder fader: `obs_fader_create` gives every
    // fader type `max_db = 0.0f` and `obs_fader_set_db` clips to it, so a fader can
    // attenuate to silence but can never amplify. The gain filter is OBS's own input
    // gain stage and has no such ceiling. Only sources that expose a gain setting get
    // one; the others never call applyInputGain, so a filter on them would be dead weight.
    const gain = spec.boostable ? createInputGainFilter(mod, spec.name, source) : null
    return { source, fader, gain, slot: spec.slot, track: spec.track }
  } catch (e) {
    log.error(`Failed to create audio source ${spec.name}:`, e)
    // The slot was bound before the fader existed, and the caller gets null, so
    // nothing else can release it. Unbind and release, or the source stays in the
    // output slot for the life of the process with no handle to reach it.
    try {
      destroyAudioSource(mod, { source, slot: spec.slot })
    } catch (cleanupError) {
      log.warn(`Could not release the failed audio source ${spec.name}:`, cleanupError)
    }
    return null
  }
}

/** Below this the gain filter is inaudible; used as the floor for silence and for logs. */
const MUTE_DB = -200

/**
 * OBS's built-in gain filter, the one piece of the audio chain that can amplify.
 *
 * `gain_db` is a plain dB offset with no ceiling, which is what an input-gain control
 * needs. Failure is logged and returns null rather than throwing: a missing gain filter
 * must degrade to a working recorder without boost, never to a dead source.
 */
function createInputGainFilter(mod: ObsModule, name: string, source: any): any | null {
  try {
    const filter = mod.FilterFactory.create('gain_filter', `${name}-gain`, {})
    if (!filter) {
      log.warn(`Gain filter unavailable for ${name}; input boost will not apply`)
      return null
    }
    // Unity until something asks for a different level, so an untouched source is not
    // left at whatever the filter happens to default to.
    filter.update({ gain: 0 })
    source.addFilter?.(filter)
    // Whether the filter is genuinely attached decides whether boost works at all, and
    // a filter that was created but never attached still accepts writes silently.
    const attached = source.filters?.some?.((f: any) => f?.name === filter.name) ?? false
    log.info(`Gain filter for ${name}: created, attached=${attached}`)
    return filter
  } catch (e) {
    log.warn(`Failed to create gain filter for ${name}:`, e)
    return null
  }
}

/** Linear multiplier to the dB offset the gain filter expects. */
export function mulToDb(mul: number): number {
  // The filter's own floor. Anything at or below it is silence, and log10 of zero has
  // no answer, so this is the one value that has to be special-cased.
  if (mul <= 0) return MUTE_DB
  return Math.max(MUTE_DB, 20 * Math.log10(mul))
}

export function destroyAudioSource(mod: ObsModule | null, handle: any): void {
  if (!handle) return
  try {
    // The filter is owned by the source, so it has to be detached and released before
    // the source goes or OBS keeps a dangling reference to a freed object.
    handle.source?.removeFilter?.(handle.gain)
    handle.gain?.release?.()
  } catch {
    /* noop */
  }
  try {
    handle.fader?.detach?.()
  } catch {
    /* noop */
  }
  try {
    handle.fader?.destroy?.()
  } catch {
    /* noop */
  }
  try {
    mod?.Global.setOutputSource(handle.slot, null)
  } catch {
    /* noop */
  }
  try {
    handle.source?.release?.()
  } catch {
    /* noop */
  }
}

/**
 * Routes a source onto its dedicated track *and* the mix.
 *
 * OBS's `audioMixers` bitmask has bit 0 as the mix track, which is what the
 * recording muxer listens to by default. Setting only the dedicated track's bit
 * (e.g. 0b10 for desktop) leaves the source off the mix entirely, so recordings
 * come out with a valid but perfectly silent AAC stream. Every source therefore
 * needs bit 0 plus, when split tracks are enabled, its own track's bit.
 */
export function setSourceTrack(handle: any, track: number): void {
  try {
    handle.track = track
    handle.source.audioMixers = sourceTrackMask(track)
  } catch (e) {
    log.warn(`Failed to set audio tracks for ${handle.source?.name}:`, e)
  }
}

export function applyGain(handle: any, mul: number, label: string): void {
  try {
    handle.fader.mul = mul
  } catch (e) {
    log.warn(`Failed to apply ${label} audio level:`, e)
  }
}

/**
 * Input boost, in linear multipliers, applied through the source's gain filter.
 *
 * This cannot be a fader: `obs_fader_create` sets `max_db = 0.0f` for every fader type
 * and `obs_fader_set_db` clips to it, so an OBS fader can attenuate to silence but can
 * never amplify. Measured on this build, a fader handed 1.5 or 2.0 reports back 1 and the
 * recorded audio does not move. Writing the source's own `volume` instead is not an
 * escape either — it silences the source through this binding. The gain filter is OBS's
 * own input-gain stage and has no such ceiling.
 *
 * A missing filter is not an error worth failing a recording over: the source still
 * records, just without boost.
 */
export function applyInputGain(handle: any, mul: number, label: string): void {
  if (!handle?.gain) return
  try {
    const db = mulToDb(mul)
    handle.gain.update({ gain: db })
    // Read back rather than assumed: a filter that failed to attach would accept the
    // write silently, and a boost that was never applied is indistinguishable from a
    // boost that was applied and measured wrong.
    const applied = Number(handle.gain.settings?.['gain'])
    log.info(`${label} input gain: ${mul}x = ${db.toFixed(1)}dB (filter reports ${applied}dB)`)
  } catch (e) {
    log.warn(`Failed to apply ${label} input gain:`, e)
  }
}

/** Human-readable state of one bound audio source, for diagnostics. */
export function describeAudioSource(handle: any): string {
  if (!handle?.source) return 'none'
  try {
    // The fader reads back 1 for any value at or above unity, because OBS clamps a
    // fader at 0 dB. That is correct for this field — it reports the fader — but it
    // means a boost cannot be diagnosed here, so the gain filter is reported too. The
    // filter is read as a dB offset directly rather than round-tripped through the
    // multiplier, so a default that was never set still reads as unity.
    const boostDb = Number(handle.gain?.settings?.['gain'] ?? 0)
    const boost = handle.gain ? `, boost=${boostDb.toFixed(1)}dB` : ''
    return `${handle.source.name}(mixers=0b${(handle.source.audioMixers >>> 0).toString(2)}, mul=${handle.fader?.mul ?? '?'}${boost})`
  } catch {
    return 'unknown'
  }
}

function trackMask(track: number): number {
  return 1 << (track - 1)
}

/** Bit 0 (the mix) plus the source's dedicated track. */
export function sourceTrackMask(dedicatedTrack: number): number {
  let mask = trackMask(1)
  if (dedicatedTrack > 1) mask |= trackMask(dedicatedTrack)
  return mask
}

/**
 * Mix and desktop are always present. The microphone track is included only
 * when one is capturable -- see `ObsCore.hasCapturableMicrophone`.
 */
export function computeMixerMask(hasMicrophone: boolean, deviceTracks: number[]): number {
  let mask = trackMask(1) | trackMask(2) // mix + desktop
  if (hasMicrophone) mask |= trackMask(3)
  for (const t of deviceTracks) mask |= trackMask(t)
  return mask
}

/**
 * Labels matching `computeMixerMask` exactly.
 *
 * A `Microphone` entry is emitted only when the microphone track exists,
 * otherwise the editor would draw a lane for a track the file does not carry.
 */
export function buildTrackLabels(
  hasMicrophone: boolean,
  channelTracks: { track: number; label: string }[],
): string[] {
  const map = new Map<number, string[]>([[1, ['Mix']], [2, ['Desktop']]])
  if (hasMicrophone) map.set(3, ['Microphone'])
  for (const { track, label } of channelTracks) {
    map.set(track, [...(map.get(track) ?? []), label])
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, labels]) => labels.join(' + '))
}

// ---------------------------------------------------------------------------
// Setting readers
//
// `store.ts` has no dependency on this module, so the typed accessors are used
// directly rather than the untyped lazy `require` this used to go through.
// ---------------------------------------------------------------------------

function readChannelLevel(channel: 'desktop' | 'microphone'): { volume: number; muted: boolean } {
  return channel === 'desktop'
    ? { volume: getSetting('desktopVolume'), muted: getSetting('desktopMuted') }
    : { volume: getSetting('micVolume'), muted: getSetting('micMuted') }
}

export { MONITOR_LOG_INTERVAL_MS, withTimeout }