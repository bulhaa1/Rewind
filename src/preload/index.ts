import { contextBridge, ipcRenderer } from 'electron'
import { IPC, EVENT_CHANNELS } from '@shared/ipc.js'
import type { IpcResult } from '@shared/types.js'

/**
 * Preload bridge.
 *
 * The renderer never touches Node or Electron directly. Every capability is an
 * explicit, named function, and only the channels declared here are reachable.
 */

const allowedEvents = new Set<string>(EVENT_CHANNELS)

/** camelCase method name -> kebab IPC channel. */
const invoke = (channel: string) => (...args: unknown[]): Promise<IpcResult<any>> =>
  ipcRenderer.invoke(channel, ...args) as Promise<IpcResult<any>>

const api: Record<string, unknown> = {}

// Replay / buffer
api.saveReplay = invoke(IPC.saveReplay)
api.takeScreenshot = invoke(IPC.takeScreenshot)
api.toggleReplayBuffer = invoke(IPC.toggleReplayBuffer)
// Updates. Each is only ever called from the header button.
api.getUpdateState = invoke(IPC.getUpdateState)
api.checkForUpdates = invoke(IPC.checkForUpdates)
api.downloadUpdate = invoke(IPC.downloadUpdate)
api.quitAndInstall = invoke(IPC.quitAndInstall)
api.getStatus = invoke(IPC.getStatus)
api.getConfig = invoke(IPC.getConfig)
api.getBufferDuration = invoke(IPC.getBufferDuration)
api.setBufferDuration = invoke(IPC.setBufferDuration)
api.recoverReplayBuffer = invoke(IPC.recoverReplayBuffer)
api.reinitOBS = invoke(IPC.reinitOBS)
api.retryOBSInit = invoke(IPC.retryOBSInit)

// Explicit buffer control (idempotent, unlike the toggle)
api.setReplayBufferActive = invoke(IPC.setReplayBufferActive)
api.isReplayBufferActive = invoke(IPC.isReplayBufferActive)

// Continuous recording
api.startRecording = invoke(IPC.startRecording)
api.stopRecording = invoke(IPC.stopRecording)
api.getRecordingState = invoke(IPC.getRecordingState)

// Capture sources
api.getDisplays = invoke(IPC.getDisplays)
api.getWindows = invoke(IPC.getWindows)
api.setDisplay = invoke(IPC.setDisplay)
api.setWindow = invoke(IPC.setWindow)
api.setGameCapture = invoke(IPC.setGameCapture)
api.getCurrentMonitor = invoke(IPC.getCurrentMonitor)
api.getCurrentWindow = invoke(IPC.getCurrentWindow)
api.getCurrentWindowName = invoke(IPC.getCurrentWindowName)
api.getCaptureMode = invoke(IPC.getCaptureMode)
api.getCurrentSourceName = invoke(IPC.getCurrentSourceName)

// Files & folders
api.openFolder = invoke(IPC.openFolder)
api.openAppFolder = invoke(IPC.openAppFolder)
api.openExclusionList = invoke(IPC.openExclusionList)
api.openFile = invoke(IPC.openFile)
api.showClipInFolder = invoke(IPC.showClipInFolder)
api.getOutputPath = invoke(IPC.getOutputPath)
api.setOutputPath = invoke(IPC.setOutputPath)
api.getScreenshotPath = invoke(IPC.getScreenshotPath)
api.setScreenshotPath = invoke(IPC.setScreenshotPath)
api.openScreenshotFolder = invoke(IPC.openScreenshotFolder)
api.selectFolder = invoke(IPC.selectFolder)

// Clips
api.getSavedClips = invoke(IPC.getSavedClips)
api.getClipThumbnail = invoke(IPC.getClipThumbnail)
api.deleteClip = invoke(IPC.deleteClip)
api.renameClip = invoke(IPC.renameClip)
api.getAppVersion = invoke(IPC.getAppVersion)
api.openExternal = invoke(IPC.openExternal)

// Screenshots
api.getScreenshots = invoke(IPC.getScreenshots)
api.getScreenshotThumbnail = invoke(IPC.getScreenshotThumbnail)
api.openScreenshot = invoke(IPC.openScreenshot)
api.showScreenshotInFolder = invoke(IPC.showScreenshotInFolder)
api.deleteScreenshot = invoke(IPC.deleteScreenshot)

// Audio
api.getAudioLevels = invoke(IPC.getAudioLevels)
api.setChannelVolume = invoke(IPC.setChannelVolume)
api.setChannelMuted = invoke(IPC.setChannelMuted)
api.getQuickClipSeconds = invoke(IPC.getQuickClipSeconds)
api.setQuickClipSeconds = invoke(IPC.setQuickClipSeconds)
api.getMicGain = invoke(IPC.getMicGain)
api.setMicGain = invoke(IPC.setMicGain)
api.getAudioSessions = invoke(IPC.getAudioSessions)
api.setAppVolume = invoke(IPC.setAppVolume)
api.setAppMuted = invoke(IPC.setAppMuted)
api.resetAppMix = invoke(IPC.resetAppMix)
api.getAudioDevices = invoke(IPC.getAudioDevices)
api.getChannelDevices = invoke(IPC.getChannelDevices)
api.setChannelDevice = invoke(IPC.setChannelDevice)
api.addAudioDeviceChannel = invoke(IPC.addAudioDeviceChannel)
api.removeAudioDeviceChannel = invoke(IPC.removeAudioDeviceChannel)
api.setDeviceVolume = invoke(IPC.setDeviceVolume)
api.setDeviceMuted = invoke(IPC.setDeviceMuted)

// Hotkeys
api.getHotkeys = invoke(IPC.getHotkeys)
api.setHotkey = invoke(IPC.setHotkey)
api.startHotkeyCapture = invoke(IPC.startHotkeyCapture)
api.stopHotkeyCapture = invoke(IPC.stopHotkeyCapture)

// Quality / encoder
api.getFps = invoke(IPC.getFps)
api.setFps = invoke(IPC.setFps)
api.getNvencMultipass = invoke(IPC.getNvencMultipass)
api.setNvencMultipass = invoke(IPC.setNvencMultipass)
api.getNvencPreset = invoke(IPC.getNvencPreset)
api.setNvencPreset = invoke(IPC.setNvencPreset)
api.getOutputResolution = invoke(IPC.getOutputResolution)
api.setOutputResolution = invoke(IPC.setOutputResolution)
api.getVisualQuality = invoke(IPC.getVisualQuality)
api.setVisualQuality = invoke(IPC.setVisualQuality)
api.getVideoCodec = invoke(IPC.getVideoCodec)
api.setVideoCodec = invoke(IPC.setVideoCodec)
api.getAvailableCodecs = invoke(IPC.getAvailableCodecs)
api.getVideoEncoder = invoke(IPC.getVideoEncoder)
api.setVideoEncoder = invoke(IPC.setVideoEncoder)
api.getAvailableEncoderVendors = invoke(IPC.getAvailableEncoderVendors)
api.getActiveEncoderVendor = invoke(IPC.getActiveEncoderVendor)

// Simple settings
api.getNotificationsEnabled = invoke(IPC.getNotificationsEnabled)
api.setNotificationsEnabled = invoke(IPC.setNotificationsEnabled)
api.getNotificationSoundEnabled = invoke(IPC.getNotificationSoundEnabled)
api.setNotificationSoundEnabled = invoke(IPC.setNotificationSoundEnabled)
api.getLaunchOnStartup = invoke(IPC.getLaunchOnStartup)
api.setLaunchOnStartup = invoke(IPC.setLaunchOnStartup)

// Notifications
api.notificationClick = invoke(IPC.notificationClick)

// Editor
api.openClipEditor = invoke(IPC.openClipEditor)
api.editorGetClipInfo = invoke(IPC.editorGetClipInfo)
api.editorGetTrackPeaks = invoke(IPC.editorGetTrackPeaks)
api.editorSaveClip = invoke(IPC.editorSaveClip)
api.editorCancel = invoke(IPC.editorCancel)

/**
 * Subscribes to a main-process push event. Returns an unsubscribe function.
 * Throws on an unknown channel so a typo fails loudly at startup rather than
 * silently never firing.
 */
api.on = (event: string, handler: (...args: any[]) => void): (() => void) => {
  if (!allowedEvents.has(event)) throw new Error(`Unknown event channel: ${event}`)
  const listener = (_e: unknown, ...args: unknown[]) => handler(...args)
  ipcRenderer.on(event, listener)
  return () => ipcRenderer.removeListener(event, listener)
}

contextBridge.exposeInMainWorld('electronAPI', api)

export type RewindApi = typeof api