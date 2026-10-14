import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Mic, MicOff } from 'lucide-react'
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
 * width: the control reads top to bottom as mute, level.
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
  // The icon reports effective silence, not just the flag: a fader dragged to
  // zero is a muted microphone to anyone reading it, and muting it also shows 0.
  const silent = muted || shown === 0
  const MuteIcon = silent ? MicOff : Mic
  // At the floor the action is "give me sound back", not "mute what is already
  // silent", so the label follows the silence, not the stored flag.
  const muteActionLabel = silent && !muted ? 'Raise microphone volume' : muted ? 'Unmute microphone' : 'Mute microphone'

  /**
   * Commits a drag and only then releases the local value.
   *
   * Clearing `drag` first is what made the fader flicker: for the length of the
   * round trip the stored volume was still the old one, so the thumb snapped back
   * and then jumped forward again. Holding the dragged value until the refetch has
   * landed means the hand-off is between two equal numbers.
   */
  const commit = useCallback(
    async (value: number) => {
      await runAction(async () => {
        const res = await api.setChannelVolume('microphone', value)
        if (!res.success) throw new Error(res.error)
      })
      await client.invalidateQueries({ queryKey: ['audio-levels'] })
      setDrag(null)
    },
    [client, runAction],
  )

  // The latest dragged value, so the release listener below can stay installed.
  const dragRef = useRef<number | null>(null)
  dragRef.current = drag

  /*
   * One release path for pointer and keyboard alike, on the window rather than the
   * track: a drag that ends outside the fader still saves, and there is exactly one
   * place that commits, so no double write.
   */
  useEffect(() => {
    const release = () => {
      const value = dragRef.current
      if (value !== null) void commit(value)
    }
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
    window.addEventListener('keyup', release)
    return () => {
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
      window.removeEventListener('keyup', release)
    }
  }, [commit])

  const toggleMute = () => {
    // At the floor the icon reports silence, and the label promises sound back.
    // Muting an already-silent microphone would do the opposite of what it says, so
    // the button restores the level instead.
    if (silent && !muted) {
      void runAction(async () => {
        const res = await api.setChannelVolume('microphone', 1)
        if (!res.success) throw new Error(res.error)
      }).then(() => client.invalidateQueries({ queryKey: ['audio-levels'] }))
      return
    }
    void runAction(async () => {
      const res = await api.setChannelMuted('microphone', !muted)
      if (!res.success) throw new Error(res.error)
    }).then(() => client.invalidateQueries({ queryKey: ['audio-levels'] }))
  }

  return (
    <div
      data-testid="mic-strip"
      title={device ? `Microphone: ${device}` : 'Microphone'}
      className="ml-auto flex w-9 shrink-0 flex-col items-center gap-2 rounded-md border border-line bg-canvas px-1.5 py-2"
    >
      <button
        type="button"
        onClick={toggleMute}
        aria-pressed={silent}
        aria-label={muteActionLabel}
        title={muteActionLabel}
        className={cn(
          'flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors hover:bg-raised',
          silent && !muted && 'opacity-70',
        )}
      >
        <MuteIcon
          className={cn('h-3.5 w-3.5', muted ? 'text-ink-faint' : 'text-accent')}
          strokeWidth={1.5}
          aria-hidden
        />
      </button>

      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={shown}
        aria-label={device ? `Microphone volume (${device})` : 'Microphone volume'}
        onChange={(e) => setDrag(Number(e.target.value))}
        // Chromium's supported way to lay a range out vertically: the track runs
        // down the block axis, and `direction: rtl` puts the loud end at the top.
        style={{ writingMode: 'vertical-lr', direction: 'rtl' }}
        className="h-20 w-1.5 shrink-0 cursor-pointer appearance-none rounded-full bg-line-strong accent-accent"
      />
    </div>
  )
}
