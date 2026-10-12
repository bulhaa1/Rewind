/**
 * Types shared between the main process and the renderer.
 *
 * Rewind is local-only, so there is no account, sync or telemetry surface to
 * represent here. Every IPC channel returns an `IpcResult` envelope rather than a
 * bare value, so the renderer never has to guess whether a transport-level failure
 * happened or a handler simply returned nothing.
 */

export type CaptureMode = 'display' | 'window' | 'game'

/** Bindable actions the global keyboard hook can trigger. */
export type HotkeyAction = 'save-replay' | 'screenshot' | 'toggle-replay'

export type EncoderVendor = 'auto' | 'nvenc' | 'amf' | 'qsv' | 'x264'

export type VideoCodec = 'h264' | 'hevc' | 'av1'

export type AudioChannel = 'desktop' | 'microphone'

export type DeviceKind = 'output' | 'input'

export type ObsStatus = 'initializing' | 'ready' | 'paused' | 'saving' | 'error'

export type BufferStatus = 'recorded' | 'saved' | 'screenshot' | 'buffer-on' | 'buffer-off' | 'error'

export type DeleteScope = 'both' | 'local' | 'cloud'

export type FolderKind = 'replays' | 'screenshots'

/** Uniform result envelope. Every main-process handler returns this. */
export type IpcResult<T = unknown> = { success: true; data: T } | { success: false; error: string; code?: string }

export interface PersistedSettings {
  captureMode: CaptureMode
  displayIndex: number
  windowId: string | null
  windowName: string | null
  desktopVolume: number
  desktopMuted: boolean
  micVolume: number
  micMuted: boolean
  micGain: number
  desktopDeviceId: string
  micDeviceId: string
  appAudioLevels: Record<string, { volume: number; muted: boolean }>
  deviceChannels: Record<string, { label: string; kind: DeviceKind; volume: number; muted: boolean }>
  saveReplayHotkey: string
  screenshotHotkey: string
  toggleReplayHotkey: string
  bufferDuration: number
  outputPath: string
  screenshotPath: string
  notificationsEnabled: boolean
  notificationSoundEnabled: boolean
  launchOnStartup: boolean
  fps: number
  nvencMultipass: 'disabled' | 'qres'
  nvencPreset: 'p3' | 'p4' | 'p5'
  outputResolution: 'native' | '1080p' | '720p'
  visualQuality: 'low' | 'standard' | 'high' | 'highest'
  /**
   * Where the settings screen warns about replay-buffer RAM, in MB.
   *
   * A setting rather than a constant because the right threshold depends on the
   * machine, and 512 MB is only a guess about someone else's.
   */
  memoryWarnMb: number
  /**
   * Achieved video bitrate in kbps, per quality tier, most recent last.
   *
   * This exists because `VBR_KBPS_BY_QUALITY` does not describe a hardware
   * encoder. Every GPU path here runs CQP/ICQ, where the bitrate is a *result*
   * of the content rather than a target; clips measured at 'high' come out near
   * 1700 kbps against the table's 12000, and anywhere between 300 and 28000
   * depending on what was on screen. The readout takes the median of the last
   * few, which is why this holds samples rather than a single running figure.
   */
  observedVideoKbpsByQuality: Record<'low' | 'standard' | 'high' | 'highest', number[]>
  videoCodec: VideoCodec
  videoEncoder: EncoderVendor
}

export interface MonitorInfo {
  id: string
  name: string
  width: number
  height: number
  isPrimary: boolean
}

export interface WindowInfo {
  id: string
  name: string
  inactive?: boolean
}

export interface AudioLevel {
  volume: number
  muted: boolean
}


export interface AudioDevice {
  id: string
  label: string
  kind: DeviceKind
  available: boolean
  added: boolean
  isSystemDefault: boolean
  coveredBy?: AudioChannel
  volume: number
  muted: boolean
  track?: number
  error?: string
}

export interface AudioApp {
  exe: string
  displayName: string
  running: boolean
  capturable: boolean
  volume: number
  muted: boolean
}

export interface ClipInfo {
  id: string
  path: string
  filename: string
  recordedAt: number
  edited?: boolean
  editedAt?: number
  duration: number
  fileSize: number
  sourceName?: string | null
  localExists: boolean
  audioTracks: string[]
}

export interface ScreenshotInfo {
  id: string
  path: string
  name: string
  size: number
  capturedAt: number
  source?: string | null
  localExists: boolean
}

export interface ClipAudioTrack {
  stream: number
  label: string
  previewPath: string | null
}

export interface ClipEditorInfo {
  duration: number
  previewPath: string
  audioTracks: ClipAudioTrack[]
}

export interface SaveClipArgs {
  clipPath: string
  startSec: number
  endSec: number
  mode: 'overwrite' | 'copy'
  trackVolumes?: { stream: number; volume: number }[]
}

export interface SaveClipResult {
  outputPath: string
}

export interface CaptureState {
  mode: CaptureMode
  displays: MonitorInfo[]
  currentMonitor: number
  windows: WindowInfo[]
  currentWindowId: string | null
  currentWindowName: string | null
  audioLevels: { desktop: AudioLevel; microphone: AudioLevel }
}

export interface EncoderVendorInfo {
  vendor: EncoderVendor
  label: string
  isHardware: boolean
  codecs: VideoCodec[]
}

export interface CaptureSourceState {
  name: string
  inactive: boolean
}

/** Push events emitted from main -> renderer. */
export interface RewindEvents {
  'obs-status': { status: ObsStatus; message?: string }
  'clip-saved': { clipPath?: string }
  'screenshot-saved': { path: string }
  'auto-detect-switched': undefined
  'hotkey-capture-key': string
  'play-notification-sound': undefined
  'auth-session-preloaded': unknown
  /** Update checker state, pushed on every transition. See main/updater.ts. */
  'update-state': {
    supported: boolean
    status: 'idle' | 'checking' | 'available' | 'current' | 'downloading' | 'ready' | 'error'
    version?: string
    progress?: number
    error?: string
  }
}

export type RewindEventName = keyof RewindEvents

/**
 * What the replay buffer is expected to cost, and how much that number can be
 * trusted.
 *
 * `source` is not decoration. A GPU encoder runs CQP, so its bitrate is a
 * property of the content being recorded and no static table can predict it;
 * until this machine has recorded a clip at the current quality, `source` is
 * `'table'` and `videoKbps` is an x264 target that will not hold. The UI shows
 * this so a precise-looking number is not mistaken for a measured one.
 */
export interface BufferMemoryEstimate {
  estimatedMb: number
  videoKbps: number
  audioKbps: number
  durationSeconds: number
  source: 'measured' | 'table'
  warnMb: number
  exceeds: boolean
}