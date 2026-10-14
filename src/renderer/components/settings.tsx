import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Bell,
  Camera,
  Copy,
  Crosshair,
  Database,
  FileText,
  Film,
  FolderOpen,
  Gauge,
  Gamepad2,
  Keyboard,
  ListFilter,
  Mic,
  Monitor,
  Plus,
  Power,
  RefreshCw,
  Sliders,
  Trash2,
  Volume2,
  X,
} from 'lucide-react'
import { api, read } from '../lib/api'
import { QK, SETTINGS, captureStateQuery, dedupeWindows, hotkeysQuery, profilesQuery } from '../lib/queries'
import { useBackgroundAction, useObsStatus } from '../lib/context'
import { HotkeyChip, VolumeControl } from './audio-controls'
import { HotkeyDialog } from './record'
import { Select, SettingSelect, SettingSwitchRow, type Option } from './controls'
import { Button, Badge, InlineSpinner, Menu, MenuItem, PathRow, Row, Section, SectionHeading, cn } from './ui'
import {
  ALLOWED_FPS,
  BUFFER_DURATION_MAX,
  BUFFER_DURATION_MIN,
  CODEC_OPTIONS,
  FPS_OPTIONS,
  MIC_GAIN,
  MULTIPASS_OPTIONS,
  NVENC_PRESET_OPTIONS,
  OUTPUT_RESOLUTION_OPTIONS,
  VISUAL_QUALITIES,
  VISUAL_QUALITY_OPTIONS,
} from '@shared/constants.js'
import type { AudioChannel, AudioDevice, HotkeyAction, IpcResult, Profile } from '@shared/types.js'

/** Sentinel selecting "Auto detect launched game". */
const AUTO_GAME = '__auto_game_capture__'

// ---------------------------------------------------------------------------
// Capture source
// ---------------------------------------------------------------------------

/**
 * Capture source picker.
 *
 * "Game Capture" is auto-detect — the concrete window is chosen by the detector, so
 * an explicit window list is offered alongside it. Both are `window` mode
 * internally; the distinction is only which window handle is active.
 */
function CaptureSection() {
  const client = useQueryClient()
  const { runAction } = useBackgroundAction()
  const { data, isPending } = useQuery(captureStateQuery)
  const [refreshing, setRefreshing] = useState(false)

  const [mode, setMode] = useState<'display' | 'window'>('display')
  const [displayIndex, setDisplayIndex] = useState(0)
  const [selectedWindow, setSelectedWindow] = useState<string | null>(null)

  useEffect(() => {
    if (!data) return
    setMode(data.mode === 'display' ? 'display' : 'window')
    setDisplayIndex(data.currentMonitor)
    setSelectedWindow(data.mode === 'game' ? AUTO_GAME : data.currentWindowId)
  }, [data])

  const windows = useMemo(() => dedupeWindows(data?.windows ?? []), [data?.windows])

  /**
   * Keeps the selected window visible even when OBS stops reporting it, so the row
   * doesn't silently jump back to whatever else is at the top of the list.
   */
  const windowRows = useMemo(() => {
    const list: { id: string; name: string; inactive?: boolean }[] = [...windows]
    if (selectedWindow && selectedWindow !== AUTO_GAME && !list.some((w) => w.id === selectedWindow)) {
      list.push({ id: selectedWindow, name: data?.currentWindowName || 'Unknown Window', inactive: true })
    }
    return list
  }, [windows, selectedWindow, data?.currentWindowName])

  const chooseDisplay = useCallback(
    (index: number) => {
      setDisplayIndex(index)
      setSelectedWindow(null)
      void runAction(async () => {
        const res = await api.setDisplay(index)
        if (!res.success) throw new Error(res.error)
        await client.invalidateQueries({ queryKey: QK.captureState })
      })
    },
    [runAction, client],
  )

  const chooseWindow = useCallback(
    (id: string) => {
      setSelectedWindow(id)
      void runAction(async () => {
        const res = id === AUTO_GAME ? await api.setGameCapture() : await api.setWindow(id)
        if (!res.success) throw new Error(res.error)
        await client.invalidateQueries({ queryKey: QK.captureState })
      })
    },
    [runAction, client],
  )

  const refreshWindows = useCallback(async () => {
    setRefreshing(true)
    try {
      await api.getWindows()
      await client.invalidateQueries({ queryKey: QK.captureState })
    } finally {
      setRefreshing(false)
    }
  }, [client])

  return (
    <Section icon={<Monitor />} title="Display">
      {isPending || !data ? (
        <InlineSpinner />
      ) : (
        <>
          <div className="space-y-2">
            <span className="label">Capture Source</span>
            <div className="flex gap-2">
              {(
                [
                  { id: 'window' as const, label: 'Game Capture', icon: <Gamepad2 className="mr-2 h-4 w-4" /> },
                  { id: 'display' as const, label: 'Display', icon: <Monitor className="mr-2 h-4 w-4" /> },
                ]
              ).map(({ id, label, icon }) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={mode === id}
                  onClick={() => {
                    setMode(id)
                    if (id === 'display') chooseDisplay(displayIndex)
                    else chooseWindow(AUTO_GAME)
                  }}
                  className={cn(
                    'flex flex-1 items-center justify-center rounded-md border px-2 py-1.5 text-[13px] font-medium transition-colors',
                    mode === id
                      ? 'border-accent bg-accent-soft text-accent'
                      : 'border-line text-ink-muted hover:border-line-strong hover:text-ink',
                  )}
                >
                  {icon}
                  {label}
                </button>
              ))}
            </div>
          </div>

          {mode === 'display' ? (
            <div className="space-y-2">
              <span className="label">Select Display</span>
              <div className="space-y-2">
                {data.displays.map((d, i) => (
                  <SelectableCard
                    key={d.id}
                    icon={<Monitor />}
                    selected={displayIndex === i}
                    onClick={() => chooseDisplay(i)}
                    title={d.name}
                    subtitle={`${d.width} x ${d.height}`}
                  />
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <SelectableCard
                icon={<Crosshair />}
                selected={selectedWindow === AUTO_GAME}
                onClick={() => chooseWindow(AUTO_GAME)}
                title="Auto detect launched game"
                subtitle="Records desktop, auto-switches when a game is launched"
              />

              <div className="space-y-2 border-t border-line pt-4">
                <div className="flex items-center justify-between">
                  <span className="label">Select Window</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2"
                    onClick={() => void refreshWindows()}
                    disabled={refreshing}
                  >
                    <RefreshCw className={refreshing ? 'mr-1 h-3 w-3 animate-spin' : 'mr-1 h-3 w-3'} />
                    Refresh
                  </Button>
                </div>

                {windowRows.length === 0 ? (
                  <p className="py-8 text-center text-[13px] text-ink-muted">No windows found. Try refreshing.</p>
                ) : (
                  <div className="space-y-2">
                    {windowRows.map((w) => (
                      <SelectableCard
                        key={w.id}
                        icon={<Gamepad2 />}
                        selected={selectedWindow === w.id}
                        disabled={!!w.inactive}
                        onClick={() => chooseWindow(w.id)}
                        title={w.name}
                        badge={w.inactive ? 'Inactive' : undefined}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </Section>
  )
}

/** A large selectable card used for display and window pickers. */
function SelectableCard({
  icon,
  selected,
  disabled = false,
  onClick,
  title,
  subtitle,
  badge,
}: {
  icon: React.ReactNode
  selected: boolean
  disabled?: boolean
  onClick: () => void
  title: string
  subtitle?: string
  badge?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      className={
        'w-full rounded-lg border p-3 text-left transition-colors ' +
        (selected ? 'border-accent bg-accent-soft' : 'border-line bg-canvas hover:bg-raised/40') +
        (disabled ? ' cursor-not-allowed opacity-60' : '')
      }
    >
      <div className="flex items-start gap-3">
        <span className={`mt-0.5 h-5 w-5 shrink-0 ${selected ? 'text-accent' : 'text-ink-muted'}`}>{icon}</span>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-medium">{title}</span>
            {badge ? <Badge tone="neutral">{badge}</Badge> : null}
          </div>
          {subtitle ? <span className="text-[11px] text-ink-faint">{subtitle}</span> : null}
        </div>
      </div>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

/**
 * Audio mixer.
 *
 * Desktop audio has one global volume plus an optional per-app mix; extra endpoints
 * can be added as additional channels. Both of the track-splitting toggles require
 * an OBS restart, which the shared background-action layer reports on failure.
 */
function AudioSection() {
  return (
    <Section icon={<Volume2 />} title="Audio">
      <AudioChannelEditor channel="desktop" label="Output source" />
      <div className="border-t border-line" />
      <AudioChannelEditor channel="microphone" label="Input source" />
    </Section>
  )
}

/** Device bound to a channel, plus its volume and any extra channels on it. */
function AudioChannelEditor({ channel, label }: { channel: AudioChannel; label: string }) {
  const { runAction } = useBackgroundAction()
  const isOutput = channel === 'desktop'

  const devicesQuery = useQuery({
    queryKey: ['audio-devices', channel],
    queryFn: async () => {
      const [devices, channels] = await Promise.all([api.getAudioDevices(), api.getChannelDevices()])
      if (!devices.success || !channels.success) return { devices: [] as AudioDevice[], bound: 'default' }
      return { devices: devices.data ?? [], bound: channels.data?.[channel] ?? 'default' }
    },
    retry: false,
    // A plugged-in microphone has to appear without reopening Settings. The list was
    // fetched exactly once, when the panel mounted, so a mic connected afterwards was
    // invisible until an app restart -- and one unplugged mid-session stayed listed.
    refetchOnWindowFocus: true,
    refetchInterval: 5_000,
  })

  const levelsQuery = useQuery({
    queryKey: ['audio-levels', channel],
    queryFn: async () => {
      const res = await api.getAudioLevels()
      return res.success ? (res.data?.[channel] ?? null) : null
    },
  })

  const appsQuery = useQuery({
    queryKey: ['audio-sessions'],
    queryFn: async () => {
      const res = await api.getAudioSessions()
      return res.success ? (res.data ?? []) : []
    },
    refetchInterval: isOutput ? 2000 : false,
    enabled: isOutput,
  })

  const gainQuery = useQuery({
    queryKey: SETTINGS.micGain.queryKey,
    queryFn: async () => read(SETTINGS.micGain.get(), MIC_GAIN.DEFAULT),
    enabled: !isOutput,
  })

  const devices = devicesQuery.data?.devices ?? []
  const bound = devicesQuery.data?.bound ?? 'default'
  const level = levelsQuery.data ?? { volume: 1, muted: false }
  const gain = gainQuery.data ?? MIC_GAIN.DEFAULT

  const ofKind = devices.filter((d) => d.kind === (isOutput ? 'output' : 'input'))
  const selectable = ofKind.filter((d) => d.available && !d.added && !d.coveredBy)
  const added = ofKind.filter((d) => d.added)
  const boundMissing = bound !== 'default' && !ofKind.some((d) => d.id === bound && d.available)

  const deviceOptions: Option<string>[] = [
    { value: 'default', label: 'Windows Default' },
    ...selectable.map((d) => ({ value: d.id, label: d.label })),
  ]

  const commit = useCallback(
    (fn: () => Promise<{ success: boolean; error?: string }>, refetch: () => void) => {
      void runAction(async () => {
        const res = await fn()
        if (!res.success) throw new Error(res.error || 'Audio change failed')
        refetch()
      })
    },
    [runAction],
  )

  return (
    <section className="space-y-2.5">
      <SectionHeading icon={isOutput ? <Volume2 /> : <Mic />} label={label} />

      <div className="flex items-center gap-2 pt-0.5">
        {devicesQuery.isPending ? (
          <InlineSpinner className="min-w-0 flex-1" />
        ) : (
          <>
            <Select
              className="min-w-0 flex-1 justify-between"
              align="start"
              value={bound}
              options={deviceOptions}
              onSelect={(id) => commit(() => api.setChannelDevice(channel, id), devicesQuery.refetch)}
              fallbackLabel="Selected device — not connected"
              label={label}
            />
            {selectable.length > 0 ? (
              <AddDeviceButton
                channel={channel}
                devices={selectable}
                onAdd={(id) => commit(() => api.addAudioDeviceChannel(id), devicesQuery.refetch)}
              />
            ) : null}
          </>
        )}
      </div>

      <VolumeControl
        label="Volume"
        level={level}
        onVolumeChange={(v) => commit(() => api.setChannelVolume(channel, v), levelsQuery.refetch)}
        onMuteToggle={() => commit(() => api.setChannelMuted(channel, !level.muted), levelsQuery.refetch)}
      />
      {isOutput ? null : (
        <VolumeControl
          label="Input gain"
          level={{ volume: gain, muted: false }}
          max={MIC_GAIN.MAX}
          step={MIC_GAIN.STEP}
          format={(v) => `${v.toFixed(2)}x`}
          mutable={false}
          ariaLabel="Microphone input gain"
          title={`Multiplies the mic before the volume fader, so a volume of 0 is still silence. Stops at ${MIC_GAIN.MAX}x (about +6 dB), past which a boost clips the voice rather than making it easier to hear.`}
          onVolumeChange={(v) => commit(() => api.setMicGain(v), gainQuery.refetch)}
        />
      )}

      {isOutput ? <AppMix apps={appsQuery.data ?? []} /> : null}

      {added.length > 0 ? (
        <div className="space-y-3 pl-6">
          {added.map((d) => (
            <div key={d.id} className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <VolumeControl
                  label={d.label}
                  sublabel={d.available ? undefined : 'not connected'}
                  level={{ volume: d.volume, muted: d.muted }}
                  disabled={!d.available}
                  onVolumeChange={(v) => commit(() => api.setDeviceVolume(d.id, v), devicesQuery.refetch)}
                  onMuteToggle={() => commit(() => api.setDeviceMuted(d.id, !d.muted), devicesQuery.refetch)}
                />
              </div>
              {d.track !== undefined ? (
                <span className="tabular shrink-0 text-[11px] text-ink-faint" title={`Audio track ${d.track}`}>
                  T{d.track}
                </span>
              ) : null}
              <button
                type="button"
                onClick={() => commit(() => api.removeAudioDeviceChannel(d.id), devicesQuery.refetch)}
                aria-label={`Stop recording ${d.label}`}
                className="shrink-0 text-ink-muted transition-colors hover:text-ink"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {boundMissing ? (
        <p className="text-[11px] text-danger">
          The selected device isn't connected, so nothing is being captured. Reconnect it, or switch back to Windows
          Default.
        </p>
      ) : null}
    </section>
  )
}

/** "+" control that opens a picker of endpoints not yet recorded. */
function AddDeviceButton({
  channel,
  devices,
  onAdd,
}: {
  channel: AudioChannel
  devices: AudioDevice[]
  onAdd: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const isOutput = channel === 'desktop'
  const action = isOutput ? 'Add output device' : 'Add audio input'

  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      label={action}
      trigger={
        <Button variant="outline" size="icon" className="w-9 px-0" aria-label={action} title={action}>
          <Sliders className="h-4 w-4" />
        </Button>
      }
    >
      {devices.map((d) => (
        <MenuItem key={d.id} onSelect={() => onAdd(d.id)}>
          <span className="min-w-0 flex-1 truncate">{d.label}</span>
        </MenuItem>
      ))}
    </Menu>
  )
}

/**
 * Per-app faders.
 *
 * Customizing any of these replaces the desktop loopback with one process-loopback
 * source per app, so an app that can't be captured individually stays in the mix
 * and its slider is disabled.
 */
function AppMix({ apps }: { apps: { exe: string; displayName: string; running: boolean; capturable: boolean; volume: number; muted: boolean }[] }) {
  const client = useQueryClient()
  const { runAction } = useBackgroundAction()
  const customized = apps.some((a) => a.volume !== 1 || a.muted)

  if (apps.length === 0) {
    return <p className="pl-6 text-[11px] text-ink-faint">No apps are playing audio right now</p>
  }

  return (
    <div className="space-y-3 pl-6">
      {apps.map((app) => {
        const unavailable = app.running && !app.capturable
        return (
          <VolumeControl
            key={app.exe}
            label={app.displayName}
            sublabel={app.running ? undefined : 'not running'}
            level={{ volume: app.volume, muted: app.muted }}
            disabled={unavailable}
            title={
              unavailable
                ? "This app's audio can't be captured individually - it stays in the default mix"
                : undefined
            }
            onVolumeChange={(v) =>
              void runAction(async () => {
                const res = await api.setAppVolume(app.exe, v)
                if (!res.success) throw new Error(res.error)
                await client.invalidateQueries({ queryKey: ['audio-sessions'] })
              })
            }
            onMuteToggle={() =>
              void runAction(async () => {
                const res = await api.setAppMuted(app.exe, !app.muted)
                if (!res.success) throw new Error(res.error)
                await client.invalidateQueries({ queryKey: ['audio-sessions'] })
              })
            }
          />
        )
      })}

      {customized ? (
        <button
          type="button"
          onClick={() =>
            void runAction(async () => {
              const res = await api.resetAppMix()
              if (!res.success) throw new Error(res.error)
              await client.invalidateQueries({ queryKey: ['audio-sessions'] })
            })
          }
          className="block text-[11px] font-medium text-ink-faint underline underline-offset-2 transition-colors hover:text-ink"
        >
          Reset mix
        </button>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Simple toggles
// ---------------------------------------------------------------------------

function NotificationsSection() {
  return (
    <Section icon={<Bell />} title="Notifications">
      <div className="space-y-4">
        <SettingSwitchRow
          binding={SETTINGS.notificationsEnabled}
          label="Show notifications"
          description="Display a popup when clips are saved"
        />
        <SettingSwitchRow
          binding={SETTINGS.notificationSoundEnabled}
          label="Notification sound"
          description="Play a sound when a clip is saved"
        />
      </div>
    </Section>
  )
}

function StartupSection() {
  return (
    <Section icon={<Power className="h-4 w-4" />} title="Startup">
      <div className="space-y-4">
        <SettingSwitchRow
          binding={SETTINGS.launchOnStartup}
          label="Launch on startup"
          description="Automatically start Rewind when you log in to Windows"
        />
        <SettingSwitchRow
          binding={SETTINGS.startMinimized}
          label="Start minimized"
          description="Open to the tray with no window shown — the tray icon brings it back"
        />
      </div>
    </Section>
  )
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Shared Browse flow: pick a folder, validate it, persist it. */
function useFolderPicker(
  kind: 'replays' | 'screenshots',
  binding: { queryKey: readonly unknown[]; set: (v: string) => Promise<any> },
  invalidate: ReadonlyArray<readonly unknown[]>,
) {
  const client = useQueryClient()
  const { runAction } = useBackgroundAction()

  return useCallback(() => {
    void runAction(async () => {
      const picked = await api.selectFolder(kind)
      if (!picked.success) throw new Error(picked.error)

      const target = picked.data?.path
      if (picked.data?.canceled || !target) return

      const res = await binding.set(target)
      if (!res.success) throw new Error(res.error)

      // The setter returns the effective path -- the app's own `Rewind` folder
      // inside the pick -- so the row shows where files actually land.
      client.setQueryData([...binding.queryKey], res.data ?? target)
      for (const key of invalidate) await client.invalidateQueries({ queryKey: [...(key as unknown[])] })
    })
  }, [client, runAction, binding, kind, invalidate])
}

function ReplaysSection() {
  const { data } = useQuery({
    queryKey: SETTINGS.outputPath.queryKey,
    queryFn: async () => read(SETTINGS.outputPath.get(), ''),
  })
  const browse = useFolderPicker('replays', SETTINGS.outputPath, [QK.clips, QK.screenshots])

  return (
    <Section icon={<Film />} title="Replays">
      <div className="space-y-4">
        <PathRow label="Save Location" path={data ?? ''} onBrowse={() => void browse()} />
      </div>
    </Section>
  )
}

function ScreenshotsSection() {
  const { data } = useQuery({
    queryKey: SETTINGS.screenshotPath.queryKey,
    queryFn: async () => read(SETTINGS.screenshotPath.get(), ''),
  })
  const browse = useFolderPicker('screenshots', SETTINGS.screenshotPath, [QK.screenshots])

  return (
    <Section icon={<Camera />} title="Screenshots">
      <PathRow label="Save Location" path={data ?? ''} onBrowse={() => void browse()} />
    </Section>
  )
}

// ---------------------------------------------------------------------------
// Quality
// ---------------------------------------------------------------------------

/**
 * Encoder configuration.
 *
 * Rows appear only when relevant: NVENC options when NVENC is active, and the codec
 * picker when more than one codec is available. Every change here restarts OBS, so
 * the capability queries are refetched once the pipeline reports ready again.
 */
function QualitySection() {
  const { status } = useObsStatus()
  const client = useQueryClient()

  const codecsQuery = useQuery({
    queryKey: [...QK.encoderState, 'codecs'],
    queryFn: async () => read(api.getAvailableCodecs(), ['h264']),
  })
  const vendorsQuery = useQuery({
    queryKey: [...QK.encoderState, 'vendors'],
    queryFn: async () => read(api.getAvailableEncoderVendors(), []),
  })
  const activeQuery = useQuery({
    queryKey: [...QK.encoderState, 'active'],
    queryFn: async () => read(api.getActiveEncoderVendor(), 'x264'),
  })
  const encoderQuery = useQuery({
    queryKey: SETTINGS.videoEncoder.queryKey,
    queryFn: async () => read(SETTINGS.videoEncoder.get(), 'auto'),
  })

  const pending = codecsQuery.isPending || vendorsQuery.isPending || activeQuery.isPending

  const refreshEncoderState = useCallback(async () => {
    await Promise.all([codecsQuery.refetch(), vendorsQuery.refetch(), activeQuery.refetch()])
  }, [codecsQuery, vendorsQuery, activeQuery])

  // Capabilities change with the hardware, so re-read them after each restart.
  useEffect(() => {
    if (status === 'ready') void refreshEncoderState()
  }, [status, refreshEncoderState])

  const availableCodecs: string[] = codecsQuery.data ?? ['h264']
  const vendors = vendorsQuery.data ?? []
  const activeVendor = activeQuery.data ?? 'x264'
  const selectedVendor = encoderQuery.data ?? 'auto'

  // `auto` resolves to the first hardware vendor, matching the main process.
  const resolvedVendor =
    selectedVendor === 'auto'
      ? (vendors.find((v) => v.vendor !== 'auto' && v.vendor !== 'x264')?.vendor ?? 'x264')
      : selectedVendor
  const onSoftwareFallback = activeVendor === 'x264' && resolvedVendor !== 'x264'

  const vendorOptions: Option<string>[] = vendors.map((v) => ({
    value: v.vendor,
    label: v.vendor === 'auto' ? v.label : `${v.label} (${v.isHardware ? 'GPU' : 'CPU'})`,
  }))

  const codecOptions: Option<string>[] = CODEC_OPTIONS.filter((c) => availableCodecs.includes(c.value)).map((c) => ({
    value: c.value,
    label: c.label,
  }))

  return (
    <Section icon={<Gauge />} title="Quality">
      <div className="space-y-4">
        <Row label="Output Resolution" description="The pixel dimensions of your saved clips" loading={pending}>
          <SettingSelect
            binding={SETTINGS.outputResolution}
            initial="native"
            options={OUTPUT_RESOLUTION_OPTIONS}
            label="Output Resolution"
            onSuccess={async () => {
              await client.invalidateQueries({ queryKey: QK.config })
            }}
          />
        </Row>

        <Row label="Visual Quality" description="How much detail the encoder preserves per frame">
          <SettingSelect binding={SETTINGS.visualQuality} initial="high" options={VISUAL_QUALITY_OPTIONS} label="Visual Quality" />
        </Row>

        <Row label="Frame Rate" description="Frames per second encoded">
          <SettingSelect binding={SETTINGS.fps} initial={30} options={FPS_OPTIONS} label="Frame Rate" />
        </Row>

        {activeVendor === 'nvenc' ? (
          <>
            <Row label="Multipass Encoding" description="Whether NVENC analyzes each frame twice">
              <SettingSelect binding={SETTINGS.nvencMultipass} initial="disabled" options={MULTIPASS_OPTIONS} label="Multipass Encoding" />
            </Row>
            <Row label="Encoder Preset" description="How much effort the encoder spends per frame">
              <SettingSelect binding={SETTINGS.nvencPreset} initial="p4" options={NVENC_PRESET_OPTIONS} label="Encoder Preset" />
            </Row>
          </>
        ) : null}

        {vendorOptions.length > 2 ? (
          <Row
            label="Encoder"
            description="Which encoder converts your video"
            subline={
              onSoftwareFallback ? (
                <p className="mt-0.5 text-[11px] text-warn">
                  Currently running x264 (CPU) - the hardware encoder failed to start
                </p>
              ) : undefined
            }
          >
            <SettingSelect
              binding={SETTINGS.videoEncoder}
              initial="auto"
              options={vendorOptions}
              label="Encoder"
              onSuccess={refreshEncoderState}
            />
          </Row>
        ) : null}

        {codecOptions.length > 1 ? (
          <Row label="Codec" description="How your clips are encoded & compressed">
            <SettingSelect
              binding={SETTINGS.videoCodec}
              initial="h264"
              options={codecOptions}
              label="Codec"
              onSuccess={refreshEncoderState}
            />
          </Row>
        ) : null}

        <p className="border-t border-line/40 pt-2 text-[11px] text-ink-faint">
          If the selected encoder fails, encoding falls back to x264 (CPU).
        </p>
      </div>
    </Section>
  )
}

// ---------------------------------------------------------------------------
// Hotkeys
// ---------------------------------------------------------------------------

const HOTKEY_ROWS: { action: HotkeyAction; label: string }[] = [
  { action: 'save-replay', label: 'Save Replay' },
  { action: 'save-quick-clip', label: 'Save Quick Clip' },
  { action: 'screenshot', label: 'Screenshot' },
  { action: 'toggle-record', label: 'Start / Stop Recording' },
]

/**
 * The four capture presets.
 *
 * Editing the active profile applies through the same path a switch uses; editing an
 * inactive one only stores it, so the panel never restarts the engine for a profile the
 * user is not on.
 */
function ProfilesSection() {
  const client = useQueryClient()
  const { runAction } = useBackgroundAction()
  const { data } = useQuery(profilesQuery)
  const profiles: Profile[] = data?.profiles ?? []
  const activeProfile = data?.activeProfile ?? 0

  /**
   * Saves one field, through the same error surface as every other action.
   *
   * The inputs are uncontrolled and save on blur, which fires even when nothing was
   * typed -- and re-applying an unchanged value would restart the engine for nothing.
   */
  const save = (index: number, patch: Partial<Profile>, current: Profile) => {
    const changed = Object.entries(patch).some(
      ([key, value]) => (current as unknown as Record<string, unknown>)[key] !== value,
    )
    if (!changed) return
    void runAction(async () => {
      const res = await api.setProfileValues(index, patch)
      if (!res.success) throw new Error(res.error)
    }).then(() => client.invalidateQueries({ queryKey: QK.profiles }))
  }

  /** Runs one CRUD action through the shared error surface, then refetches. */
  const run = (fn: () => Promise<IpcResult<unknown>>) => {
    void runAction(async () => {
      const res = await fn()
      if (!res.success) throw new Error(res.error)
    }).then(() => client.invalidateQueries({ queryKey: QK.profiles }))
  }

  return (
    <Section icon={<Sliders className="h-4 w-4" />} title="Profiles">
      <div className="space-y-3">
        <p className="text-[11px] text-ink-faint">
          Switch with the numbered buttons on the main page. Edits to the active profile apply immediately; &ldquo;Save
          current settings&rdquo; copies the live settings into the active profile.
        </p>
        {profiles.map((profile, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <span
              className={cn('w-4 text-center text-[12px] font-medium', i === activeProfile ? 'text-accent' : 'text-ink-faint')}
              title={i === activeProfile ? 'Active profile' : undefined}
            >
              {i + 1}
            </span>
            <input
              type="text"
              defaultValue={profile.name}
              maxLength={24}
              aria-label={`Profile ${i + 1} name`}
              onBlur={(e) => save(i, { name: e.target.value }, profile)}
              className="h-7 w-28 rounded border border-line bg-raised px-2 text-[12px] text-ink outline-none focus:border-accent"
            />
            <label className="flex items-center gap-1 text-[11px] text-ink-faint">
              <input
                type="number"
                defaultValue={profile.bufferDuration}
                min={BUFFER_DURATION_MIN}
                max={BUFFER_DURATION_MAX}
                aria-label={`Profile ${i + 1} buffer seconds`}
                onBlur={(e) => save(i, { bufferDuration: Number(e.target.value) }, profile)}
                className="h-7 w-16 rounded border border-line bg-raised px-2 text-[12px] text-ink outline-none focus:border-accent"
              />
              s
            </label>
            <select
              value={profile.fps}
              aria-label={`Profile ${i + 1} fps`}
              onChange={(e) => save(i, { fps: Number(e.target.value) }, profile)}
              className="h-7 rounded border border-line bg-raised px-1.5 text-[12px] text-ink outline-none focus:border-accent"
            >
              {ALLOWED_FPS.map((fps) => (
                <option key={fps} value={fps}>
                  {fps} fps
                </option>
              ))}
            </select>
            <select
              value={profile.visualQuality}
              aria-label={`Profile ${i + 1} quality`}
              onChange={(e) => save(i, { visualQuality: e.target.value as Profile['visualQuality'] }, profile)}
              className="h-7 rounded border border-line bg-raised px-1.5 text-[12px] text-ink outline-none focus:border-accent"
            >
              {VISUAL_QUALITIES.map((quality) => (
                <option key={quality} value={quality}>
                  {quality}
                </option>
              ))}
            </select>
            <span className="ml-auto flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
              {i === activeProfile ? (
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="profile-save-current"
                  title="Copy the live capture settings into this profile"
                  onClick={() => run(() => api.saveActiveProfile())}
                >
                  Save current settings
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="iconSm"
                data-testid={`profile-duplicate-${i}`}
                title="Duplicate"
                onClick={() => run(() => api.duplicateProfile(i))}
              >
                <Copy className="h-3.5 w-3.5" strokeWidth={1.5} />
              </Button>
              <Button
                variant="ghost"
                size="iconSm"
                data-testid={`profile-remove-${i}`}
                title={
                  profiles.length <= 1
                    ? 'Cannot remove the only profile'
                    : i === activeProfile
                      ? 'Switch to another profile before removing it'
                      : 'Remove'
                }
                disabled={i === activeProfile || profiles.length <= 1}
                onClick={() => run(() => api.removeProfile(i))}
              >
                <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
              </Button>
            </span>
          </div>
        ))}
        <Button
          variant="ghost"
          size="sm"
          data-testid="profile-add"
          onClick={() => run(() => api.addProfile())}
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={1.5} />
          Add profile
        </Button>
      </div>
    </Section>
  )
}

function HotkeysSection() {  const client = useQueryClient()
  const { data } = useQuery(hotkeysQuery)
  const [editing, setEditing] = useState<HotkeyAction | null>(null)

  const hotkeys: Partial<Record<HotkeyAction, string>> = data ?? {}

  return (
    <Section icon={<Keyboard className="h-4 w-4" />} title="Hotkeys">
      <div className="space-y-2">
        {HOTKEY_ROWS.map(({ action, label }) => (
          <div key={action} className="flex items-center justify-between gap-4">
            <span className="text-[13px] font-medium">{label}</span>
            <HotkeyChip hotkey={hotkeys[action] ?? ''} onClick={() => setEditing(action)} />
          </div>
        ))}
        <p className="text-[11px] text-ink-faint">Click a hotkey to rebind it</p>
      </div>

      <HotkeyDialog
        action={editing}
        current={editing ? (hotkeys[editing] ?? '') : ''}
        onClose={() => setEditing(null)}
        onSaved={async () => {
          await client.invalidateQueries({ queryKey: hotkeysQuery.queryKey })
        }}
      />
    </Section>
  )
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

function VersionFooter() {
  const { data } = useQuery({
    queryKey: QK.appVersion,
    queryFn: async () => read(api.getAppVersion(), ''),
    staleTime: Infinity,
  })
  return <div className="pb-4 pt-2 text-center text-[11px] text-ink-faint">Rewind v{data}</div>
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

/**
 * Reveals the folders Rewind writes to, plus the process exclusion list.
 *
 * None of these take a path from the renderer. The app's own directories are
 * the only ones reachable here, which is why they are a separate handler from
 * `openFolder` rather than an extension of it.
 */
function DataSection() {
  const { runAction } = useBackgroundAction()

  const open = (run: () => Promise<IpcResult>) => {
    void runAction(async () => {
      const res = await run()
      if (!res.success) throw new Error(res.error)
    })
  }

  return (
    <Section icon={<Database className="h-4 w-4" />} title="Data">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => open(() => api.openAppFolder('data'))}>
          <FolderOpen className="h-3.5 w-3.5" />
          Open Data Directory
        </Button>
        <Button size="sm" onClick={() => open(() => api.openAppFolder('logs'))}>
          <FileText className="h-3.5 w-3.5" />
          Open Logs
        </Button>
        <Button size="sm" onClick={() => open(() => api.openExclusionList())}>
          <ListFilter className="h-3.5 w-3.5" />
          Open Exclusion List
        </Button>
      </div>
    </Section>
  )
}

/**
 * The settings sections, grouped the way the spine presents them.
 *
 * The old page was one column of every section in a fixed order. The spine view
 * renders one group at a time instead, so the sections are exposed as data: each
 * entry is the list of sections that belong under one spine item, in order.
 * Sections keep everything they need internally; the view supplies only the frame.
 */
export const SETTINGS_SECTIONS = {
  capture: [CaptureSection],
  audio: [AudioSection],
  encoder: [QualitySection],
  profiles: [ProfilesSection],
  // Storage owns every path and every door to the app's own files.
  storage: [ReplaysSection, ScreenshotsSection, DataSection],
  hotkeys: [HotkeysSection],
  system: [NotificationsSection, StartupSection, VersionFooter],
} as const

export type SettingsSectionId = keyof typeof SETTINGS_SECTIONS
