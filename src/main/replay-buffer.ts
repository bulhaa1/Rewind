import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scope } from './logger.js'
import { stitchSegments, type Segment } from './recording-stitch.js'
import { deferred, withTimeout, type ObsModule } from './obs-bind.js'
import { getSetting } from './store.js'
import {
  AUDIO_TRACK_COUNT,
  AUDIO_TRACK_KBPS,
  CQP_BY_QUALITY,
  ENCODER_TABLE,
  KEYINT_SEC,
  NVENC_PRESET_INDEX,
  OBS_FILE_FORMAT,
  OBS_SOURCE_NAMES,
  QSV_H264_LEGACY,
  QSV_TARGET_USAGE,
  REPLAY_PREFIX,
  RESOURCE_SAMPLE_INTERVAL_MS,
  TIMING,
  VBR_KBPS_BY_QUALITY,
  VENDOR_PREFERENCE,
  X264_ENCODER,
  X264_PRESET,
} from '@shared/constants.js'
import type { CaptureMode, EncoderVendor, VideoCodec } from '@shared/types.js'

const log = scope('ReplayBuffer')

type Vendor = Exclude<EncoderVendor, 'auto'>

/**
 * Reason a save failed because the capture chain was rebuilt mid-write.
 *
 * The game detector can switch sources while a save is flushing; the resulting file
 * is never produced, so the caller retries rather than surfacing a hard failure.
 */
export const REPLAY_RESTARTED = 'Recording restarted before the clip was written'

/** `EOutputSignal` from obs-studio-node. */
interface ObsSignal {
  type: string
  signal: string
  code: number
  error: string
}

export interface ReplayConfig {
  bufferDuration: number
  fps: number
  outputPath: string
  outputResolution: 'native' | '1080p' | '720p'
}

/**
 * Owns the entire OBS output chain for instant replay.
 *
 * The chain is deliberately built on AdvancedReplayBuffer with `usesStream = true`,
 * which is what lets OBS keep a rolling N-second buffer. Saving calls `save()`, which
 * flushes the buffered window to `path + fileFormat`.
 *
 * A dummy x264 encoder is parked on `.recording.videoEncoder` because the 0.25 replay
 * buffer requires a recording object to exist, even though `usesStream` means the
 * streaming encoder is the one actually used.
 */

/** Prefix for in-progress recording segments, so they are never mistaken for clips. */
const SEGMENT_PREFIX = 'Segment '

/** Video files OBS wrote into `dir` that start with `prefix`. */
function listSegmentFiles(dir: string, prefix = ''): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && /\.(mp4|mkv)$/i.test(f))
      .map((f) => path.join(dir, f))
  } catch {
    return []
  }
}

/** Video files in `dir` that OBS could have written. */
function listVideoFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /\.(mp4|mkv)$/i.test(f))
      .map((f) => path.join(dir, f))
  } catch {
    return []
  }
}

/** Modification time of `file`, or 0 when it cannot be read. */
function mtimeOf(file: string): number {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return 0
  }
}

/** True when `file` was written at or after `ms`. */
function modifiedAfter(file: string, ms: number): boolean {
  try {
    return fs.statSync(file).mtimeMs >= ms
  } catch {
    return false
  }
}

/**
 * Releases an OBS factory object, logging rather than throwing.
 *
 * An output holds a reference to its encoder, so leaking either one keeps a
 * hardware encoder locked and the next recording fails to start. Destroys that
 * take over a second are logged because that is the usual symptom of OBS
 * wedging during teardown.
 */
function destroyObsObject(obs: ObsModule | null, obj: any, factoryKey: keyof ObsModule, label: string): void {
  if (!obj) return
  const t0 = Date.now()
  try {
    const factory = (obs as any)?.[factoryKey]
    if (factory?.destroy) factory.destroy(obj)
    else log.warn(`No destroy() on ${factoryKey} for ${label}`)
  } catch (e) {
    log.warn(`Failed to destroy ${label}: ${e}`)
  }
  const took = Date.now() - t0
  if (took > 1000) log.warn(`Destroying ${label} took ${took}ms`)
}

export class ReplayBuffer {
  private replayBuffer: any = null
  /** Config donor for the replay buffer. Never started. */
  private replayConfig: any = null
  private streaming: any = null
  private streamingService: any = null
  private videoEncoder: any = null
  private streamingVideoEncoder: any = null

  private segments: Segment[] = []
  private segmentTimer: NodeJS.Timeout | null = null
  private segmentFlush: Promise<void> | null = null
  private recordingActive = false
  private recordingStartedAt = 0
  private scratchDir = ''

  private audioTracksEnsured = false
  private builtMixerMask: number | null = null
  private active = false
  private startedAt = 0
  private pendingSave: ReturnType<typeof deferred<string>> | null = null
  private pendingStop: ReturnType<typeof deferred<void>> | null = null
  private pendingStart: ReturnType<typeof deferred<void>> | null = null
  private lastObsError: { code: number; signal: string; error?: string } | null = null

  private usingSoftwareEncoder = false
  private hardwareFailures = 0

  private availableVendors: Vendor[] = ['x264']
  private detectedVendor: Vendor = 'x264'
  private qsvH264Id = 'obs_qsv11_v2'
  private codecsByVendor: Record<Vendor, VideoCodec[]> = {
    nvenc: [], amf: [], qsv: [], x264: ['h264'],
  }

  private resourceTimer: NodeJS.Timeout | null = null
  private lastCpu: NodeJS.CpuUsage | null = null
  private lastSampleAt = 0

  private abandoned = false

  constructor(
    private readonly obsCore: {
      obs: ObsModule | null
      isInitialized(): boolean
      getConfig(): ReplayConfig
      updateConfigOutputPath(p: string): void
      audioTrackMask(): number
      ensureOutputScene?(): boolean
    },
    private readonly onLogClipSave?: (file: string) => void,
  ) {}

  // -------------------------------------------------------------------------
  // Capability probing
  // -------------------------------------------------------------------------

  /** Reads OBS's encoder registry and derives which (vendor, codec) pairs are usable. */
  probeAvailableCodecs(): void {
    let types: string[] = []
    try {
      const vf = this.obsCore.obs?.VideoEncoderFactory
      types = vf?.types() ?? []
      log.info(`OBS video encoder types: ${types.join(', ') || '(none)'}`)
    } catch (e) {
      log.warn('Failed to probe available encoders:', e)
    }

    // obs_qsv11_v2 is the modern QSV H.264 encoder; fall back to the legacy id.
    this.qsvH264Id = !types.includes('obs_qsv11_v2') && types.includes(QSV_H264_LEGACY)
      ? QSV_H264_LEGACY
      : 'obs_qsv11_v2'

    const codecsFor = (vendor: Vendor): VideoCodec[] => {
      const table = ENCODER_TABLE[vendor]
      return (Object.keys(table) as VideoCodec[]).filter((codec) => {
        const id = vendor === 'qsv' && codec === 'h264' ? this.qsvH264Id : table[codec]
        return types.includes(id!)
      })
    }

    this.codecsByVendor = {
      nvenc: codecsFor('nvenc'),
      amf: codecsFor('amf'),
      qsv: codecsFor('qsv'),
      x264: ['h264'],
    }

    this.availableVendors = VENDOR_PREFERENCE.filter((v) => this.codecsByVendor[v].length > 0)
    this.detectedVendor = this.availableVendors[0] ?? 'x264'

    log.info(
      `Encoder vendors detected: ${this.availableVendors.join(', ')} (default=${this.detectedVendor}, ` +
      `codecs nvenc=[${this.codecsByVendor.nvenc.join(',')}] amf=[${this.codecsByVendor.amf.join(',')}] ` +
      `qsv=[${this.codecsByVendor.qsv.join(',')}])`,
    )
  }

  getAvailableEncoderVendors() {
    return this.availableVendors.map((vendor) => ({
      vendor,
      label: { nvenc: 'NVIDIA NVENC', amf: 'AMD AMF', qsv: 'Intel QSV', x264: 'x264' }[vendor],
      isHardware: vendor !== 'x264',
      codecs: [...this.codecsByVendor[vendor]],
    }))
  }

  getAvailableCodecs(): VideoCodec[] {
    if (this.usingSoftwareEncoder) return ['h264']
    return [...this.codecsByVendor[this.resolveEncoderVendor()]]
  }

  getActiveEncoderVendor(): EncoderVendor {
    return this.usingSoftwareEncoder ? 'x264' : this.resolveEncoderVendor()
  }

  getActiveEncoder(): string {
    return this.usingSoftwareEncoder ? X264_ENCODER : this.desiredHardwareEncoder()
  }

  /** Human-readable quality target, used in the "Clip saved:" diagnostics line. */
  getQualityTarget(): string {
    return this.getActiveEncoder() === X264_ENCODER
      ? `VBR ${VBR_KBPS_BY_QUALITY[getSetting('visualQuality')]}kbps`
      : `CQP ${CQP_BY_QUALITY[getSetting('visualQuality')]}`
  }

  // -------------------------------------------------------------------------
  // Vendor / codec resolution
  // -------------------------------------------------------------------------

  private resolveEncoderVendor(): Vendor {
    const pref = getSetting('videoEncoder')
    if (pref !== 'auto' && this.availableVendors.includes(pref)) return pref
    return this.detectedVendor
  }

  private desiredHardwareEncoder(): string {
    const vendor = this.resolveEncoderVendor()
    if (vendor === 'x264') return X264_ENCODER

    const want = getSetting('videoCodec')
    const codec = this.codecsByVendor[vendor].includes(want) ? want : 'h264'
    const id = ENCODER_TABLE[vendor][codec]
    if (!id) return X264_ENCODER
    if (vendor === 'qsv' && codec === 'h264') return this.qsvH264Id
    return id
  }

  /**
   * Builds the encoder settings object. Each vendor family expects a different
   * rate-control vocabulary, so this branches per family rather than normalizing.
   */
  private encoderSettings(encoderId: string): Record<string, unknown> {
    const quality = getSetting('visualQuality')
    const cqp = CQP_BY_QUALITY[quality]

    if (encoderId.startsWith('obs_nvenc_')) {
      const profile = encoderId === 'obs_nvenc_h264_tex' ? 'high' : 'main'
      return {
        rate_control: 'CQP',
        cqp,
        preset: 'hq',
        preset2: NVENC_PRESET_INDEX[getSetting('nvencPreset')],
        tune: 'hq',
        multipass: getSetting('nvencMultipass'),
        profile,
        keyint_sec: KEYINT_SEC,
      }
    }

    if (encoderId.startsWith('h264_texture_amf') || encoderId.startsWith('h265_texture_amf') || encoderId.startsWith('av1_texture_amf')) {
      const profile = encoderId === 'h265_texture_amf' ? 'main' : 'high'
      return { rate_control: 'CQP', cqp, QualityPreset: 'quality', profile, keyint_sec: KEYINT_SEC }
    }

    if (encoderId.startsWith('obs_qsv11')) {
      const profile = encoderId === 'obs_qsv11_hevc' ? 'main' : 'high'
      return { rate_control: 'ICQ', icq_quality: cqp, target_usage: QSV_TARGET_USAGE, profile, keyint_sec: KEYINT_SEC }
    }

    const bitrate = VBR_KBPS_BY_QUALITY[quality]
    return {
      rate_control: 'VBR',
      bitrate,
      max_bitrate: Math.round(bitrate * 1.5),
      preset: X264_PRESET,
      profile: 'high',
      keyint_sec: KEYINT_SEC,
    }
  }

  // -------------------------------------------------------------------------
  // Chain construction
  // -------------------------------------------------------------------------

  setupReplayBuffer(): void {
    this.probeAvailableCodecs()
    this.createReplayBufferInstances()
  }

  private createReplayBufferInstances(): void {
    const obs = this.obsCore.obs
    if (!obs) throw new Error('OBS not loaded')

    let config = this.obsCore.getConfig()

    // Resolve and verify the output directory before touching OBS.
    try {
      if (!fs.existsSync(config.outputPath)) {
        fs.mkdirSync(config.outputPath, { recursive: true })
        log.info(`Created output directory: ${config.outputPath}`)
      }
    } catch (e) {
      log.warn(`Cannot create output directory ${config.outputPath}: ${e}`)
    }

    this.destroyReplayBufferInstances()
    this.ensureAudioTracks()

    const mixer = this.obsCore.audioTrackMask()
    const encoderId = this.getActiveEncoder()

    try {
      // Any truthy value signals "use the streaming output" to OBS, which is what makes
      // the replay buffer roll instead of writing continuously.
      this.streaming = obs.AdvancedStreamingFactory.create()
      this.streaming.audioTrack = 1
      this.streaming.enforceServiceBitrate = false

      const settings = this.encoderSettings(encoderId)
      this.streamingVideoEncoder = obs.VideoEncoderFactory.create(encoderId, OBS_SOURCE_NAMES.replayEncoder, settings)
      this.streaming.videoEncoder = this.streamingVideoEncoder
      log.info(`Created replay encoder: ${encoderId} settings=${JSON.stringify(settings)}`)

      // OBS requires a service object even for local-only use; a stub keeps it happy.
      try {
        this.streamingService = obs.ServiceFactory.create('rtmp_common', OBS_SOURCE_NAMES.streamingService, {
          server: 'rtmp://localhost/live',
          key: '',
        })
        this.streaming.service = this.streamingService
      } catch (e) {
        log.warn('Failed to create streaming service stub:', e)
      }

      // Unused placeholder: `usesStream = true` means the streaming encoder wins,
      // but the recording object still has to be valid.
      this.videoEncoder = obs.VideoEncoderFactory.create(X264_ENCODER, OBS_SOURCE_NAMES.recordingPlaceholder, {
        rate_control: 'CBR', bitrate: 1000, keyint_sec: KEYINT_SEC,
      })

      // A config donor, not a second recorder. `usesStream = true` means the
      // streaming encoder does all the real work, but obs-studio-node's replay
      // buffer still insists on a recording object to read its settings from.
      // This one is never started.
      this.replayConfig = obs.AdvancedRecordingFactory.create()
      this.replayConfig.videoEncoder = this.videoEncoder
      this.replayConfig.path = config.outputPath
      this.replayConfig.format = 'mp4'
      this.replayConfig.fileFormat = OBS_FILE_FORMAT
      this.replayConfig.overwrite = false
      this.replayConfig.noSpace = false
      this.replayConfig.muxerSettings = ''
      this.replayConfig.mixer = mixer
      this.replayConfig.streaming = this.streaming

      this.replayBuffer = obs.AdvancedReplayBufferFactory.create()
      this.replayBuffer.recording = this.replayConfig
      this.replayBuffer.streaming = this.streaming
      this.replayBuffer.usesStream = true
      this.replayBuffer.duration = config.bufferDuration
      this.replayBuffer.path = config.outputPath
      this.replayBuffer.format = 'mp4'
      this.replayBuffer.fileFormat = OBS_FILE_FORMAT
      this.replayBuffer.prefix = REPLAY_PREFIX
      this.replayBuffer.suffix = ''
      this.replayBuffer.overwrite = false
      this.replayBuffer.noSpace = false
      this.replayBuffer.muxerSettings = ''
      this.replayBuffer.mixer = mixer
      this.replayBuffer.videoEncoder = this.streamingVideoEncoder

      // Output signals are delivered by assigning `signalHandler` on each output
      // object. Without this the replay buffer starts but nothing ever confirms it,
      // and every start/save/save-wait times out.
      this.replayBuffer.signalHandler = (signal: ObsSignal) => this.handleSignal(signal)
      this.streaming.signalHandler = (signal: ObsSignal) => this.handleSignal(signal)

      this.builtMixerMask = mixer
      log.info(
        `Replay buffer configured: ${config.bufferDuration}s, vendor=${this.getActiveEncoderVendor()}, ` +
        `encoder=${encoderId}, audio tracks=0b${mixer.toString(2)}, output: ${config.outputPath}`,
      )
      config = this.obsCore.getConfig()
    } catch (e) {
      this.destroyReplayBufferInstances()
      throw e
    }
  }

  /** OBS keeps 6 AAC tracks alive so per-device tracks can be enabled without reinit. */
  private ensureAudioTracks(): void {
    if (this.audioTracksEnsured) return
    const obs = this.obsCore.obs
    if (!obs?.AudioTrackFactory) return
    try {
      for (let i = 1; i <= AUDIO_TRACK_COUNT; i++) {
        let exists = false
        try {
          exists = !!obs.AudioTrackFactory.getAtIndex(i)
        } catch {
          /* not created yet */
        }
        if (!exists) {
          const track = obs.AudioTrackFactory.create(AUDIO_TRACK_KBPS, `track${i}`)
          obs.AudioTrackFactory.setAtIndex(track, i)
          log.info(`Created audio track ${i} @ ${AUDIO_TRACK_KBPS}kbps`)
        }
      }
      this.audioTracksEnsured = true
    } catch (e) {
      log.warn('Failed to ensure audio tracks:', e)
    }
  }

  /** True when the audio-track mix changed since the chain was built. */
  isAudioTrackMaskStale(): boolean {
    return this.builtMixerMask !== null && this.builtMixerMask !== this.obsCore.audioTrackMask()
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async startReplayBuffer(retry = false): Promise<void> {
    if (!this.obsCore.isInitialized()) throw new Error('OBS not initialized')

    const canRetryHardware = this.hardwareFailures < TIMING.HARDWARE_FAILURE_CAP
    const wantsHardware = this.resolveEncoderVendor() !== 'x264'

    // Coming back from a software fallback: try hardware again if we have budget left.
    if (retry && this.usingSoftwareEncoder && canRetryHardware && wantsHardware) {
      this.resetToHardwareEncoder()
    }

    this.replayBuffer ??= this.createAndReturn()

    try {
      if (retry) await this.startWithRetry()
      else this.replayBuffer.start()

      this.active = true
      this.startedAt = Date.now()
      if (!this.usingSoftwareEncoder) this.hardwareFailures = 0
      this.startResourceSampling()
    } catch (e) {
      log.error('Failed to start replay buffer:', e)
      if (!this.usingSoftwareEncoder && retry) {
        this.hardwareFailures++
        log.info(`Attempting fallback to software encoder (hardware failure #${this.hardwareFailures})...`)
        try {
          await this.fallbackToSoftwareEncoder()
          return
        } catch (fallbackErr) {
          log.error('Software encoder fallback also failed:', fallbackErr)
        }
      }
      this.active = false
      throw e
    }
  }

  private createAndReturn(): any {
    this.createReplayBufferInstances()
    return this.replayBuffer
  }

  /**
   * OBS buffer starts occasionally wedge on a busy GPU. Give the first attempt a
   * short window, then stop/clean up and try once more with a longer window.
   */
  private async startWithRetry(): Promise<void> {
    try {
      await this.startWithSignal(TIMING.START_FIRST_ATTEMPT)
      return
    } catch {
      log.warn('Replay buffer start timed out, retrying after cleanup...')
    }

    try {
      this.replayBuffer?.stop?.(false)
    } catch {
      /* noop */
    }

    // Best-effort stop: a wedged buffer may never confirm. Swallow that rejection so
    // it isn't mistaken for a second start failure.
    const stopWait = deferred<void>(TIMING.RETRY_STOP_FALLBACK)
    this.pendingStop = stopWait
    await stopWait.promise.catch(() => {})

    await this.startWithSignal(TIMING.START_RETRY)
  }

  private async startWithSignal(ms: number): Promise<void> {
    this.replayBuffer ??= this.createAndReturn()
    const suffix = this.lastObsError
      ? ` (Last error: code ${this.lastObsError.code}, signal: ${this.lastObsError.signal})`
      : ''
    const d = deferred<void>(ms, `Timeout waiting for replay buffer start${suffix}`)
    this.pendingStart = d
    this.replayBuffer.start()
    await d.promise
  }

  private resetToHardwareEncoder(): void {
    if (this.resolveEncoderVendor() === 'x264') return
    this.usingSoftwareEncoder = false
    const encoder = this.desiredHardwareEncoder()
    this.createReplayBufferInstances()
    log.info(`Reset encoder to hardware (${encoder}) for source switch`)
  }

  private async fallbackToSoftwareEncoder(): Promise<void> {
    this.usingSoftwareEncoder = true
    log.info('Falling back to software encoder (obs_x264)...')
    this.createReplayBufferInstances()
    log.info('Retrying replay buffer start with software encoder...')
    await this.startWithSignal(TIMING.START_RETRY)
    this.active = true
    this.startedAt = Date.now()
    log.info('Replay buffer started successfully with software encoder')
  }

  async stopReplayBuffer(force = false): Promise<void> {
    if (!this.obsCore.isInitialized()) return
    if (!this.active && !force) return

    try {
      // `force` is used by source switches, which must tear the chain down even if
      // the buffer never reported itself active.
      await this.destroyRunningChain()
      log.info('Replay buffer paused')
    } catch (e) {
      log.error('Failed to stop replay buffer:', e)
    }
  }

  async pauseReplayBuffer(): Promise<void> {
    await this.destroyRunningChain()
    log.info('Replay buffer paused')
  }

  /**
   * A recording finished as a side effect of the buffer tearing down, if any.
   *
   * Set by `destroyRunningChain` when continuous recording was still running. The
   * caller that asked for the buffer to stop consumes this and does the same
   * post-processing an explicit stop would, rather than leaving the file
   * un-registered and invisible in the library.
   */
  private finishedOnTeardown: string | null = null

  /** Takes the recording finished by a teardown, if there was one. */
  takeFinishedOnTeardown(): string | null {
    const file = this.finishedOnTeardown
    this.finishedOnTeardown = null
    return file
  }

  private async destroyRunningChain(): Promise<void> {
    /*
     * Continuous recording did not stop when the buffer stopped. `destroyRunningChain`
     * set `active = false` and left `recordingActive` true, so after the user stopped
     * the buffer the panel's record timer kept counting against OBS's own clock, and
     * the segments already written were never joined -- they sat in scratch until the
     * next recording overwrote them.
     *
     * This runs before the teardown, not after: taking the final segment needs the
     * output still alive. It is finished properly rather than abandoned, because
     * silently discarding minutes of footage because someone pressed the wrong button
     * is the worse failure of the two.
     */
    if (this.recordingActive) {
      try {
        this.finishedOnTeardown = await this.stopContinuousRecording()
      } catch (e) {
        // Teardown must complete even if the recording cannot be finished.
        // stopContinuousRecording clears the flag on its own failure paths, but not
        // on every one, and a stuck flag is exactly what this exists to prevent.
        this.recordingActive = false
        this.cleanupScratch()
        log.warn('Buffer stopped mid-recording; the recording could not be finished:', e)
      }
    }

    const wasActive = this.active
    this.active = false
    this.startedAt = 0
    this.stopResourceSampling()

    // A save in flight can never complete once the chain is torn down. Fail it now
    // with a clear reason instead of letting the caller sit out the full timeout.
    if (this.pendingSave && !settled(this.pendingSave)) {
      this.pendingSave.reject(new Error(REPLAY_RESTARTED))
      this.pendingSave = null
    }

    if (this.replayBuffer) {
      /*
       * Only wait for a stop signal from a buffer that is actually running.
       *
       * `switchCaptureSource` stops the buffer before installing a new source, and
       * at first startup that stop happens before the buffer has ever run. There is
       * nothing to signal, so the await sat out the full STOP_SIGNAL every launch
       * -- five seconds before anything could be captured. `wasActive` says whether
       * there is a run to end; without it the wait is pure dead time.
       */
      if (wasActive) {
        const d = deferred<void>(TIMING.STOP_SIGNAL)
        this.pendingStop = d
        this.replayBuffer.stop(false)
        try {
          await d.promise
        } catch {
          /* the stop signal may never arrive; the destroy below is authoritative */
        }
      }
    }

    this.destroyReplayBufferInstances()
  }

  private destroyReplayBufferInstances(): void {
    const obs = this.obsCore.obs
    this.builtMixerMask = null

    const destroy = (obj: any, factoryKey: keyof ObsModule | null, label: string) => {
      if (!obj) return
      const t0 = Date.now()
      try {
        const factory = factoryKey ? (obs as any)?.[factoryKey] : null
        if (factory?.destroy) factory.destroy(obj)
      } catch (e) {
        log.warn(`Failed to destroy ${label}: ${e}`)
      }
      const took = Date.now() - t0
      if (took > 1000) log.warn(`Destroying ${label} took ${took}ms`)
    }

    destroy(this.replayBuffer, 'AdvancedReplayBufferFactory', 'replay buffer')
    destroy(this.replayConfig, 'AdvancedRecordingFactory', 'replay config')
    destroy(this.streaming, 'AdvancedStreamingFactory', 'streaming')
    destroy(this.streamingService, 'ServiceFactory', 'streaming service')

    this.replayBuffer = null
    this.replayConfig = null
    this.streaming = null
    this.streamingService = null
    this.videoEncoder = null
    this.streamingVideoEncoder = null
  }

  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // Continuous recording
  //
  // A second OBS output would be the obvious design, and it is not available:
  // obs-studio-node 0.25 deadlocks its IPC thread the moment an
  // AdvancedRecordingFactory output is started alongside the replay buffer. That
  // was confirmed across four configurations (with and without a streaming object,
  // with and without the capture scene bound to output channel 0) — `start()`
  // returns, no signal ever arrives, and every later OBS call fails with
  // "Failed to make IPC call".
  //
  // So recording rides on the replay buffer that already works: the buffer is
  // flushed to a segment on a timer, segments are kept out of the library, and the
  // whole set is joined in one pass when the user stops. See `recording-stitch.ts`
  // for why the join is done that way.
  // -------------------------------------------------------------------------


  /**
   * Wall-clock ms when the current rolling buffer started, or 0 when stopped.
   *
   * The panel's arc claims to show how much of the buffer is filled. That is only
   * meaningful against a real start time; without one the arc had to invent a value,
   * which made it look like a level meter while showing noise.
   */
  bufferStartedAt(): number {
    return this.active ? this.startedAt : 0
  }

  isRecordingContinuously(): boolean {
    return this.recordingActive
  }

  /** Milliseconds since the current continuous recording began, or 0. */
  continuousElapsedMs(): number {
    return this.recordingActive ? Date.now() - this.recordingStartedAt : 0
  }

  /** Seconds each segment covers, and so how often to take one. */
  private segmentSeconds(): number {
    return Math.max(5, Math.floor(this.obsCore.getConfig().bufferDuration * 0.9))
  }

  /**
   * Starts recording. Repeated calls while recording are a no-op, so a double-click
   * cannot reset the clock and lose the first few seconds.
   */
  async startContinuousRecording(): Promise<void> {
    if (!this.obsCore.isInitialized()) throw new Error('OBS not initialized')
    if (!this.active) throw new Error('The buffer is not running, so nothing would be recorded')
    if (this.recordingActive) return

    this.segments = []
    this.recordingActive = true
    this.recordingStartedAt = Date.now()
    this.scratchDir = path.join(os.tmpdir(), 'rewind-recording', `rec-${this.recordingStartedAt}`)
    fs.mkdirSync(this.scratchDir, { recursive: true })

    const window = this.segmentSeconds()
    log.info(`Continuous recording started (${window}s segments)`)
    this.scheduleSegment()
  }

  private scheduleSegment(): void {
    if (!this.recordingActive) return
    this.segmentTimer = setTimeout(() => void this.flushSegment(), this.segmentSeconds() * 1000)
  }

  /** Takes one segment. Serialized so a slow flush cannot overlap the next tick. */
  private async flushSegment(): Promise<void> {
    if (!this.recordingActive) return
    if (this.segmentFlush) {
      this.scheduleSegment()
      return
    }

    this.segmentFlush = (async () => {
      try {
        const file = await this.saveSegmentToScratch()
        this.segments.push({ file, savedAt: Date.now() })
        log.info(`Segment ${this.segments.length} captured (${this.segmentSeconds()}s)`)
      } catch (e) {
        log.warn('Segment capture failed:', e)
      } finally {
        this.segmentFlush = null
        this.scheduleSegment()
      }
    })()

    await this.segmentFlush
  }

  /**
   * Flushes the rolling buffer and moves the result into scratch.
   *
   * OBS resolves the output's folder and filename prefix when the buffer starts, so
   * neither can be redirected afterwards — a segment saved this way always lands in
   * the library. Rather than rebuild the chain on every flush, the folder is
   * diffed around the save and the new file is moved out immediately. Only files
   * this call created are touched, so a clip saved by hand at the same moment is
   * left alone.
   */
  private async saveSegmentToScratch(): Promise<string> {
    if (!this.replayBuffer) throw new Error('Replay buffer is not running')

    const library = this.obsCore.getConfig().outputPath
    const before = new Set(listVideoFiles(library))
    await this.saveReplayBuffer()

    const written = listVideoFiles(library).filter((f) => !before.has(f))
    if (!written.length) throw new Error('The buffer flush did not produce a segment file')

    const newest = written.sort((a, b) => mtimeOf(b) - mtimeOf(a))[0]
    const target = path.join(this.scratchDir, path.basename(newest))
    /*
     * Copy+unlink fallback, mirroring `moveIntoSourceFolder`. A bare rename
     * fails with EXDEV whenever the scratch folder and the library are on
     * different volumes -- which is the normal case, since scratch lives under
     * os.tmpdir() (usually C:) while clips are usually written to a data disk.
     * Without the fallback every segment flush threw, the recording produced no
     * footage at all, and the buffer-written file was stranded in the library
     * looking like a finished clip.
     */
    try {
      fs.renameSync(newest, target)
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'EXDEV') throw e
      log.info('Scratch and library are on different volumes; copying the segment instead of renaming')
      fs.copyFileSync(newest, target)
      fs.unlinkSync(newest)
    }
    return target
  }

  /**
   * Stops recording and returns the finished clip.
   *
   * Always takes a final segment so the last few seconds before the stop are not
   * lost, then joins everything.
   */
  async stopContinuousRecording(): Promise<string> {
    if (!this.recordingActive) throw new Error('Not currently recording')

    if (this.segmentTimer) clearTimeout(this.segmentTimer)
    this.segmentTimer = null
    if (this.segmentFlush) await this.segmentFlush.catch(() => {})

    const stoppedAt = Date.now()
    try {
      await this.flushSegmentNow()
    } catch (e) {
      log.warn('Final segment failed:', e)
    }
    this.recordingActive = false

    if (!this.segments.length) {
      this.cleanupScratch()
      throw new Error('Recording produced no footage — it was stopped too quickly to capture a segment')
    }

    try {
      const config = this.obsCore.getConfig()
      const result = await stitchSegments({
        segments: this.segments,
        startedAt: this.recordingStartedAt,
        stoppedAt,
        windowSeconds: this.segmentSeconds(),
        outputPath: this.nextRecordingPath(),
        scratchDir: this.scratchDir,
      })
      return result.file
    } finally {
      this.cleanupScratch()
    }
  }

  /** One flush without disturbing the timer, used for the final segment. */
  private async flushSegmentNow(): Promise<void> {
    const file = await this.saveSegmentToScratch()
    this.segments.push({ file, savedAt: Date.now() })
  }

  /** Timestamped name that will not collide with a clip saved in the same second. */
  private nextRecordingPath(): string {
    const dir = this.obsCore.getConfig().outputPath
    const d = new Date(this.recordingStartedAt)
    const pad = (n: number) => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`

    let file = path.join(dir, `Recording ${stamp}.mp4`)
    let n = 2
    while (fs.existsSync(file)) file = path.join(dir, `Recording ${stamp} (${n++}).mp4`)
    return file
  }


  private cleanupScratch(): void {
    if (this.segmentTimer) clearTimeout(this.segmentTimer)
    this.segmentTimer = null
    this.segments = []
    if (this.scratchDir) {
      try {
        fs.rmSync(path.dirname(this.scratchDir), { recursive: true, force: true })
      } catch (e) {
        log.warn('Could not remove the recording scratch folder:', e)
      }
      this.scratchDir = ''
    }
  }

  /** Abandons an in-progress recording without producing a file. */
  abortContinuousRecording(): void {
    this.recordingActive = false
    this.cleanupScratch()
  }

   /**
   * Flushes the rolling buffer to disk. Resolves with the saved file path.
   * The OBS `saved`/`wrote` signal is what actually confirms the flush completed.
   */
  async saveReplayBuffer(sourceType: CaptureMode = 'display'): Promise<string> {
    if (!this.obsCore.isInitialized()) throw new Error('OBS not initialized')
    if (!this.active || !this.replayBuffer) throw new Error('Replay buffer is not running')

    const d = deferred<string>(TIMING.SAVE, 'Timeout waiting for replay buffer save')
    this.pendingSave = d
    try {
      this.replayBuffer.save()
    } catch (e) {
      this.pendingSave = null
      throw e instanceof Error ? e : new Error(String(e))
    }
    return d.promise
  }

  /**
 * Handles OBS output signals from the replay buffer, recording and streaming.
 *
 * Signal names come from obs-studio-node's C++ layer, which forwards OBS core's
 * PascalCase signals (`Start`, `Stop`, `Wrote`, `Error`). Matching is
 * case-insensitive so a change in casing upstream doesn't wedge the buffer.
 */
handleSignal(ev: ObsSignal): void {
    const signal = String(ev?.signal ?? '')
    const type = String(ev?.type ?? '')
    const code = ev?.code ?? 0
    const error = ev?.error ?? ''
    const key = signal.toLowerCase()

    if (code && code !== 0) {
      this.lastObsError = { code, signal, error }
      log.error(`OBS Error - Code: ${code}, Signal: ${signal}, Type: ${type}, Error: ${error || 'none'}`)
    }

    // No filtering by `type`: only the replay buffer is ever started in Rewind, so
    // the recording/streaming handlers installed above never fire in practice.
    log.info(`OBS signal: ${signal} (type=${type}, code=${code})`)

    if (key === 'wrote' || key === 'saved' || key === 'file_saved') {
      if (this.pendingSave && !settled(this.pendingSave)) {
        this.pendingSave.resolve(this.getLastReplayPath() ?? '')
        this.pendingSave = null
      }
      return
    }

    if (key === 'starting') return // encoder not live yet; wait for Start

    if (key === 'start') {
      this.active = true
      if (!this.startedAt) this.startedAt = Date.now()
      if (this.pendingStart && !settled(this.pendingStart)) {
        this.pendingStart.resolve()
        this.pendingStart = null
      }
      return
    }

    if (key === 'stop' || key === 'stopping') {
      this.active = false
      this.startedAt = 0
      this.stopResourceSampling()
      if (this.pendingStop && !settled(this.pendingStop)) {
        this.pendingStop.resolve()
        this.pendingStop = null
      }
      // A stop arriving instead of a start means the buffer died on startup.
      if (this.pendingStart && !settled(this.pendingStart)) {
        this.pendingStart.reject(
          new Error(`Replay buffer stopped during startup (Last error: ${this.lastObsError?.error ?? 'none'})`),
        )
        this.pendingStart = null
      }
    }
  }

  /** True when OBS signalled a wedged encoder; used by the wedged-recovery path. */
  noteObsError(): boolean {
    return this.lastObsError !== null
  }

  getLastReplayPath(): string | null {
    try {
      const p = this.replayBuffer?.lastFile?.()
      if (p) return p
    } catch {
      /* fall through to a filesystem scan */
    }
    return this.findLatestReplayFile()
  }

  private findLatestReplayFile(): string | null {
    try {
      const dir = this.obsCore.getConfig().outputPath
      const entries = fs.readdirSync(dir)
        .filter((f) => f.startsWith(REPLAY_PREFIX))
        .map((f) => {
          const full = path.join(dir, f)
          let m = 0
          try {
            m = fs.statSync(full).mtimeMs
          } catch {
            /* skip unreadable */
          }
          return { full, m }
        })
        .sort((a, b) => b.m - a.m)
      return entries[0]?.full ?? null
    } catch {
      return null
    }
  }

    /** Whether the rolling buffer is currently capturing. */
  isReplayBufferActive(): boolean {
    return this.active
  }

  async recover(): Promise<void> {
    if (!this.obsCore.isInitialized()) throw new Error('OBS not initialized')
    if (this.active) {
      log.info('Recover requested but buffer is already active; no-op')
      return
    }
    log.info('Attempting replay buffer recovery...')
    try {
      this.replayBuffer?.stop?.(false)
    } catch {
      /* noop */
    }
    await this.startReplayBuffer(true)
    log.info('Replay buffer recovered successfully')
  }

  async rebuildAndRestart(): Promise<void> {
    if (!this.obsCore.isInitialized()) throw new Error('OBS not initialized')
    // Re-probe before rebuilding. Switching encoder vendor changes which codecs are
    // reachable, and without this the new chain is built from the previous vendor's
    // capabilities — which is why changing the encoder used to need a full restart.
    this.probeAvailableCodecs()
    await this.destroyRunningChain()
    this.createReplayBufferInstances()
    await this.startReplayBuffer(true)
    log.info(
      `Replay buffer restarted with encoder=${this.getActiveEncoder()} ` +
        `vendor=${this.getActiveEncoderVendor()} codecs=${JSON.stringify(this.codecsByVendor)}`,
    )
  }

  async setBufferDuration(seconds: number): Promise<void> {
    if (!this.obsCore.isInitialized()) throw new Error('OBS not initialized')
    await this.stopReplayBuffer(true)
    if (this.replayBuffer) this.replayBuffer.duration = seconds
    await this.startReplayBuffer(true)
    log.info(`Buffer duration updated to ${seconds}s`)
  }

  clearSoftwareFallback(): void {
    this.usingSoftwareEncoder = false
    this.hardwareFailures = 0
  }

  markAbandoned(): void {
    this.abandoned = true
  }

  async dispose(): Promise<void> {
    this.stopResourceSampling()
    if (!this.abandoned) await this.destroyRunningChain()
  }

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

  private startResourceSampling(): void {
    if (this.resourceTimer) return
    this.lastCpu = process.cpuUsage()
    this.lastSampleAt = Date.now()
    this.resourceTimer = setInterval(() => this.sampleResources(), RESOURCE_SAMPLE_INTERVAL_MS)
  }

  private stopResourceSampling(): void {
    if (this.resourceTimer) clearInterval(this.resourceTimer)
    this.resourceTimer = null
    this.lastCpu = null
    this.lastSampleAt = 0
  }

  private sampleResources(): void {
    if (!this.lastCpu || this.lastSampleAt === 0) return
    const now = Date.now()
    const elapsed = now - this.lastSampleAt
    if (elapsed <= 0) return

    const usage = process.cpuUsage(this.lastCpu)
    const cpuPct = ((usage.user + usage.system) / 1000 / elapsed) * 100
    const rssMb = process.memoryUsage.rss() / (1024 * 1024)

    log.info(
      `Resource sample (main proc only): cpu=${cpuPct.toFixed(1)}% rss=${rssMb.toFixed(0)}MB ` +
      `encoder=${this.getActiveEncoder()} bufferDuration=${this.obsCore.getConfig().bufferDuration}s`,
    )

    this.lastCpu = process.cpuUsage()
    this.lastSampleAt = now
  }
}

/** duck-typed so we can check whether a deferred has already been settled. */
function settled(d: { settled?: boolean }): boolean {
  return d.settled === true
}

export { withTimeout }
