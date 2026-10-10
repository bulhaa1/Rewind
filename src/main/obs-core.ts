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
import { MONITOR_LOG_INTERVAL_MS, TIMING } from '@shared/constants.js'
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

/** Default output root: `<Videos>/Rewind`. */
export function defaultOutputPath(): string {
  return path.join(app.getPath('videos'), 'Rewind')
}

/** Scales the canvas down to a 16:9 ceiling, preserving aspect and even dimensions. */
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

/**
 * Writes the output frame rate into the OBS video profile.
 *
 * OBS's `FPSCommon` is an *enum index*, not a frame rate: 0 means "highest", 1 is
 * 30 and 2 is 60. Writing a frame rate into it — as `FPSCommon = 120` — is an
 * invalid enum, which OBS discards and leaves on its previous value. That is how a
 * 60 fps capture ends up labelled 120 fps. Anything outside the two common values
 * has to go through `Custom FPS Value`, so 120 needs an explicit num/den pair.
 */
export function applyOutputFps(section: unknown, fps: number): void {
  const whole = Math.max(1, Math.round(fps))
  const results: string[] = []

  const set = (name: string, value: string) => {
    results.push(`${name}=${setSettingValue(section, name, value) ? 'ok' : 'MISSING'}`)
  }

  if (whole === 30 || whole === 60) {
    set('FPSType', 'Common FPS Values')
    set('FPSCommon', whole === 30 ? '1' : '2')
  } else {
    set('FPSType', 'Integer FPS Value')
    set('FPSCommon', '0')
  }

  // Numerator and denominator are read regardless of FPSType, so keep them truthful
  // in case the user switches modes in OBS itself.
  set('FPSNum', String(whole))
  set('FPSDen', '1')

  log.info(`applyOutputFps(${whole}): ${results.join(' ')}`)
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
      outputPath: config?.outputPath || defaultOutputPath(),
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
    if (writeProfileVideoSettings(dataPath, startupSize, this.config.fps)) {
      log.info(`Profile written for ${this.config.fps} fps at ${startupSize.width}x${startupSize.height}`)
    } else {
      log.warn('Could not write the OBS profile; the capture may use the previous frame rate')
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
    applyOutputFps(section, this.config.fps)

    saveSettingSection('Video', section)

    // Read the values back: `FPSType` is an enum that OBS silently keeps at its
    // previous value when given something invalid, which is how a 120 fps request
    // ends up quietly recording at whatever rate came before.
    // Read the values back. `FPSType` is an enum, and OBS keeps its previous value
    // when handed something invalid — which is precisely how a 120 fps request ends
    // up quietly recording at the old rate. Only reading it back tells the two
    // apart.
    const back = readSectionParams(getSettingSection('Video'))
    log.info(`Video configured: base=${size.width}x${size.height} output=${out.width}x${out.height} @ ${this.config.fps}fps`)
    log.info(
      'Video settings as OBS stored them: ' +
        (['Base', 'Output', 'FPSType', 'FPSCommon', 'FPSNum', 'FPSDen']
          .filter((k) => k in back)
          .map((k) => `${k}=${back[k]}`)
          .join(' ') || '(section empty)'),
    )

    const applied = Number(back.FPSNum)
    if (applied !== Math.round(this.config.fps)) {
      log.warn(
        `OBS is configured for ${applied || 'an unknown'} fps but ${this.config.fps} was requested; ` +
          'clips will not match the requested frame rate',
      )
    }

    try {
      mod.NodeObs.OBS_service_resetVideoContext()
    } catch (e) {
      log.warn('Could not reset video context:', e)
    }
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
      name: 'microphone-audio',
      settings: { device_id: getSetting('micDeviceId') },
      slot: 2,
      track: 3,
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
    const { volume, muted } = readChannelLevel('microphone')
    applyGain(this.microphone, muted ? 0 : volume, 'microphone')
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

  /** Bitmask of active tracks: mix (1) plus, when split is on, desktop/mic/device tracks. */
  audioTrackMask(): number {
    const tracks = this.audioDeviceChannelService.channelTracks?.().map((t: any) => t.track) ?? []
    return computeMixerMask(getSetting('separateAudioTracks'), tracks)
  }

  audioTrackLabels(): string[] {
    const channelTracks = this.audioDeviceChannelService.channelTracks?.() ?? []
    return buildTrackLabels(getSetting('separateAudioTracks'), channelTracks)
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

  updateConfigOutputPath(p: string): void {
    this.config.outputPath = p
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
  spec: { type: string; name: string; settings: Record<string, unknown>; slot: number; track: number },
): any | null {
  try {
    const source = mod.InputFactory.create(spec.type, spec.name, spec.settings)
    if (!source) {
      log.error(`Failed to create audio source (null): ${spec.name}`)
      return null
    }
    setSourceTrack({ source }, spec.track)
    mod.Global.setOutputSource(spec.slot, source)
    const fader = mod.FaderFactory.create(1)
    fader.attach(source)
    return { source, fader, slot: spec.slot, track: spec.track }
  } catch (e) {
    log.error(`Failed to create audio source ${spec.name}:`, e)
    return null
  }
}

export function destroyAudioSource(mod: ObsModule | null, handle: any): void {
  if (!handle) return
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
    handle.source.audioMixers = sourceTrackMask(track, getSetting('separateAudioTracks'))
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

/** Human-readable state of one bound audio source, for diagnostics. */
export function describeAudioSource(handle: any): string {
  if (!handle?.source) return 'none'
  try {
    return `${handle.source.name}(mixers=0b${(handle.source.audioMixers >>> 0).toString(2)}, mul=${handle.fader?.mul ?? '?'})`
  } catch {
    return 'unknown'
  }
}

function trackMask(track: number): number {
  return 1 << (track - 1)
}

/** Bit 0 (the mix) plus the dedicated track when split tracks are on. */
export function sourceTrackMask(dedicatedTrack: number, separate: boolean): number {
  let mask = trackMask(1)
  if (separate && dedicatedTrack > 1) mask |= trackMask(dedicatedTrack)
  return mask
}

export function computeMixerMask(separate: boolean, deviceTracks: number[]): number {
  let mask = trackMask(1) // Mix always present
  if (!separate) return mask
  mask |= trackMask(2) | trackMask(3)
  for (const t of deviceTracks) mask |= trackMask(t)
  return mask
}

export function buildTrackLabels(
  separate: boolean,
  channelTracks: { track: number; label: string }[],
): string[] {
  const map = new Map<number, string[]>([[1, ['Mix']]])
  if (separate) {
    map.set(2, ['Desktop'])
    map.set(3, ['Microphone'])
    for (const { track, label } of channelTracks) {
      map.set(track, [...(map.get(track) ?? []), label])
    }
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