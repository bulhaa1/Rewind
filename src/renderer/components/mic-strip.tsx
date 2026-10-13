import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Mic } from 'lucide-react'
import { api, read } from '../lib/api'
import { useBackgroundAction } from '../lib/context'
import { cn } from './ui'
import type { AudioDevice } from '@shared/types.js'

/**
 * Microphone strip.
 *
 * The deck's own microphone control: the device in use, a volume fader and a mute
 * toggle. Settings has the same two controls, but the moment you need them is
 * while capturing, not three screens away.
 *
 * Deliberately compact and deliberately without a level meter: the row is a
 * control, not an instrument, and a meter that only moves when someone speaks
 * into the microphone reads as a broken widget the rest of the time.
 */
export function MicStrip() {
  const client = useQueryClient()
  const { runAction } = useBackgroundAction()
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

  const muted = levels?.microphone.muted ?? false
  const volume = levels?.microphone.volume ?? 1
  const shown = drag ?? (muted ? 0 : volume)
  const percent = Math.round(shown * 100)

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
      className="flex items-center gap-2.5 rounded-md border border-line bg-raised px-2.5 py-1.5"
    >
      <Mic
        className={cn('h-3.5 w-3.5 shrink-0', muted ? 'text-ink-faint' : 'text-accent')}
        strokeWidth={1.5}
        aria-hidden
      />

      <span className="w-[88px] shrink-0 truncate text-[12px] text-ink" title={device ?? 'Default'}>
        {device ?? 'Default'}
      </span>

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

      <span className="tabular w-8 shrink-0 text-right text-[11px] text-ink-faint">{muted ? 'muted' : `${percent}%`}</span>

      <button
        type="button"
        role="switch"
        aria-checked={!muted}
        aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
        onClick={toggleMute}
        className={cn(
          'relative h-4 w-7 shrink-0 rounded-full transition-colors',
          muted ? 'bg-line-strong' : 'bg-accent',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 h-3 w-3 rounded-full bg-white transition-[left]',
            muted ? 'left-0.5' : 'left-[14px]',
          )}
        />
      </button>
    </div>
  )
}
