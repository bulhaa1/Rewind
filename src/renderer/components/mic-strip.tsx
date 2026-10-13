import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Mic } from 'lucide-react'
import { api, read } from '../lib/api'
import { useBackgroundAction } from '../lib/context'
import { cn } from './ui'
import type { AudioDevice } from '@shared/types.js'

/**
 * Microphone strip.
 *
 * The deck's own microphone control: a live input meter, the device in use, a
 * volume fader and a mute toggle. Settings has the same two controls, but the
 * moment you need them is while capturing, not three screens away.
 *
 * The meter is OBS's own volume meter (see src/main/volmeter.ts), so it shows
 * what the recording hears rather than what the device claims. Levels arrive at
 * the binding's best-effort 250 ms cadence; the bar smooths between updates.
 */

/** Linear amplitude to a meter position: -60 dB is the floor, 0 dB the top. */
function meterPercent(amplitude: number): number {
  if (!(amplitude > 0)) return 0
  const db = 20 * Math.log10(amplitude)
  return Math.max(0, Math.min(100, ((db + 60) / 60) * 100))
}

export function MicStrip() {
  const client = useQueryClient()
  const { runAction } = useBackgroundAction()
  const [peak, setPeak] = useState(0)
  const [drag, setDrag] = useState<number | null>(null)

  const { data: levels } = useQuery({
    queryKey: ['audio-levels'],
    queryFn: () =>
      read(api.getAudioLevels(), { desktop: { volume: 1, muted: false }, microphone: { volume: 1, muted: false } }),
    retry: false,
  })

  const { data: device } = useQuery({
    queryKey: ['mic-device-label'],
    queryFn: async () => {
      const [devices, channels] = await Promise.all([api.getAudioDevices(), api.getChannelDevices()])
      if (!devices.success || !channels.success) return 'Default'
      const bound = (channels.data as Record<string, string> | undefined)?.['microphone'] ?? 'default'
      const found = (devices.data as AudioDevice[] | undefined)?.find((d) => d.id === bound)
      // "Default" is what the user picked; the endpoint name is what Windows
      // resolved it to. Showing the endpoint would read as a device they never
      // chose, so the pick is what is shown.
      return bound === 'default' || found?.isSystemDefault ? 'Default' : (found?.label ?? 'Default')
    },
    retry: false,
  })

  // The level only exists while the panel is visible: main attaches the meter on
  // show and detaches it on hide.
  useEffect(() => api.on('mic-level', (l) => setPeak(l.peak)), [])

  const muted = levels?.microphone.muted ?? false
  const volume = levels?.microphone.volume ?? 1
  const shown = drag ?? (muted ? 0 : volume)
  const percent = Math.round(shown * 100)
  const level = muted ? 0 : meterPercent(peak)

  const commit = () => {
    if (drag === null) return
    const value = drag
    setDrag(null)
    void runAction(async () => {
      const res = await api.setChannelVolume('microphone', value)
      if (!res.success) throw new Error(res.error)
    }).then(() => client.invalidateQueries({ queryKey: ['audio-levels'] }))
  }

  const toggleMute = () => {
    void runAction(async () => {
      const res = await api.setChannelMuted('microphone', !muted)
      if (!res.success) throw new Error(res.error)
    }).then(() => client.invalidateQueries({ queryKey: ['audio-levels'] }))
  }

  return (
    <div
      data-testid="mic-strip"
      className="flex items-center gap-3 rounded-lg border border-line bg-raised px-3 py-2"
    >
      <div className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-canvas">
        <Mic className={cn('h-4 w-4', muted ? 'text-ink-faint' : 'text-accent')} strokeWidth={1.5} />
        <span className="absolute inset-x-1 bottom-[3px] h-[3px] overflow-hidden rounded-full bg-line">
          <span
            className="block h-full rounded-full bg-accent transition-[width] duration-150 ease-out"
            style={{ width: `${level}%` }}
          />
        </span>
      </div>

      <div className="w-[104px] shrink-0">
        <p className="text-[10px] uppercase tracking-wide text-ink-faint">microphone / input</p>
        <p className="truncate text-[12px] text-ink" title={device ?? 'Default'}>
          {device ?? 'Default'}
        </p>
      </div>

      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={shown}
        aria-label="Microphone volume"
        onChange={(e) => setDrag(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        className="h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-line-strong accent-accent"
      />

      <span className="tabular w-9 shrink-0 text-right text-[11px] text-ink-faint">{muted ? 'muted' : `${percent}%`}</span>

      <button
        type="button"
        role="switch"
        aria-checked={!muted}
        aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
        onClick={toggleMute}
        className={cn(
          'relative h-5 w-9 shrink-0 rounded-full transition-colors',
          muted ? 'bg-line-strong' : 'bg-accent',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 h-4 w-4 rounded-full bg-white transition-[left]',
            muted ? 'left-0.5' : 'left-[18px]',
          )}
        />
      </button>
    </div>
  )
}
