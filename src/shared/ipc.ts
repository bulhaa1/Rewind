/** IPC channel names. Kept as a single source of truth for preload + main registration. */

export const IPC = {
  // replay / buffer
  saveReplay: 'save-replay',
  takeScreenshot: 'take-screenshot',
  // Updates. Every one of these is driven by the header button; none is called
  // on a timer or at startup, which is what keeps Rewind silent on the network.
  getUpdateState: 'get-update-state',
  checkForUpdates: 'check-for-updates',
  downloadUpdate: 'download-update',
  quitAndInstall: 'quit-and-install',
  toggleReplayBuffer: 'toggle-replay-buffer',
  setReplayBufferActive: 'set-replay-buffer-active',
  isReplayBufferActive: 'is-replay-buffer-active',
  getStatus: 'get-obs-status',
  getConfig: 'get-config',
  getBufferDuration: 'get-buffer-duration',
  setBufferDuration: 'set-buffer-duration',
  getBufferMemoryEstimate: 'get-buffer-memory-estimate',
  getMemoryWarnMb: 'get-memory-warn-mb',
  setMemoryWarnMb: 'set-memory-warn-mb',
  recoverReplayBuffer: 'recover-replay-buffer',
  reinitOBS: 'reinit-obs',
  retryOBSInit: 'retry-obs-init',

  // continuous recording
  startRecording: 'start-recording',
  stopRecording: 'stop-recording',
  getRecordingState: 'get-recording-state',

  // capture sources
  getDisplays: 'get-displays',
  getWindows: 'get-windows',
  setDisplay: 'set-display',
  setWindow: 'set-window',
  setGameCapture: 'set-game-capture',
  getCurrentMonitor: 'get-current-monitor',
  getCurrentWindow: 'get-current-window',
  getCurrentWindowName: 'get-current-window-name',
  getCaptureMode: 'get-capture-mode',
  getCurrentSourceName: 'get-current-source-name',

  // files & folders
  openFolder: 'open-folder',
  // Rewind's own directories. These take a fixed keyword rather than a path,
  // so the renderer can never ask main to open something outside the app's data.
  openAppFolder: 'open-app-folder',
  openExclusionList: 'open-exclusion-list',
  openFile: 'open-file',
  showClipInFolder: 'show-clip-in-folder',
  getOutputPath: 'get-output-path',
  setOutputPath: 'set-output-path',
  getScreenshotPath: 'get-screenshot-path',
  setScreenshotPath: 'set-screenshot-path',
  openScreenshotFolder: 'open-screenshot-folder',
  selectFolder: 'select-folder',

  // clips
  getSavedClips: 'get-saved-clips',
  getClipThumbnail: 'get-clip-thumbnail',
  deleteClip: 'delete-clip',
  renameClip: 'rename-clip',
  getAppVersion: 'get-app-version',
  openExternal: 'open-external',

  // screenshots
  getScreenshots: 'get-screenshots',
  getScreenshotThumbnail: 'get-screenshot-thumbnail',
  openScreenshot: 'open-screenshot',
  showScreenshotInFolder: 'show-screenshot-in-folder',
  deleteScreenshot: 'delete-screenshot',

  // audio
  getAudioLevels: 'get-audio-levels',
  setChannelVolume: 'set-channel-volume',
  setChannelMuted: 'set-channel-muted',
  getMicGain: 'get-mic-gain',
  setMicGain: 'set-mic-gain',
  getAudioSessions: 'get-audio-sessions',
  setAppVolume: 'set-app-volume',
  setAppMuted: 'set-app-muted',
  resetAppMix: 'reset-app-mix',
  getAudioDevices: 'get-audio-devices',
  getChannelDevices: 'get-channel-devices',
  setChannelDevice: 'set-channel-device',
  addAudioDeviceChannel: 'add-audio-device-channel',
  removeAudioDeviceChannel: 'remove-audio-device-channel',
  setDeviceVolume: 'set-device-volume',
  setDeviceMuted: 'set-device-muted',

  // hotkeys
  getHotkeys: 'get-hotkeys',
  setHotkey: 'set-hotkey',
  startHotkeyCapture: 'start-hotkey-capture',
  stopHotkeyCapture: 'stop-hotkey-capture',

  // quality / encoder
  getFps: 'get-fps',
  setFps: 'set-fps',
  getNvencMultipass: 'get-nvenc-multipass',
  setNvencMultipass: 'set-nvenc-multipass',
  getNvencPreset: 'get-nvenc-preset',
  setNvencPreset: 'set-nvenc-preset',
  getOutputResolution: 'get-output-resolution',
  setOutputResolution: 'set-output-resolution',
  getVisualQuality: 'get-visual-quality',
  setVisualQuality: 'set-visual-quality',
  getVideoCodec: 'get-video-codec',
  setVideoCodec: 'set-video-codec',
  getAvailableCodecs: 'get-available-codecs',
  getVideoEncoder: 'get-video-encoder',
  setVideoEncoder: 'set-video-encoder',
  getAvailableEncoderVendors: 'get-available-encoder-vendors',
  getActiveEncoderVendor: 'get-active-encoder-vendor',

  // simple settings toggles
  getNotificationsEnabled: 'get-notifications-enabled',
  setNotificationsEnabled: 'set-notifications-enabled',
  getNotificationSoundEnabled: 'get-notification-sound-enabled',
  setNotificationSoundEnabled: 'set-notification-sound-enabled',
  getLaunchOnStartup: 'get-launch-on-startup',
  setLaunchOnStartup: 'set-launch-on-startup',

  // notifications
  notificationClick: 'notification-click',

  // editor
  openClipEditor: 'open-clip-editor',
  editorGetClipInfo: 'editor-get-clip-info',
  editorGetTrackPeaks: 'editor-get-track-peaks',
  editorSaveClip: 'editor-save-clip',
  editorCancel: 'editor-cancel',
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/** Channels the preload bridge is allowed to subscribe to (main -> renderer pushes). */
export const EVENT_CHANNELS = [
  'obs-status',
  'clip-saved',
  'screenshot-saved',
  'auto-detect-switched',
  'hotkey-capture-key',
  'play-notification-sound',
  'update-state',
] as const