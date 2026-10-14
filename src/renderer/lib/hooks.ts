import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { QK } from '../lib/queries'

/**
 * Two-note sine chime, synthesised with WebAudio.
 *
 * Synthesised rather than shipped as an asset so there is no binary to load and
 * no decode latency between the event and the sound.
 */
export function playNotificationSound(): void {
  try {
    const Ctx = window.AudioContext ?? (window as any).webkitAudioContext
    if (!Ctx) return

    const ctx = new Ctx()
    const now = ctx.currentTime

    const blip = (frequency: number, offset: number, duration: number, peak: number) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(frequency, now + offset)
      // Short attack then exponential decay reads as a clean "ding" rather than a click.
      gain.gain.setValueAtTime(0, now + offset)
      gain.gain.linearRampToValueAtTime(peak, now + offset + 0.005)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + duration)
      osc.connect(gain).connect(ctx.destination)
      osc.start(now + offset)
      osc.stop(now + offset + duration)
    }

    blip(1046.5, 0, 0.35, 0.18)
    blip(1568, 0.06, 0.45, 0.14)

    setTimeout(() => void ctx.close().catch(() => {}), 700)
  } catch {
    /* audio unavailable; the visual notification still fired */
  }
}

/** Subscribes to the notification-sound event for the lifetime of the app. */
export function useNotificationSound(): void {
  useEffect(() => api.on('play-notification-sound', playNotificationSound), [])
}
/**
 * Wires the notification popup window's close behaviour.
 *
 * A popup window is opened with `?notification=<type>`; it owns its own lifetime
 * and closes itself, returning focus to the main panel on click. The timer that
 * used to live here raced the window teardown and cut the exit animation short.
 */
export function usePopupWindow(): { type: string; message: string | null; title: string | null; onClick: () => void } | null {
  /*
   * Resolved synchronously, like `useEditorClipPath` below, and for the same
   * reason. `App.tsx` states the popup must be known before the main panel
   * mounts; resolving in an effect meant `Surface` returned the panel on the
   * first render, so a 280x110 transparent popup briefly mounted the whole clip
   * library -- firing six queries on the way past.
   */
  return useMemoOnce(() => {
    const params = new URLSearchParams(window.location.search)
    const type = params.get('notification')
    if (!type) return null
    return {
      type,
      // The main process has always sent this; it was simply never read, so
      // every error popup showed a generic title and no explanation.
      message: params.get('message'),
      // The action and its key, when a hotkey drove the notification.
      title: params.get('title'),
      onClick: () => void api.notificationClick(),
    }
  })
}

/** Reads the editor window's clip path from its query string. */
export function useEditorClipPath(): string | null {
  return useMemoOnce(() => {
    const params = new URLSearchParams(window.location.search)
    return params.get('editor') === '1' ? params.get('clipPath') : null
  })
}

/** Memoised without a dependency list: both callers read the URL, which cannot change. */
function useMemoOnce<T>(fn: () => T): T {
  const ref = useRef<{ value: T } | null>(null)
  if (ref.current === null) ref.current = { value: fn() }
  return ref.current.value
}

/**
 * Invalidates library queries when the main process reports a change.
 *
 * Main is the authority on when files change (a hotkey can save a clip while the
 * panel is backgrounded), so we subscribe rather than poll.
 */
export function useClipEvents(onClipSaved?: () => void): void {
  // Held in a ref rather than a dependency. Callers pass an inline arrow, so
  // depending on it tore down and rebuilt the subscription on every render of a
  // panel that re-renders on a two-second poll.
  const saved = useRef(onClipSaved)
  useEffect(() => {
    saved.current = onClipSaved
  }, [onClipSaved])

  useEffect(() => {
    // Only the callback lives here. Invalidating the lists for this event is
    // useLibraryInvalidation's job (lib/context.tsx); both doing it meant every save
    // refetched the same two queries twice.
    return api.on('clip-saved', () => saved.current?.())
  }, [])
}

/**
 * Refreshes the panel when a profile is switched from outside it.
 *
 * The hotkey switches profiles in the main process, and the panel spends most of its
 * life hidden to the tray rather than unmounted, so without this the deck keeps
 * highlighting the old chip and clicking the one that looks active does nothing.
 */
export function useProfileEvents(): void {
  const client = useQueryClient()
  useEffect(
    () =>
      api.on('profiles-changed', () => {
        void client.invalidateQueries({ queryKey: QK.profiles })
        // The switch changes fps, quality and buffer length, so anything reading them
        // is stale too: the deck's limit control, the dial, the encoder section.
        void client.invalidateQueries({ queryKey: QK.config })
        void client.invalidateQueries({ queryKey: QK.setting('bufferDuration') })
        void client.invalidateQueries({ queryKey: QK.setting('fps') })
        void client.invalidateQueries({ queryKey: QK.setting('visualQuality') })
      }),
    [client],
  )
}

/**
 * Seconds of footage the buffer is holding, capped at its length.
 *
 * Once the window is full the oldest footage falls out, so the number stops climbing
 * there instead of running on past it. One implementation, so the dial and the status
 * strip cannot show two different numbers for the same moment.
 */
export function useHeldSeconds(active: boolean, startedAt: number, duration: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])
  if (!active || !startedAt) return 0
  return Math.min(Math.max(Math.floor((now - startedAt) / 1000), 0), duration)
}