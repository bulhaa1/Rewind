import type {
  AudioApp,
  AudioChannel,
  AudioDevice,
  AudioLevel,
  CaptureMode,
  CaptureSourceState,
  ClipEditorInfo,
  ClipInfo,
  DeleteScope,
  EncoderVendorInfo,
  FolderKind,
  HotkeyAction,
  IpcResult,
  MonitorInfo,
  ObsStatus,
  SaveClipArgs,
  ScreenshotInfo,
  WindowInfo,
} from '@shared/types.js'

/** Unwraps a result envelope, throwing on failure so callers can use try/catch. */
export async function unwrap<T>(p: Promise<IpcResult<T>>): Promise<T> {
  const res = await p
  if (!res.success) throw new IpcError(res.error, res.code)
  return res.data as T
}

/** An IPC call that failed. Carries the main-process error code when present. */
export class IpcError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'IpcError'
  }
}

/**
 * Typed view of the preload bridge.
 *
 * Declaring the surface here rather than importing the untyped bridge means a
 * renamed or removed IPC method becomes a compile error in the renderer instead of
 * a runtime `undefined is not a function`.
 */
/** Update checker state. Mirrors main/updater.ts and the 'update-state' event. */
export interface UpdateState {
  supported: boolean
  status: 'idle' | 'checking' | 'available' | 'current' | 'downloading' | 'ready' | 'error'
  version?: string
  progress?: number
  error?: string
}

export interface RewindApi {
  // Replay
  saveReplay(): Promise<IpcResult<string>>
  takeScreenshot(): Promise<IpcResult<string>>
  // Updates. Each is only ever called from the header button; none runs on a
  // timer, so the app makes no network call unless the user asks for one.
  getUpdateState(): Promise<IpcResult<UpdateState>>
  checkForUpdates(): Promise<IpcResult<UpdateState>>
  downloadUpdate(): Promise<IpcResult<UpdateState>>
  quitAndInstall(): Promise<IpcResult<void>>
  toggleReplayBuffer(): Promise<IpcResult<{ active: boolean }>>
  getStatus(): Promise<IpcResult<{ status: ObsStatus; message?: string }>>
  getConfig(): Promise<IpcResult<{ bufferDuration: number; fps: number; outputPath: string; fpsActual?: number }>>

  // Continuous recording
  startRecording(): Promise<IpcResult<{ started?: boolean; alreadyRecording?: boolean }>>
  stopRecording(): Promise<IpcResult<{ outputPath: string }>>
  getRecordingState(): Promise<IpcResult<{ recording: boolean; elapsedMs: number }>>
  getBufferDuration(): Promise<IpcResult<number>>
  setReplayBufferActive(active: boolean): Promise<IpcResult<{ active: boolean; changed: boolean }>>
  isReplayBufferActive(): Promise<IpcResult<{ active: boolean; startedAt: number }>>
  setBufferDuration(seconds: number): Promise<IpcResult>
  recoverReplayBuffer(): Promise<IpcResult>
  reinitOBS(): Promise<IpcResult>
  retryOBSInit(): Promise<IpcResult<{ success?: boolean; alreadyReady?: boolean }>>

  // Capture
  getDisplays(): Promise<IpcResult<MonitorInfo[]>>
  getWindows(): Promise<IpcResult<WindowInfo[]>>
  setDisplay(index: number): Promise<IpcResult>
  setWindow(windowId: string): Promise<IpcResult>
  setGameCapture(): Promise<IpcResult>
  getCurrentMonitor(): Promise<IpcResult<number>>
  getCurrentWindow(): Promise<IpcResult<string | null>>
  getCurrentWindowName(): Promise<IpcResult<string | null>>
  getCaptureMode(): Promise<IpcResult<CaptureMode>>
  getCurrentSourceName(): Promise<IpcResult<CaptureSourceState>>

  // Paths
  openFolder(target?: string): Promise<IpcResult>
  openFile(file: string): Promise<IpcResult>
  showClipInFolder(file: string): Promise<IpcResult>
  getOutputPath(): Promise<IpcResult<string>>
  setOutputPath(p: string): Promise<IpcResult<string>>
  getScreenshotPath(): Promise<IpcResult<string>>
  setScreenshotPath(p: string): Promise<IpcResult<string>>
  openScreenshotFolder(): Promise<IpcResult>
  selectFolder(kind: FolderKind): Promise<IpcResult<{ canceled: boolean; path: string | null }>>

  // Clips
  getSavedClips(): Promise<IpcResult<ClipInfo[]>>
  getClipThumbnail(file: string): Promise<IpcResult<string | null>>
  deleteClip(file: string, scope: DeleteScope): Promise<IpcResult>
  renameClip(file: string, name: string): Promise<IpcResult<string>>
  getAppVersion(): Promise<IpcResult<string>>

  // Screenshots
  getScreenshots(): Promise<IpcResult<ScreenshotInfo[]>>
  getScreenshotThumbnail(file: string): Promise<IpcResult<string | null>>
  openScreenshot(file: string): Promise<IpcResult>
  showScreenshotInFolder(file: string): Promise<IpcResult>
  deleteScreenshot(file: string): Promise<IpcResult>

  // Audio
  getAudioLevels(): Promise<IpcResult<{ desktop: AudioLevel; microphone: AudioLevel }>>
  setChannelVolume(channel: AudioChannel, volume: number): Promise<IpcResult>
  setChannelMuted(channel: AudioChannel, muted: boolean): Promise<IpcResult>
  getAudioSessions(): Promise<IpcResult<AudioApp[]>>
  setAppVolume(exe: string, volume: number): Promise<IpcResult>
  setAppMuted(exe: string, muted: boolean): Promise<IpcResult>
  resetAppMix(): Promise<IpcResult>
  getAudioDevices(): Promise<IpcResult<AudioDevice[]>>
  getChannelDevices(): Promise<IpcResult<Record<AudioChannel, string>>>
  setChannelDevice(channel: AudioChannel, deviceId: string): Promise<IpcResult>
  addAudioDeviceChannel(deviceId: string): Promise<IpcResult>
  removeAudioDeviceChannel(deviceId: string): Promise<IpcResult>
  setDeviceVolume(deviceId: string, volume: number): Promise<IpcResult>
  setDeviceMuted(deviceId: string, muted: boolean): Promise<IpcResult>
  getSeparateAudioTracks(): Promise<IpcResult<boolean>>
  setSeparateAudioTracks(value: boolean): Promise<IpcResult>
  getPerDeviceAudioTracks(): Promise<IpcResult<boolean>>
  setPerDeviceAudioTracks(value: boolean): Promise<IpcResult>

  // Hotkeys
  getHotkeys(): Promise<IpcResult<Partial<Record<HotkeyAction, string>>>>
  setHotkey(action: string, accelerator: string): Promise<IpcResult>
  startHotkeyCapture(): Promise<IpcResult>
  stopHotkeyCapture(): Promise<IpcResult>

  // Encoder
  getFps(): Promise<IpcResult<number>>
  setFps(value: number): Promise<IpcResult>
  getNvencMultipass(): Promise<IpcResult<string>>
  setNvencMultipass(value: string): Promise<IpcResult>
  getNvencPreset(): Promise<IpcResult<string>>
  setNvencPreset(value: string): Promise<IpcResult>
  getOutputResolution(): Promise<IpcResult<string>>
  setOutputResolution(value: string): Promise<IpcResult>
  getVisualQuality(): Promise<IpcResult<string>>
  setVisualQuality(value: string): Promise<IpcResult>
  getVideoCodec(): Promise<IpcResult<string>>
  setVideoCodec(value: string): Promise<IpcResult>
  getAvailableCodecs(): Promise<IpcResult<string[]>>
  getVideoEncoder(): Promise<IpcResult<string>>
  setVideoEncoder(value: string): Promise<IpcResult>
  getAvailableEncoderVendors(): Promise<IpcResult<EncoderVendorInfo[]>>
  getActiveEncoderVendor(): Promise<IpcResult<string>>

  // Toggles
  getNotificationsEnabled(): Promise<IpcResult<boolean>>
  setNotificationsEnabled(value: boolean): Promise<IpcResult>
  getNotificationSoundEnabled(): Promise<IpcResult<boolean>>
  setNotificationSoundEnabled(value: boolean): Promise<IpcResult>
  getLaunchOnStartup(): Promise<IpcResult<boolean>>
  setLaunchOnStartup(value: boolean): Promise<IpcResult>

  notificationClick(): Promise<IpcResult>

  // Editor
  openClipEditor(file: string): Promise<IpcResult>
  editorGetClipInfo(file: string): Promise<IpcResult<ClipEditorInfo>>
  editorGetTrackPeaks(file: string, stream: number): Promise<IpcResult<number[]>>
  editorSaveClip(args: SaveClipArgs): Promise<IpcResult<{ outputPath: string }>>
  editorCancel(): Promise<IpcResult>

  on(event: 'obs-status', handler: (s: { status: ObsStatus; message?: string }) => void): () => void
  on(event: 'clip-saved', handler: (p?: { clipPath?: string }) => void): () => void
  on(event: 'screenshot-saved', handler: (p: { path: string }) => void): () => void
  on(event: 'auto-detect-switched', handler: () => void): () => void
  on(event: 'update-state', handler: (s: UpdateState) => void): () => void
  on(event: 'hotkey-capture-key', handler: (hotkey: string) => void): () => void
  on(event: 'play-notification-sound', handler: () => void): () => void
}

const bridge = (window as unknown as { electronAPI?: RewindApi }).electronAPI

if (!bridge) {
  throw new Error('Rewind preload bridge is missing; the renderer was loaded without its preload script')
}

export const api: RewindApi = bridge
/** Human-readable message for any thrown value. */
export function messageOf(e: unknown, fallback = 'Something went wrong'): string {
  if (e instanceof IpcError) return e.message
  if (e instanceof Error) return e.message
  if (typeof e === 'string' && e) return e
  return fallback
}

/**
 * Reads an IPC call for a non-critical value, falling back when it fails.
 *
 * Used for display-only settings where a failed read should render a placeholder
 * rather than blow up the page. Anything the user acts on must use `unwrap`.
 */
export async function read<T>(call: Promise<IpcResult<T>>, fallback: T): Promise<T> {
  const res = await call
  return res.success ? (res.data as T) : fallback
}

/** Formats bytes for display, matching the original's lowercase unit style. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)}gb`
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)}mb`
  return `${Math.max(1, Math.round(bytes / 1024))}kb`
}

/** `m:ss` / `h:mm:ss` duration label. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

/**
 * Clip timestamp for the library list.
 *
 * Today is shown as a time rather than a date: a clip saved this morning reads
 * "14:47" and one from last Tuesday reads the date, which is the distinction
 * people actually scan for in a list of recent recordings.
 */
export function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const d = new Date(ms)
  const today = new Date()
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()

  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Buffer length label: `45s`, `2m`, `1m30s`. */
export function formatBuffer(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return s === 0 ? `${m}m` : `${m}m${s}s`
}
/**
 * Normalizes a capture-source label for display.
 * Strips the `[exe.exe]: ` prefix and `(process: exe)` suffix that OBS window
 * names carry, so the UI shows something a person recognizes.
 */
export function formatSourceName(raw: string | null | undefined): string {
  const source = (raw ?? '').trim() || 'Unknown Source'
  let s = source.replace(/^\[[^\]]+\]\s*:?\s*/, '').trim()
  const proc = s.match(/\(process[:\s]+([^)]+)\)/i)
  if (proc) s = proc[1].replace(/\.exe$/i, '').trim()
  return s
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
