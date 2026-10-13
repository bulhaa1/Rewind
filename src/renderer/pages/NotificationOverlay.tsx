import { useEffect, useState } from 'react'
import { Check, CircleAlert, Loader2 } from 'lucide-react'
import { cn } from '../components/ui'
import type { BufferStatus } from '@shared/types.js'

/** How long the popup stays up, before its exit transition begins. */
const LIFETIME_MS = 3400

/**
 * Presentation per notification kind.
 *
 * `subtitle` is the fallback shown when the main process sent no `message`.
 * It used to be a single hardcoded ternary on `type === 'screenshot'`, which
 * meant every other kind -- including `error` -- claimed the clip was saved.
 */
const CONTENT: Record<BufferStatus, { title: string; subtitle: string; tone: 'ok' | 'error' }> = {
  saved: { title: 'Clip saved', subtitle: 'Saved to your replays folder', tone: 'ok' },
  screenshot: { title: 'Screenshot saved', subtitle: 'Saved to your screenshots folder', tone: 'ok' },
  error: { title: 'Something went wrong', subtitle: '', tone: 'error' },
  recorded: { title: 'Recording', subtitle: 'Saved to your replays folder', tone: 'ok' },
  'buffer-on': { title: 'Recording started', subtitle: 'Buffer is rolling', tone: 'ok' },
  'buffer-off': { title: 'Recording paused', subtitle: 'Buffer is not rolling', tone: 'ok' },
}

/**
 * The transient popup shown after saving a clip or taking a screenshot.
 *
 * Rendered into its own transparent always-on-top panel window so it can sit over
 * games. Clicking it raises the main panel; the main process closes the window
 * after a fixed lifetime regardless.
 */
export function NotificationOverlay({
  type,
  message,
  title,
  onClick,
}: {
  type: string
  message?: string | null
  /** Action + key when a hotkey drove this popup; replaces the kind's heading. */
  title?: string | null
  onClick: () => void
}) {
  const content = CONTENT[type as BufferStatus] ?? CONTENT.saved
  const [leaving, setLeaving] = useState(false)

  /*
   * A hotkey popup names the action and its key ("Clip saved — Alt + 1"), which
   * is the heading the user needs; the kind's own title stays as the fallback for
   * panel-driven popups.
   */
  const heading = (title ?? '').trim() || content.title

  /*
   * The main process puts a real diagnostic in the URL as `&message=...`
   * (`notification.ts:132`) -- "Recording not ready", "Failed to save clip",
   * "Recording stopped responding". It was never read, so every error popup read
   * "Something went wrong" with no explanation. Prefer it; fall back to the
   * kind's own subtitle, which for `error` is deliberately empty rather than a
   * claim that something was saved.
   */
  const detail = (message ?? '').trim() || content.subtitle

  /*
    The exit transition belongs here rather than on `beforeunload`. Setting a flag
    in `beforeunload` schedules a React render, but the window is being torn down in
    the same tick — so the animation never got a frame and the popup simply blinked
    out. Holding the window for the length of the transition lets it finish.
  */
  const close = () => {
    setLeaving(true)
    setTimeout(() => window.close(), 200)
  }

  useEffect(() => {
    const timer = setTimeout(close, LIFETIME_MS)
    return () => clearTimeout(timer)
  }, [])

  return (
    <button
      type="button"
      onClick={() => {
        onClick()
        close()
      }}
      className={cn(
        'flex h-full w-full items-center gap-3 rounded-lg border px-4 text-left shadow-[var(--shadow-raise)] backdrop-blur-md transition-all duration-200',
        content.tone === 'error'
          ? 'border-danger/40 bg-danger/15'
          : 'border-accent/30 bg-surface/95',
        leaving ? 'translate-y-1 opacity-0' : 'translate-y-0 opacity-100',
      )}
    >
      <span
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
          content.tone === 'error' ? 'bg-danger/20 text-danger' : 'bg-accent/20 text-accent',
        )}
      >
        {content.tone === 'error' ? <CircleAlert className="h-4 w-4" /> : <Check className="h-4 w-4" />}
      </span>

      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{heading}</span>
        {detail ? <span className="block truncate text-xs text-ink-muted">{detail}</span> : null}
      </span>

      <Loader2 className="h-3 w-3 shrink-0 animate-spin text-ink-muted/40" />
    </button>
  )
}