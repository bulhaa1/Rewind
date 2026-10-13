import { useCallback, useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { api } from '../lib/api'
import { QK, bufferActiveQuery, configQuery, sourceNameQuery } from '../lib/queries'
import { useBackgroundAction, useObsStatus } from '../lib/context'
import { useClipEvents } from '../lib/hooks'
import { Titlebar } from '../components/titlebar'
import { Deck } from '../components/deck'
import { Rail } from '../components/rail'
import { Button, cn } from '../components/ui'
type View = 'clips' | 'screenshots'

/** Unwraps an IPC envelope, throwing its error so callers can catch uniformly. */
async function expect<T>(p: Promise<{ success: boolean; data?: T; error?: string }>, fallback: string): Promise<T> {
  const res = await p
  if (!res.success) throw new Error(res.error || fallback)
  return res.data as T
}

/**
 * The main window.
 *
 * Two panes under one custom bar: the capture deck on the left (fluid) and the
 * clips rail on the right (fixed 340px). Everything is local — Rewind has no
 * account, no sync state and no network calls.
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

      <div className="flex min-h-0 flex-1">
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

        {/* The rail: fixed width, and the only scrolling column in the panel. */}
        <aside
          data-testid="rail-pane"
          className="flex w-[340px] shrink-0 flex-col overflow-hidden border-l border-line px-3 pb-3 pt-2"
        >
          <Rail view={view} onViewChange={setView} onOpenFolder={openFolder} lastSavedAt={lastSaved} />
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
  // Counts seconds of footage that are recoverable right now, which is how long
  // ago the buffer started, capped at its length -- once it is full the oldest
  // footage falls out, so the number stops climbing there rather than running on.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!bufferActive) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [bufferActive])

  const held =
    bufferActive && bufferStartedAt
      ? Math.min(Math.max(Math.floor((now - bufferStartedAt) / 1000), 0), bufferSeconds)
      : 0
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
          Saving clip…
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
