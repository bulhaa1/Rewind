import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Mic, VolumeX } from 'lucide-react'
import { api, read } from '../lib/api'
import { useBackgroundAction } from '../lib/context'
import { cn } from './ui'
import type { AudioDevice } from '@shared/types.js'

/**
 * Microphone strip.
 *
 * A narrow vertical column that sits at the right-hand end of the deck's dial row,
 * where the panel is widest and the space beside the capture line is otherwise
 * empty. Vertical is what makes it fit there without competing with the dial for
 * width: the control reads top to bottom as mute, device, level, value.
 *
 * The microphone glyph is the mute control -- a switch of its own would be a
 * second element for a state the icon already shows, and the column is meant to be
 * small. It reads as a microphone when live and as a struck-through one when muted.
 *
 * Deliberately without a level meter: this is a control, not an instrument, and a
 * meter that only moves when someone speaks into the microphone reads as a broken
 * widget the rest of the time.
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
  const MuteIcon = muted ? VolumeX : Mic

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
      className="ml-auto flex w-12 shrink-0 flex-col items-center gap-1.5 rounded-md border border-line bg-canvas px-1.5 py-2"
    >
      <button
        type="button"
        onClick={toggleMute}
        aria-pressed={muted}
        aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
        title={muted ? 'Unmute microphone' : 'Mute microphone'}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors hover:bg-raised"
      >
        <MuteIcon
          className={cn('h-3.5 w-3.5', muted ? 'text-ink-faint' : 'text-accent')}
          strokeWidth={1.5}
          aria-hidden
        />
      </button>

      <span className="w-full truncate text-center text-[10px] text-ink-faint" title={device ?? 'Default'}>
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
        // Chromium's supported way to lay a range out vertically: the track runs
        // down the block axis, and `direction: rtl` puts the loud end at the top.
        style={{ writingMode: 'vertical-lr', direction: 'rtl' }}
        className="h-12 w-1.5 shrink-0 cursor-pointer appearance-none rounded-full bg-line-strong accent-accent"
      />

      <span className="tabular text-[10px] text-ink-faint">{muted ? 'muted' : `${percent}%`}</span>
    </div>
  )
}
