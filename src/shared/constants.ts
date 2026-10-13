/**
 * Capture constants and lookup tables.
 *
 * Encoder tables, timing constants and the audio topology are the numbers the
 * pipeline is actually specified by, so they live in one reviewable place instead
 * of being scattered through the encoder and buffer code. Changing a value here is
 * a deliberate change to how Rewind behaves, not a refactor.
 */
import type { CaptureMode, EncoderVendor, VideoCodec } from './types.js'/** OBS source names. These three exist purely to satisfy the 0.25 replay-buffer API. */
export const OBS_SOURCE_NAMES = {
  replayEncoder: 'rewind-replay-encoder',
  recordingPlaceholder: 'rewind-recording-placeholder',
  recordingOutputEncoder: 'rewind-recording-output-encoder',
  recordingService: 'rewind-recording-service',
  streamingService: 'rewind-stream-service',
} as const

/**
 * Lengths the quick-clip hotkey can save, in seconds.
 *
 * Capped at 90 seconds: the hotkey exists to grab the last moment, and the buffer is
 * the only bound on it, so a longer window mostly means waiting on footage nobody
 * wanted. All of them are shorter than the longest buffer, so any is reachable from
 * any buffer setting; a request at or beyond the buffer length saves the whole
 * buffer rather than failing.
 */
export const QUICK_CLIP_OPTIONS = [
  { value: 10, label: '10 seconds' },
  { value: 15, label: '15 seconds' },
  { value: 30, label: '30 seconds' },
  { value: 45, label: '45 seconds' },
  { value: 60, label: '60 seconds' },
  { value: 90, label: '90 seconds' },
]
export const QUICK_CLIP_MIN = 5
export const QUICK_CLIP_MAX = 90
export const QUICK_CLIP_DEFAULT = 30

/**
 * A stored length can predate the cap, and IPC is not the only way a value gets in,
 * so reads clamp rather than trust the file: nothing above QUICK_CLIP_MAX is acted on.
 */
export const clampQuickClip = (seconds: number) =>
  Math.min(Math.max(Math.round(seconds), QUICK_CLIP_MIN), QUICK_CLIP_MAX)

export const DEFAULT_SETTINGS = {
  captureMode: 'game' as CaptureMode,
  displayIndex: 0,
  windowId: null,
  windowName: null,
  desktopVolume: 1,
  desktopMuted: false,
  micVolume: 1,
  micMuted: false,
  // Unity gain, so a fresh install records exactly what the pre-gain build recorded.
  micGain: 1,
  quickClipSeconds: QUICK_CLIP_DEFAULT,
  desktopDeviceId: 'default',
  micDeviceId: 'default',
  appAudioLevels: {},
  deviceChannels: {},
  saveReplayHotkey: 'Alt+1',
  screenshotHotkey: 'Alt+2',
  quickClipHotkey: 'Ctrl+Alt+1',
  toggleRecordHotkey: 'Alt+3',
  bufferDuration: 60,
  outputPath: '',
  screenshotPath: '',
  notificationsEnabled: true,
  // Off by default. The chime fires on every saved clip and screenshot, which while
  // recording is constant interruption rather than feedback. The setting stays so it
  // can be switched back on under Settings > Notifications.
  notificationSoundEnabled: false,
  launchOnStartup: false,
  // Off by default: a launch that shows nothing is indistinguishable from a launch
  // that failed, so it is only worth switching on once there is a tray habit.
  startMinimized: false,
  fps: 30,
  nvencMultipass: 'disabled',
  nvencPreset: 'p4',
  outputResolution: 'native',
  visualQuality: 'high',
  videoCodec: 'h264' as VideoCodec,
  videoEncoder: 'auto' as EncoderVendor,
} satisfies Omit<import('./types.js').PersistedSettings, never> as import('./types.js').PersistedSettings

/** Screenshots default to `<outputPath>/Screenshots`. */
export const SCREENSHOT_SUBDIR = 'Screenshots'

/** OBS recording filename template (same as the original). */
export const OBS_FILE_FORMAT = '%CCYY-%MM-%DD %hh-%mm-%ss'
export const REPLAY_PREFIX = 'Replay'

/** Prefix for continuous recordings, which are written by a different path than replays. */
export const RECORDING_PREFIX = 'Recording'

/**
 * The app's own folder inside whatever location the user picked.
 *
 * Choosing `D:\Captures` stores `D:\Captures`, and clips land under
 * `D:\Captures\Rewind\<game>`. The app owns that level so a chosen location
 * is never filled with its output directly.
 */
export const APP_FOLDER = 'Rewind'

/**
 * Folders used when the capture source is not a detected game.
 *
 * Named for the mode rather than the moment: a display-capture clip is still a
 * display-capture clip tomorrow, and a folder named after the monitor it
 * happened to be on reads like a bug the moment there are two monitors.
 */
export const DISPLAY_CAPTURE_FOLDER = 'Display Capture'
export const GAME_CAPTURE_FOLDER = 'Game Capture'

/** Pre-1.1.0 folder for clips saved while the detector had not locked a game. */
export const LEGACY_AUTO_GAME_FOLDER = 'Auto Game Capture'

// ---------------------------------------------------------------------------
// Encoder selection
// ---------------------------------------------------------------------------

/** Vendor preference order. First vendor with >=1 available codec becomes the default. */
export const VENDOR_PREFERENCE: Exclude<EncoderVendor, 'auto'>[] = ['nvenc', 'amf', 'qsv', 'x264']
/** OBS video encoder ids per (vendor, codec). */
export const ENCODER_TABLE: Record<
  Exclude<EncoderVendor, 'auto'>,
  Partial<Record<VideoCodec, string>>
> = {
  nvenc: { h264: 'obs_nvenc_h264_tex', hevc: 'obs_nvenc_hevc_tex', av1: 'obs_nvenc_av1_tex' },
  amf: { h264: 'h264_texture_amf', hevc: 'h265_texture_amf', av1: 'av1_texture_amf' },
  qsv: { h264: 'obs_qsv11_v2', hevc: 'obs_qsv11_hevc', av1: 'obs_qsv11_av1' },
  x264: { h264: 'obs_x264' },
}

/** QSV fallback id when obs_qsv11_v2 is absent. */
export const QSV_H264_LEGACY = 'obs_qsv11'

export const X264_ENCODER = 'obs_x264'

export type VisualQuality = 'low' | 'standard' | 'high' | 'highest'

/** Constant-QP targets for hardware encoders. */
export const CQP_BY_QUALITY: Record<VisualQuality, number> = {
  low: 28,
  standard: 23,
  high: 20,
  highest: 16,
}

/** VBR bitrate targets (kbps) for x264. */
export const VBR_KBPS_BY_QUALITY: Record<VisualQuality, number> = {
  low: 4000,
  standard: 8000,
  high: 12000,
  highest: 20000,
}

/** Keyframe interval, in seconds. */
export const KEYINT_SEC = 2

/**
 * The rolling-window range the engine accepts, in seconds.
 *
 * OBS has no byte ceiling on this output (see replay-buffer.ts), so the upper
 * bound is the only thing standing between a user and an unbounded RAM
 * allocation -- it is a deliberate limit, not an arbitrary one. Shared so the
 * main-process validator and the panel's custom-limit field cannot disagree.
 */
export const BUFFER_DURATION_MIN = 5
export const BUFFER_DURATION_MAX = 600

/** AMF target usage for ICQ-style QSV. */
export const QSV_TARGET_USAGE = 4

export const X264_PRESET = 'veryfast'

// ---------------------------------------------------------------------------
// Audio topology
// ---------------------------------------------------------------------------

/** OBS input slots (EInputSlot). */
export const SLOT = {
  SCENE: 0,
  DESKTOP: 1,
  MICROPHONE: 2,
  APP_BASE: 3,
  APP_MAX: 16,
  DEVICE_BASE: 20,
  DEVICE_MAX: 8,
} as const

/** OBS audio track indices (tracks are 1-based). */
export const TRACK = {
  MIX: 1,
  DESKTOP: 2,
  MIC: 3,
  DEVICE_BASE: 4,
  MAX: 6,
} as const

/**
 * Microphone input gain bounds, in linear multipliers.
 *
 * The ceiling is Rewind's, not OBS's. An OBS fader cannot amplify at all — it clamps at
 * 0 dB — so the boost runs through the built-in gain filter instead, which has no such
 * limit. The bound is kept low deliberately: past 2x (~+6 dB) a boost stops being level
 * matching and starts being the thing that clips, and clipping a voice is worse than a
 * quiet one.
 */
export const MIC_GAIN = { MIN: 0, MAX: 2, STEP: 0.05, DEFAULT: 1 } as const

/** Bitrate for every created audio track, in kbps. */
export const AUDIO_TRACK_KBPS = 160

export const AUDIO_TRACK_COUNT = 6

// ---------------------------------------------------------------------------
// Timing constants
// ---------------------------------------------------------------------------

export const TIMING = {
  /** Graceful shutdown sequence delays (ms). */
  SHUTDOWN_STOP_DELAY: 500,
  SHUTDOWN_POST_DISCONNECT: 300,
  SHUTDOWN_FINAL_CLEANUP: 1000,

  /** Replay buffer start/stop/save timeouts (ms). */
  START_FIRST_ATTEMPT: 3000,
  START_RETRY: 5000,
  RETRY_STOP_FALLBACK: 1000,
  STOP_SIGNAL: 5000,
  SAVE: 10000,
  /** Give up on a hardware encoder after this many failures and use x264. */
  HARDWARE_FAILURE_CAP: 2,

  /** Overall shutdown budget (ms). */
  SHUTDOWN: 8000,
  /**
   * Shutdown budget while a continuous recording is running (ms).
   *
   * The recording is stitched on the way out -- one ffmpeg remux plus one probe
   * per segment -- and a long recording is many segments, so the plain budget
   * fired mid-stitch and left the file unregistered.
   *
   * shortcut: 3 minutes covers roughly 2.5 hours of recording at the default 60s
   * buffer (~54s segments, ~1s each); a longer recording can still time out.
   * Upgrade to a segment-count-based budget if anyone records longer.
   */
  SHUTDOWN_RECORDING: 180_000,
  OBS_RESPAWN_SETTLE: 1500,
  CLIP_SAVED_BROADCAST: 500,
  SCREENSHOT: 15000,

  /** Game hook produced no frame within this window -> fall back to display. */
  GAME_HOOK_TIMEOUT: 5000,
} as const

export const GAME_DETECTOR = {
  /** Foreground window poll interval (ms). */
  POLL_INTERVAL: 3000,
  /** Consecutive qualifying polls required before switching. */
  CANDIDATE_THRESHOLD: 2,
  /** PID liveness re-check interval (ms). */
  LIVENESS_INTERVAL: 5000,
  /** content/monitor ratio >= this on both axes counts as fullscreen. */
  FULLSCREEN_RATIO: 0.9,
} as const

/**
 * How long an engine teardown may take, in ms.
 *
 * A recording in flight is stitched on the way out, so it gets the long budget;
 * everything else keeps the plain one.
 */
export const shutdownBudgetMs = (recording: boolean): number =>
  recording ? TIMING.SHUTDOWN_RECORDING : TIMING.SHUTDOWN
/** OBS monitor order reconciliation: silence a log line no more often than this. */
export const MONITOR_LOG_INTERVAL_MS = 60_000

/** CPU/RSS sampling for the diagnostics log line (ms). */
export const RESOURCE_SAMPLE_INTERVAL_MS = 5 * 60 * 1000

/** Audio session enumeration poll interval (ms). */
export const AUDIO_SESSION_POLL_MS = 2000

/** Audio app-source watcher interval (ms). */
export const APP_AUDIO_WATCH_MS = 2000

/** WASAPI device list cache TTL (ms). */
export const DEVICE_LIST_TTL_MS = 5000

/** App-window probe staleness (ms). */
export const APP_PROBE_TTL_MS = 5000

/** Thumbnail widths (px). */
export const THUMBNAIL = {
  /** Clip grid thumbnails. */
  GRID: 192,
  /** Share/editor previews. */
  FULL: 1280,
  /** Seek offset (s) for the first frame grab attempt. */
  SEEK: 1,
  JPEG_QUALITY: 4,
} as const

/** Screenshot PNG dimensions are taken from the source; ddagrab writes one frame. */
export const SCREENSHOT_FILENAME_ATTEMPTS = 100

// ---------------------------------------------------------------------------
// UI option tables (verbatim from settings-page)
// ---------------------------------------------------------------------------

export const OUTPUT_RESOLUTION_OPTIONS = [
  { value: 'native', label: 'Native' },
  { value: '1080p', label: '1080p' },
  { value: '720p', label: '720p' },
]

export const FPS_OPTIONS = [
  { value: 30, label: '30 fps' },
  { value: 60, label: '60 fps' },
  { value: 120, label: '120 fps' },
]

/** Frame rates the app will accept. Enforced by both the picker and the IPC handler. */
export const ALLOWED_FPS = [30, 60, 120] as const

export const MULTIPASS_OPTIONS = [
  { value: 'disabled', label: 'Off (lower load)' },
  { value: 'qres', label: 'On (higher quality)' },
]

export const NVENC_PRESET_OPTIONS = [
  { value: 'p3', label: 'Faster (P3)' },
  { value: 'p4', label: 'Performance (P4)' },
  { value: 'p5', label: 'Quality (P5)' },
]

export const VISUAL_QUALITY_OPTIONS = [
  { value: 'low', label: 'Low (smallest files)' },
  { value: 'standard', label: 'Standard' },
  { value: 'high', label: 'High (default)' },
  { value: 'highest', label: 'Highest (archival)' },
]

export const CODEC_OPTIONS = [
  { value: 'h264', label: 'H.264 (most compatible)' },
  { value: 'hevc', label: 'HEVC (smaller files)' },
  { value: 'av1', label: 'AV1 (smallest files)' },
]

export const ENCODER_AUTO_LABEL = 'Auto (recommended)'

/** Screenshot / clip filename builders. */
export function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** Renders a hotkey accelerator the way the original does. */
export function formatHotkey(accelerator: string): string {
  if (!accelerator) return 'Unbound'
  return accelerator
    .replace('CommandOrControl', 'Ctrl')
    .replace('Command', 'Cmd')
    .replace('Control', 'Ctrl')
    .replace('Super', 'Win')
    .replace(/\bKey(\d+)\b/, 'Key $1')
    .replace(/\+/g, ' + ')
}

/**
 * A notification title naming an outcome and the key bound to it:
 * `Clip saved — Alt + 1`.
 *
 * The caller reads the binding at notify time rather than capturing it, so a
 * rebind changes the next popup with no extra work.
 */
export function titleWithHotkey(outcome: string, accelerator: string): string {
  return accelerator ? `${outcome} — ${formatHotkey(accelerator)}` : outcome
}

export function screenshotFileName(d: Date = new Date()): string {
  return (
    `Screenshot ${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}`
  )
}

/** Extract a recording timestamp from `Replay YYYY-MM-DD HH-mm-ss.mp4`. */
export function parseRecordingStamp(fileName: string): number | null {
  const m = /(\d{4})-(\d{2})-(\d{2})[ _](\d{2})-(\d{2})-(\d{2})/.exec(fileName)
  if (!m) return null
  const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime()
  return Number.isNaN(t) ? null : t
}