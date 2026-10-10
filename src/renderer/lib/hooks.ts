import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'

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
export function usePopupWindow(): { type: string; onClick: () => void } | null {
  const [state, setState] = useState<{ type: string; onClick: () => void } | null>(null)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const type = params.get('notification')
    if (!type) return

    setState({ type, onClick: () => void api.notificationClick() })
  }, [])

  return state
}

/** Reads the editor window's clip path from its query string. */
export function useEditorClipPath(): string | null {
  return useMemoOnce(() => {
    const params = new URLSearchParams(window.location.search)
    return params.get('editor') === '1' ? params.get('clipPath') : null
  }, null)
}

function useMemoOnce<T>(fn: () => T, _dep: unknown): T {
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
  const client = useQueryClient()

  // Held in a ref rather than a dependency. Callers pass an inline arrow, so
  // depending on it tore down and rebuilt both IPC subscriptions on every render
  // of a panel that re-renders on a two-second poll.
  const saved = useRef(onClipSaved)
  useEffect(() => {
    saved.current = onClipSaved
  }, [onClipSaved])

  useEffect(() => {
    const unsubscribes = [
      api.on('clip-saved', () => {
        saved.current?.()
        void client.invalidateQueries({ queryKey: ['clips'] })
      }),
      api.on('screenshot-saved', () => void client.invalidateQueries({ queryKey: ['screenshots'] })),
    ]
    return () => unsubscribes.forEach((fn) => fn())
  }, [client])
}