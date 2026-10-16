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
export type HotkeyAction = 'save-replay' | 'save-quick-clip' | 'screenshot' | 'toggle-record'

export type EncoderVendor = 'auto' | 'nvenc' | 'amf' | 'qsv' | 'x264'

export type VideoCodec = 'h264' | 'hevc' | 'av1'

export type AudioChannel = 'desktop' | 'microphone'

export type DeviceKind = 'output' | 'input'

/** UI theme: palette + interface font, applied via `data-theme` on the root. */
export type ThemeName = 'graphite' | 'terminal' | 'grotesk'

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
  quickClipHotkey: string

  /**
   * Length the quick-clip hotkey saves, in seconds.
   *
   * Always shorter than or equal to the buffer, which is the only thing that
   * bounds it: the buffer holds `bufferDuration` seconds and older footage is
   * overwritten, so no hotkey can hand back footage the buffer no longer has.
   */
  quickClipSeconds: number
  toggleRecordHotkey: string
  bufferDuration: number
  outputPath: string
  screenshotPath: string
  notificationsEnabled: boolean
  notificationSoundEnabled: boolean
  launchOnStartup: boolean
  /**
   * Start with the window hidden, so a launch lands in the tray.
   *
   * The point of pairing it with `launchOnStartup`: the engine starts capturing at
   * login without a window in the way. The tray icon and a second launch are both
   * ways back in, which is what makes it safe to leave switched on.
   */
  startMinimized: boolean
  /** UI theme: palette + interface font. See `THEMES` in constants. */
  theme: ThemeName
  fps: number
  nvencMultipass: 'disabled' | 'qres'
  nvencPreset: 'p3' | 'p4' | 'p5'
  outputResolution: 'native' | '1080p' | '720p'
  /** Encoder preset: how much detail clips preserve. See CQP/VBR tables in constants. */
  visualQuality: 'low' | 'balanced' | 'quality'
  videoCodec: VideoCodec
  videoEncoder: EncoderVendor
  /** Capture profiles the user defines. Edited in Settings; switched from the deck. */
  profiles: Profile[]
  /** Index into `profiles` of the preset the live settings belong to. */
  activeProfile: number
  /**
   * Threads for the CPU export fallback; 0 = all cores. Only read when no GPU
   * encoder is available, so on most machines this knob does nothing.
   */
  exportThreads: number
  /**
   * The version this app last ran as, written at startup.
   *
   * A mismatch is what tells a launch that it follows an update: the panel shows
   * itself once (even under "Start minimized") and the update popover says so,
   * because a silent relaunch to the tray reads as a failed update.
   */
  lastRunVersion: string
  /** On-disk layout the library has been migrated to. See `STORAGE_LAYOUT_VERSION`. */
  layoutVersion: number
}

/**
 * One capture preset.
 *
 * Only the three settings that change what a clip is: how far back it reaches, how
 * smooth it is, and how good it looks. Paths, devices and hotkeys are not per-profile
 * -- switching a profile must never move where clips are saved.
 */
export interface Profile {
  name: string
  bufferDuration: number
  fps: number
  visualQuality: 'low' | 'balanced' | 'quality'
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

/** What Settings > Storage reports about the library on disk. */
export interface StorageUsage {
  /** Continuous recordings: `Rewind\Recordings`. */
  recordingsBytes: number
  recordingsFiles: number
  /** Replay-buffer clips: the per-source folders, everything in the root that is not
   *  one of the other categories. */
  clipsBytes: number
  clipsFiles: number
  screenshotsBytes: number
  screenshotsFiles: number
  /** Editor exports: `Rewind\Compressed`. */
  compressedBytes: number
  compressedFiles: number
  /** Free and total bytes on the volume holding the clips. 0 when it can't be read. */
  freeBytes: number
  totalBytes: number
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
  /** Source size in bytes; drives the compress savings estimate. */
  fileSize: number
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

/** An editor export job: a range of one clip, re-encoded small. */
export interface ExportRequest {
  clipPath: string
  /** Seconds into the clip where the export starts. */
  startSec: number
  /** Seconds into the clip where the export ends. */
  endSec: number
  /** Two-pass target in MB (audio always kept at 128 kbps inside it). */
  targetMb: number
}

export interface ExportResult {
  path: string
  bytes: number
  width: number
  height: number
  durationSec: number
  /** Audio streams the export kept; always 1. */
  audioStreams: number
}

/** Push events emitted from main -> renderer. */
export interface RewindEvents {
  'obs-status': { status: ObsStatus; message?: string }
  'clip-saved': { clipPath?: string }
  'screenshot-saved': { path: string }
  'auto-detect-switched': undefined
  'hotkey-capture-key': string
  'export-progress': { percent: number }
  'play-notification-sound': undefined
  'auth-session-preloaded': unknown
  /** Update checker state, pushed on every transition. See main/updater.ts. */
  'update-state': {
    supported: boolean
    status: 'idle' | 'checking' | 'available' | 'current' | 'downloading' | 'ready' | 'error' | 'updated'
    version?: string
    updatedFrom?: string
    progress?: number
    error?: string
  }
}

export type RewindEventName = keyof RewindEvents