import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { api } from '../lib/api'
import { QK, bufferActiveQuery, configQuery, sourceNameQuery } from '../lib/queries'
import { useBackgroundAction, useObsStatus } from '../lib/context'
import { useClipEvents, useHeldSeconds } from '../lib/hooks'
import { Titlebar } from '../components/titlebar'
import { Deck } from '../components/deck'
import { Rail } from '../components/rail'
import { Button, cn } from '../components/ui'
type View = 'clips' | 'screenshots'

// The rail is a resizable column. Its width is a view preference, like the
// window's own bounds, so it lives in the renderer and survives restarts. The
// bounds keep the deck's control strip legible and the rail wide enough for a
// card; the ceiling is measured at drag time because the window can shrink.
const RAIL_DEFAULT = 340
const RAIL_MIN = 260
const RAIL_MAX = 480
const DECK_MIN = 460
const RAIL_STEP = 16
const RAIL_WIDTH_KEY = 'rewind.railWidth'

/** Stored rail width, or the default when nothing usable is stored. */
function readRailWidth(): number {
  try {
    const stored = Number(window.localStorage.getItem(RAIL_WIDTH_KEY))
    return Number.isFinite(stored) && stored > 0 ? stored : RAIL_DEFAULT
  } catch {
    return RAIL_DEFAULT
  }
}

/**
 * The rail width a window this wide can actually show. The deck's floor wins over
 * a fixed ceiling, so on a narrow window the rail gives way rather than the deck's
 * control strip crowding.
 */
function clampRail(width: number, total: number): number {
  const ceiling = Math.max(RAIL_MIN, Math.min(RAIL_MAX, total - DECK_MIN))
  return Math.round(Math.min(Math.max(width, RAIL_MIN), ceiling))
}

/** Unwraps an IPC envelope, throwing its error so callers can catch uniformly. */
async function expect<T>(p: Promise<{ success: boolean; data?: T; error?: string; code?: string }>, fallback: string): Promise<T> {
  const res = await p
  // Carry the code through. `isRecoverable` (lib/context.tsx) offers a Retry for a
  // wedged engine, and a plain Error drops the one field that decision reads.
  if (!res.success) throw Object.assign(new Error(res.error || fallback), { code: res.code })
  return res.data as T
}

/**
 * The main window.
 *
 * Two panes under one custom bar: the capture deck on the left (fluid) and the
 * clips rail on the right (resizable, 340 by default). The divider between them
 * drags the split. Everything is local — Rewind has no account, no sync state and
 * no network calls.
 *
 * This component owns the state both panes share: the buffer, the save
 * gestures, the current media view and the last-saved timestamp the rail
 * animates from.
 */
export function MainView() {
  const client = useQueryClient()
  const { status, message } = useObsStatus()
  const { runAction } = useBackgroundAction()

  const [view, setView] = useState<View>('clips')
  const [isSaving, setIsSaving] = useState(false)
  const [isCapturing, setIsCapturing] = useState(false)
  const [lastSaved, setLastSaved] = useState<number | null>(null)
  const [bufferBusy, setBufferBusy] = useState(false)
  // The width the user chose is the preference; what is drawn is that preference
  // clamped to the window. Deriving rather than overwriting means a temporarily
  // narrow window (or a blip while it starts) cannot quietly eat the choice.
  const [preferredRail, setPreferredRail] = useState(readRailWidth)
  const [paneSpace, setPaneSpace] = useState(() => window.innerWidth)
  const [resizing, setResizing] = useState(false)
  const panesRef = useRef<HTMLDivElement | null>(null)

  const railWidth = clampRail(preferredRail, paneSpace)

  // Measured, not inferred: the row reports its own width and re-reports whenever
  // it changes, which is what keeps the split inside the current window.
  useEffect(() => {
    const el = panesRef.current
    if (!el) return
    const measure = () => setPaneSpace(el.clientWidth || window.innerWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // The drag listens on the window, not the handle, so the pointer may leave the
  // 8px strip without the split stalling.
  const startRailDrag = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      const startX = e.clientX
      const startWidth = railWidth
      setResizing(true)
      const move = (ev: PointerEvent) =>
        setPreferredRail(clampRail(startWidth - (ev.clientX - startX), paneSpace))
      const stop = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', stop)
        window.removeEventListener('pointercancel', stop)
        setResizing(false)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', stop)
      window.addEventListener('pointercancel', stop)
    },
    [railWidth, paneSpace],
  )

  const nudgeRail = useCallback(
    (delta: number) => setPreferredRail(clampRail(railWidth + delta, paneSpace)),
    [railWidth, paneSpace],
  )

  // Remembered across restarts; a preference we cannot store is not worth an error.
  useEffect(() => {
    try {
      window.localStorage.setItem(RAIL_WIDTH_KEY, String(preferredRail))
    } catch {
      /* no storage: the default stands */
    }
  }, [preferredRail])

  // While dragging, the split owns the cursor and nothing underneath may select.
  useEffect(() => {
    if (!resizing) return
    const previous = document.body.style.userSelect
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    return () => {
      document.body.style.userSelect = previous
      document.body.style.cursor = ''
    }
  }, [resizing])

  const { data: config } = useQuery(configQuery)
  const { data: source } = useQuery(sourceNameQuery)
  const { data: bufferState } = useQuery(bufferActiveQuery)
  const bufferActive = bufferState?.active ?? false

  useClipEvents(() => setLastSaved(Date.now()))

  const saveClip = useCallback(() => {
    if (isSaving) return
    setIsSaving(true)
    void runAction(async () => {
      try {
        await expect(api.saveReplay(), 'Failed to save clip')
        setLastSaved(Date.now())
      } finally {
        setIsSaving(false)
      }
    })
  }, [isSaving, runAction])

  const takeScreenshot = useCallback(() => {
    if (isCapturing) return
    setIsCapturing(true)
    void runAction(async () => {
      try {
        await expect(api.takeScreenshot(), 'Failed to take screenshot')
      } finally {
        setIsCapturing(false)
      }
    })
  }, [isCapturing, runAction])

  // Both handlers go through one call so the button and the state can never
  // disagree: the query is refetched from the engine's own answer rather than
  // from an optimistic guess.
  const setBuffer = useCallback(
    async (active: boolean) => {
      if (bufferBusy) return
      setBufferBusy(true)
      try {
        await runAction(async () => {
          const res = await api.setReplayBufferActive(active)
          if (!res.success) throw new Error(res.error)
        })
      } finally {
        await client.invalidateQueries({ queryKey: ['buffer-active'] })
        setBufferBusy(false)
      }
    },
    [bufferBusy, runAction, client],
  )

  // Changes the rolling window. The deck's limit chips call this once per click,
  // and the config query is refetched so the strip shows what the engine accepted.
  const setBufferSeconds = useCallback(
    async (seconds: number) => {
      await runAction(async () => {
        const res = await api.setBufferDuration(seconds)
        if (!res.success) throw new Error(res.error)
      })
      await client.invalidateQueries({ queryKey: QK.config })
    },
    [runAction, client],
  )

  const openFolder = useCallback(() => {
    void runAction(async () => {
      const res = await api.openFolder()
      if (!res.success) throw new Error(res.error)
    })
  }, [runAction])

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <Titlebar />

      <div ref={panesRef} className="flex min-h-0 flex-1">
        {/* The deck: the buffer dial, the capture actions and the buffer limit. */}
        <div data-testid="deck-pane" className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <Deck
            bufferActive={bufferActive}
            bufferBusy={bufferBusy}
            startedAt={bufferState?.startedAt ?? 0}
            duration={config?.bufferDuration ?? 60}
            saving={isSaving}
            capturing={isCapturing}
            pulseKey={lastSaved ?? 0}
            sourceName={source?.name ?? ''}
            onToggleBuffer={() => void setBuffer(!bufferActive)}
            onSaveClip={saveClip}
            onScreenshot={takeScreenshot}
            onSetBufferSeconds={setBufferSeconds}
          />

          {status === 'error' ? (
            <div className="mx-3 mb-2 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="text-[12px] font-medium text-danger">Recording not ready</p>
                <p className="text-[11px] text-ink-muted">{message ?? 'Recording failed to start'}</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void runAction(async () => {
                    const res = await api.retryOBSInit()
                    if (!res.success) throw new Error(res.error)
                  })
                }
              >
                Retry
              </Button>
            </div>
          ) : null}
        </div>

        {/* The divider: drag it to trade width between the deck and the rail. */}
        <div
          data-testid="pane-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the clips panel"
          aria-valuenow={railWidth}
          aria-valuemin={RAIL_MIN}
          aria-valuemax={RAIL_MAX}
          tabIndex={0}
          title="Drag to resize · double-click to reset"
          onPointerDown={startRailDrag}
          onDoubleClick={() => setPreferredRail(RAIL_DEFAULT)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') {
              e.preventDefault()
              nudgeRail(RAIL_STEP)
            } else if (e.key === 'ArrowRight') {
              e.preventDefault()
              nudgeRail(-RAIL_STEP)
            } else if (e.key === 'Home') {
              e.preventDefault()
              setPreferredRail(RAIL_DEFAULT)
            }
          }}
          className="group relative flex w-2 shrink-0 cursor-col-resize items-center justify-center outline-none focus-visible:bg-accent/5"
        >
          {/* The line itself, lit while the pointer is on it or a drag is running. */}
          <span
            aria-hidden="true"
            className={cn(
              'pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors',
              resizing ? 'bg-accent' : 'bg-line group-hover:bg-line-strong group-focus-visible:bg-accent/60',
            )}
          />
          {/* A grip, so the divider reads as something you can take hold of. */}
          <span
            aria-hidden="true"
            className={cn(
              'pointer-events-none absolute left-1/2 top-1/2 h-8 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full transition-opacity',
              resizing
                ? 'bg-accent opacity-100'
                : 'bg-line-strong opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100',
            )}
          />
        </div>

        {/* The rail: the only scrolling column in the panel. */}
        <aside
          data-testid="rail-pane"
          style={{ width: railWidth }}
          className="flex shrink-0 flex-col overflow-hidden px-3 pb-3 pt-2"
        >
          <Rail
            view={view}
            onViewChange={setView}
            onOpenFolder={openFolder}
            lastSavedAt={lastSaved}
            railWidth={railWidth}
          />
        </aside>
      </div>

      <StatusStrip
        status={status}
        message={message}
        bufferActive={bufferActive}
        bufferStartedAt={bufferState?.startedAt ?? 0}
        bufferSeconds={config?.bufferDuration ?? 60}
      />

      {/* Fixed wash over everything; never inside a scrolling column. */}
      <div className="grain" aria-hidden="true" />
    </div>
  )
}

/** One line of engine state, kept out of the way at the bottom of the panel. */
function StatusStrip({
  status,
  message,
  bufferActive,
  bufferStartedAt,
  bufferSeconds,
}: {
  status: string
  message?: string
  bufferActive: boolean
  bufferStartedAt: number
  bufferSeconds: number
}) {
  // The same number the dial shows, from the same implementation (lib/hooks.ts), so
  // the two cannot disagree about how much footage is held right now.
  const held = useHeldSeconds(bufferActive, bufferStartedAt, bufferSeconds)
  const full = held >= bufferSeconds

  return (
    <div className="flex h-9 shrink-0 items-center justify-center gap-3 border-t border-line px-3 text-[13px] text-ink-muted">
      {status === 'initializing' ? (
        <span className="flex items-center gap-1.5">
          <Loader2 className="h-2.5 w-2.5 animate-spin" />
          {message ?? 'Starting engine…'}
        </span>
      ) : status === 'paused' ? (
        'Buffer paused'
      ) : status === 'saving' ? (
        <span className="flex items-center gap-1.5">
          <Loader2 className="h-2.5 w-2.5 animate-spin" />
          {message ?? 'Saving clip…'}
        </span>
      ) : status === 'ready' ? (
        <span className="flex items-center gap-3">
          <span
            className="flex items-center gap-1.5"
            title={`${held} of ${bufferSeconds} seconds of footage recoverable`}
          >
            <span className={cn('h-2 w-2 rounded-full', full ? 'bg-danger' : 'bg-ink-muted')} />
            <span className="tabular font-medium text-ink">
              {held}s of {bufferSeconds}s buffered
            </span>
          </span>
        </span>
      ) : status === 'error' ? (
        <span className="text-danger">{message ?? 'Engine not ready'}</span>
      ) : null}
    </div>
  )
}
