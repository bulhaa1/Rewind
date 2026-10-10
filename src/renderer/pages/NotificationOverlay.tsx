import { useEffect, useState } from 'react'
import { Check, CircleAlert, Loader2 } from 'lucide-react'
import { cn } from '../components/ui'
import type { BufferStatus } from '@shared/types.js'

/** How long the popup stays up, before its exit transition begins. */
const LIFETIME_MS = 3400

/** Presentation per notification kind. `error` is the odd one out visually. */
const CONTENT: Record<BufferStatus, { title: string; tone: 'ok' | 'error' }> = {
  saved: { title: 'Clip saved', tone: 'ok' },
  screenshot: { title: 'Screenshot saved', tone: 'ok' },
  error: { title: 'Something went wrong', tone: 'error' },
  recorded: { title: 'Recording', tone: 'ok' },
  'buffer-on': { title: 'Recording started', tone: 'ok' },
  'buffer-off': { title: 'Recording paused', tone: 'ok' },
}

/**
 * The transient popup shown after saving a clip or taking a screenshot.
 *
 * Rendered into its own transparent always-on-top panel window so it can sit over
 * games. Clicking it raises the main panel; the main process closes the window
 * after a fixed lifetime regardless.
 */
export function NotificationOverlay({ type, onClick }: { type: string; onClick: () => void }) {
  const content = CONTENT[type as BufferStatus] ?? CONTENT.saved
  const [leaving, setLeaving] = useState(false)

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
        <span className="block text-sm font-medium">{content.title}</span>
        <span className="block truncate text-xs text-ink-muted">
          {type === 'screenshot' ? 'Saved to your screenshots folder' : 'Saved to your replays folder'}
        </span>
      </span>

      <Loader2 className="h-3 w-3 shrink-0 animate-spin text-ink-muted/40" />
    </button>
  )
}