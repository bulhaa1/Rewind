/**
 * React Query cache configuration and typed query definitions.
 *
 * One QueryClient per window. `retry: false` matters here: every IPC call is a
 * local operation with a definitive answer, so retrying a failure just delays the
 * error message the user needs to see.
 */
import { QueryClient } from '@tanstack/react-query'
import { api, IpcError } from './api'
import type { CaptureState, IpcResult } from '@shared/types.js'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
      staleTime: 3_000,
    },
  },
})

/** Cache keys. Namespaced so unrelated invalidations can't collide. */
export const QK = {
  clips: ['clips'] as const,
  screenshots: ['screenshots'] as const,
  config: ['config'] as const,
  hotkeys: ['hotkeys'] as const,
  captureState: ['capture-state'] as const,
  encoderState: ['encoder-state'] as const,
  appVersion: ['app-version'] as const,
  setting: (key: string) => ['setting', key] as const,
}

/** A single setting bound to its get/set IPC pair. */
export interface SettingBinding<T> {
  queryKey: readonly unknown[]
  get: () => Promise<any>
  set: (value: T) => Promise<any>
}

/**
 * Declares every persisted setting's accessor pair.
 *
 * Keeping them in one table means the settings page never needs to know the IPC
 * channel names, and adding a setting is a single entry here.
 */
function defineSettings<T extends Record<string, SettingBinding<any>>>(defs: T): T {
  return defs
}

export const SETTINGS = defineSettings({
  bufferDuration: { queryKey: QK.setting('bufferDuration'), get: api.getBufferDuration, set: api.setBufferDuration },
  outputPath: { queryKey: QK.setting('outputPath'), get: api.getOutputPath, set: api.setOutputPath },
  screenshotPath: { queryKey: QK.setting('screenshotPath'), get: api.getScreenshotPath, set: api.setScreenshotPath },
  outputResolution: { queryKey: QK.setting('outputResolution'), get: api.getOutputResolution, set: api.setOutputResolution },
  visualQuality: { queryKey: QK.setting('visualQuality'), get: api.getVisualQuality, set: api.setVisualQuality },
  fps: { queryKey: QK.setting('fps'), get: api.getFps, set: api.setFps },
  nvencMultipass: { queryKey: QK.setting('nvencMultipass'), get: api.getNvencMultipass, set: api.setNvencMultipass },
  nvencPreset: { queryKey: QK.setting('nvencPreset'), get: api.getNvencPreset, set: api.setNvencPreset },
  videoCodec: { queryKey: QK.setting('videoCodec'), get: api.getVideoCodec, set: api.setVideoCodec },
  videoEncoder: { queryKey: QK.setting('videoEncoder'), get: api.getVideoEncoder, set: api.setVideoEncoder },
  notificationsEnabled: {
    queryKey: QK.setting('notificationsEnabled'),
    get: api.getNotificationsEnabled,
    set: api.setNotificationsEnabled,
  },
  notificationSoundEnabled: {
    queryKey: QK.setting('notificationSoundEnabled'),
    get: api.getNotificationSoundEnabled,
    set: api.setNotificationSoundEnabled,
  },
  launchOnStartup: { queryKey: QK.setting('launchOnStartup'), get: api.getLaunchOnStartup, set: api.setLaunchOnStartup },
  micGain: { queryKey: QK.setting('micGain'), get: api.getMicGain, set: api.setMicGain },
  quickClipSeconds: {
    queryKey: QK.setting('quickClipSeconds'),
    get: api.getQuickClipSeconds,
    set: api.setQuickClipSeconds,
  },
})

// ---------------------------------------------------------------------------
// Query factories
// ---------------------------------------------------------------------------

export const captureStateQuery = {
  queryKey: QK.captureState,
  queryFn: async (): Promise<CaptureState> => {
    const [mode, displays, currentMonitor, windows, currentWindowId, currentWindowName, audioLevels] =
      await Promise.all([
        once(api.getCaptureMode),
        once(api.getDisplays),
        once(api.getCurrentMonitor),
        once(api.getWindows),
        once(api.getCurrentWindow),
        once(api.getCurrentWindowName),
        once(api.getAudioLevels),
      ])
    return { mode, displays, currentMonitor, windows, currentWindowId, currentWindowName, audioLevels }
  },
}

/** Deduplicates the window list; OBS can report the same handle twice. */
export function dedupeWindows<T extends { id: string }>(list: T[]): T[] {
  return list.filter((w, i) => list.findIndex((x) => x.id === w.id) === i)
}

/**
 * Unwraps a single IPC call for use as a query function.
 *
 * A failed envelope throws, which React Query surfaces as an error state — the
 * alternative (returning a fallback) would render a stale-looking empty panel and
 * hide a real failure.
 */
async function once<T>(call: () => Promise<IpcResult<T>>): Promise<T> {
  const res = await call()
  if (!res.success) throw new IpcError(res.error, res.code)
  return res.data as T
}

export const sourceNameQuery = {
  queryKey: ['source-name'] as const,
  queryFn: () => once(api.getCurrentSourceName),
  refetchInterval: 5_000,
  refetchOnWindowFocus: true,
}

/**
 * Whether the rolling buffer is capturing.
 *
 * Polled rather than inferred from the engine status, because "ready" and "saving"
 * both mean the buffer is running and conflating them with "paused" makes the
 * buttons lie right after a settings change.
 */
export const bufferActiveQuery = {
  queryKey: ['buffer-active'] as const,
  queryFn: () => once(api.isReplayBufferActive),
  refetchInterval: 2_000,
}

export const clipsQuery = {
  queryKey: QK.clips,
  queryFn: () => once(api.getSavedClips),
}

export const screenshotsQuery = {
  queryKey: QK.screenshots,
  queryFn: () => once(api.getScreenshots),
}

export const configQuery = {
  queryKey: QK.config,
  queryFn: () => once(api.getConfig),
}

export const hotkeysQuery = {
  queryKey: QK.hotkeys,
  queryFn: () => once(api.getHotkeys),
}
