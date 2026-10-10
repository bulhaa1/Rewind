import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, messageOf } from '../lib/api'
import { QK } from '../lib/queries'
import type { ObsStatus } from '@shared/types.js'

/** OBS lifecycle status pushed from main. */
export interface ObsState {
  status: ObsStatus
  message?: string
}

const ObsContext = createContext<ObsState>({ status: 'initializing' })

export function useObsStatus(): ObsState {
  return useContext(ObsContext)
}

/** Subscribes to `obs-status` and seeds the first value with a synchronous read. */
export function ObsStatusProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ObsState>({ status: 'initializing' })

  useEffect(() => {
    void api.getStatus().then((res) => {
      if (res.success && res.data) setState(res.data)
    })

    return api.on('obs-status', (next: ObsState) => setState(next))
  }, [])

  return <ObsContext.Provider value={state}>{children}</ObsContext.Provider>
}

// ---------------------------------------------------------------------------
// Background actions
// ---------------------------------------------------------------------------

interface BackgroundActionError {
  message: string
  /** When present, the UI offers a one-click recovery for this failure. */
  recover?: () => Promise<void>
  actionLabel?: string
}

interface BackgroundActionContextValue {
  isBusy: boolean
  error: BackgroundActionError | null
  /** Resolves false when the action was dropped because another was still running. */
  runAction: (fn: () => Promise<unknown>) => Promise<boolean>
  reportError: (message: string, recover?: () => Promise<void>, actionLabel?: string) => void
  dismissError: () => void
}

const BackgroundActionContext = createContext<BackgroundActionContextValue | null>(null)

export function useBackgroundAction(): BackgroundActionContextValue {
  const ctx = useContext(BackgroundActionContext)
  if (!ctx) throw new Error('useBackgroundAction must be used within BackgroundActionProvider')
  return ctx
}

/**
 * Serializes mutations and owns the recovery affordance.
 *
 * Every settings mutation goes through `runAction` so a failure surfaces as a
 * toast with a "Dismiss" action, and OBS wedges get a Retry button instead of a
 * dead end.
 */
export function BackgroundActionProvider({ children }: { children: ReactNode }) {
  const [isBusy, setIsBusy] = useState(false)
  const [error, setError] = useState<BackgroundActionError | null>(null)
  const inFlight = useRef(false)
  const errorRef = useRef<BackgroundActionError | null>(null)

  useEffect(() => {
    errorRef.current = error
  }, [error])

  const reportError = useCallback((message: string, recover?: () => Promise<void>, actionLabel?: string) => {
    setError({ message, recover, actionLabel })
  }, [])

  const runAction = useCallback(async (fn: () => Promise<unknown>): Promise<boolean> => {
    // Overlapping mutations are dropped rather than queued: a queued full restart
    // behind three more settings changes is indistinguishable from a hang. The
    // caller is told, because a dropped change that the UI has already shown as
    // applied is indistinguishable from a setting that needs a restart to take.
    if (inFlight.current) return false
    inFlight.current = true
    setIsBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      const recoverable = isRecoverable(e)
      toast.error(messageOf(e, 'Something went wrong'), {
        id: 'action-error',
        action: {
          label: recoverable ? 'Retry' : 'Dismiss',
          // Toast actions require a handler; a plain Dismiss just clears the toast.
          onClick: () => {
            if (recoverable) void dismissRef.current()
            else toast.dismiss('action-error')
          },
        },
      })
      if (recoverable) {
        setError({ message: messageOf(e), recover: recoverPipeline, actionLabel: 'Retry' })
      }
    } finally {
      inFlight.current = false
      setIsBusy(false)
    }
    return true
  }, [])

  const dismissError = useCallback(() => {
    const current = errorRef.current
    if (!current) return
    if (!current.recover) {
      setError(null)
      return
    }
    if (inFlight.current) return
    inFlight.current = true
    setIsBusy(true)
    setError(null)
    current.recover().catch(() => {
      /* already surfaced by the caller's own handling */
    }).finally(() => {
      inFlight.current = false
      setIsBusy(false)
    })
  }, [])

  const dismissRef = useRef(dismissError)
  useEffect(() => {
    dismissRef.current = dismissError
  }, [dismissError])

  const value = useMemo(
    () => ({ isBusy, error, runAction, reportError, dismissError }),
    [isBusy, error, runAction, reportError, dismissError],
  )

  return <BackgroundActionContext.Provider value={value}>{children}</BackgroundActionContext.Provider>
}

/** Recovers a wedged replay buffer, escalating to a full OBS reinit. */
async function recoverPipeline(): Promise<void> {
  const first = await api.recoverReplayBuffer()
  if (first.success) return
  const second = await api.reinitOBS()
  if (!second.success) throw new Error(messageOf(second, 'Failed to recover replay buffer'))
}

/** True for the error codes that indicate a recoverable engine failure. */
function isRecoverable(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code
  return code === 'obs-wedged-recovering'
}

/**
 * Invalidates the library queries when the main process reports new media.
 *
 * The main process is the source of truth for when files change, so rather than
 * polling we subscribe to its push events.
 */
export function useLibraryInvalidation(): void {
  const client = useQueryClient()

  useEffect(() => {
    const invalidate =
      (...keys: ReadonlyArray<readonly unknown[]>) =>
      () => {
        for (const key of keys) void client.invalidateQueries({ queryKey: key as unknown[] })
      }

    const unsubscribes = [
      api.on('clip-saved', invalidate(QK.clips)),
      api.on('screenshot-saved', invalidate(QK.screenshots)),
      api.on('auto-detect-switched', invalidate(['source-name'])),
    ]

    return () => unsubscribes.forEach((fn) => fn())
  }, [client])
}