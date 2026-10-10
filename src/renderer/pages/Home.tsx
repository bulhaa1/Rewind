import { useCallback, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { api } from '../lib/api'
import { QK, bufferActiveQuery, clipsQuery, configQuery, screenshotsQuery, sourceNameQuery } from '../lib/queries'
import { useBackgroundAction, useObsStatus } from '../lib/context'
import { useClipEvents } from '../lib/hooks'
import { Header } from '../components/layout'
import { CaptureControls } from '../components/capture'
import { ClipList, ScreenshotList } from '../components/library'
import { Button, Dialog } from '../components/ui'
import type { DeleteScope } from '@shared/types.js'

type View = 'clips' | 'screenshots'

/** Unwraps an IPC envelope, throwing its error so callers can catch uniformly. */
async function expect<T>(p: Promise<{ success: boolean; data?: T; error?: string }>, fallback: string): Promise<T> {
  const res = await p
  if (!res.success) throw new Error(res.error || fallback)
  return res.data as T
}

/**
 * The main panel.
 *
 * Three bands: capture controls, the media library, and a status strip. Everything
 * is local — Rewind has no account, no sync state and no network calls.
 */
export function HomePage() {
  const client = useQueryClient()
  const { status, message } = useObsStatus()
  const { runAction } = useBackgroundAction()

  const [view, setView] = useState<View>('clips')
  const [isSaving, setIsSaving] = useState(false)
  const [isCapturing, setIsCapturing] = useState(false)
  const [lastSaved, setLastSaved] = useState<number | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<{ path: string; name: string } | null>(null)
  const [bufferBusy, setBufferBusy] = useState(false)

  const { data: config } = useQuery(configQuery)
  const { data: source } = useQuery(sourceNameQuery)
  const { data: bufferState } = useQuery(bufferActiveQuery)
  const bufferActive = bufferState?.active ?? false
  const bufferStartedAt = bufferState?.startedAt ?? 0

  const bufferSeconds = config?.bufferDuration ?? 60

  const { data: clips = [], isPending: clipsPending } = useQuery(clipsQuery)
  const { data: shots = [], isPending: shotsPending } = useQuery(screenshotsQuery)

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

  const startBuffer = useCallback(() => void setBuffer(true), [setBuffer])
  const stopBuffer = useCallback(() => void setBuffer(false), [setBuffer])

  const openFolder = useCallback(() => {
    void runAction(async () => {
      const res = await api.openFolder()
      if (!res.success) throw new Error(res.error)
    })
  }, [runAction])

  const deleteClip = useCallback(
    async (path: string, scope: DeleteScope) => {
      await expect(api.deleteClip(path, scope), 'Failed to delete clip')
      await client.invalidateQueries({ queryKey: QK.clips })
    },
    [client],
  )

  const deleteScreenshot = useCallback(
    async (path: string) => {
      await expect(api.deleteScreenshot(path), 'Failed to delete screenshot')
      await client.invalidateQueries({ queryKey: QK.screenshots })
    },
    [client],
  )

  const renameClip = useCallback(async (path: string, name: string) => {
    await expect(api.renameClip(path, name), 'Failed to rename clip')
    await client.invalidateQueries({ queryKey: QK.clips })
  }, [client])

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Header title="Rewind" />

      <CaptureControls
        status={status}
        bufferSeconds={bufferSeconds}
        sourceName={source?.name ?? ''}
        sourceInactive={!!source?.inactive}
        saving={isSaving}
        capturing={isCapturing}
        lastSaved={lastSaved}
        bufferActive={bufferActive}
        bufferBusy={bufferBusy}
        bufferStartedAt={bufferStartedAt}
        onSaveReplay={saveClip}
        onScreenshot={takeScreenshot}
        onBufferStart={startBuffer}
        onBufferStop={stopBuffer}
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

      <div className="flex min-h-0 flex-1 flex-col px-3 pb-3">
        {view === 'clips' ? (
          <ClipList
            clips={clips}
            loading={clipsPending}
            view={view}
            onViewChange={setView}
            onDelete={(path) => {
              const clip = clips.find((c) => c.path === path)
              setDeleteTarget({ path, name: clip?.filename ?? 'this clip' })
            }}
            onRename={renameClip}
            onOpenFolder={openFolder}
          />
        ) : (
          <ScreenshotList
            screenshots={shots}
            loading={shotsPending}
            view={view}
            onViewChange={setView}
            onDelete={(path) => {
              const shot = shots.find((s) => s.path === path)
              setDeleteTarget({ path, name: shot?.name ?? 'this screenshot' })
            }}
            onOpenFolder={openFolder}
          />
        )}
      </div>

      <StatusStrip status={status} message={message} />

      <ConfirmDelete
        target={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={async (scope) => {
          const target = deleteTarget
          setDeleteTarget(null)
          if (!target) return
          await runAction(async () => {
            if (view === 'clips') {
              await deleteClip(target.path, scope)
            } else {
              await deleteScreenshot(target.path)
            }
          })
        }}
      />
    </div>
  )
}

/** One line of engine state, kept out of the way at the bottom of the panel. */
function StatusStrip({ status, message }: { status: string; message?: string }) {
  return (
    <div className="flex h-6 shrink-0 items-center justify-center border-t border-line px-3 text-[10px] text-ink-faint">
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
        'Rolling buffer active'
      ) : status === 'error' ? (
        <span className="text-danger">{message ?? 'Engine not ready'}</span>
      ) : null}
    </div>
  )
}

/** Confirmation for destructive deletes. Rewind keeps no cloud copy to fall back on. */
function ConfirmDelete({
  target,
  onClose,
  onConfirm,
}: {
  target: { path: string; name: string } | null
  onClose: () => void
  onConfirm: (scope: DeleteScope) => void
}) {
  return (
    <Dialog
      open={!!target}
      title="Delete"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" size="sm" className="flex-1" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" size="sm" className="flex-1" onClick={() => onConfirm('local')}>
            Delete
          </Button>
        </>
      }
    >
      <p className="text-[13px] text-ink-muted">
        Delete <span className="text-ink">{target?.name}</span>? This cannot be undone.
      </p>
    </Dialog>
  )
}