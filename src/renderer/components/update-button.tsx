import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, ArrowDownToLine, Check, RefreshCw, RotateCw } from 'lucide-react'
import { api, type UpdateState } from '../lib/api'
import { Button } from './ui'

/**
 * The update control.
 *
 * Sits beside the settings gear. Hidden entirely in a development build, because
 * electron-updater cannot run unpacked -- showing a button that only ever reports
 * an error would be worse than showing nothing.
 *
 * Every state here is reached only by clicking. Nothing polls, nothing downloads
 * on its own, and quitting the app does not install a downloaded update: all four
 * are set explicitly in src/main/updater.ts, because the defaults in
 * electron-updater would each of them break that promise.
 */
export function UpdateButton() {
  const [state, setState] = useState<UpdateState>({ supported: false, status: 'idle' })
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState<HTMLElement | null>(null)
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => setTarget(document.body), [])

  useEffect(() => {
    let alive = true
    const read = (s: UpdateState) => {
      if (alive) setState(s)
    }
    void api.getUpdateState().then((r) => {
      if (r.success) read(r.data as UpdateState)
    })
    const off = api.on('update-state', (s) => read(s as UpdateState))
    return () => {
      alive = false
      off()
    }
  }, [])

  const check = useCallback(async () => {
    setState((p) => ({ ...p, status: 'checking', error: undefined }))
    const r = await api.checkForUpdates()
    if (r.success) setState(r.data as UpdateState)
  }, [])

  const download = useCallback(async () => {
    setState((p) => ({ ...p, status: 'downloading', progress: 0 }))
    const r = await api.downloadUpdate()
    if (r.success) setState(r.data as UpdateState)
  }, [])

  // Escape closes and returns focus, matching the clip menu's behaviour.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        hostRef.current?.querySelector('button')?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!state.supported) return null

  const busy = state.status === 'checking' || state.status === 'downloading'
  const badge =
    state.status === 'available' || state.status === 'ready' ? (
      <span
        aria-hidden
        className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-accent"
      />
    ) : null

  const label =
    state.status === 'available' || state.status === 'ready'
      ? `Update ${state.version ?? ''} available`
      : 'Check for updates'

  return (
    <div className="relative" ref={hostRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={busy}
        className="relative flex h-7 w-7 items-center justify-center rounded text-ink-muted transition-colors hover:bg-raised hover:text-ink disabled:opacity-60"
      >
        {state.status === 'downloading' ? (
          <RefreshCw className="h-4 w-4 animate-spin" />
        ) : state.status === 'ready' ? (
          <RotateCw className="h-4 w-4 text-accent" />
        ) : (
          <ArrowDownToLine className="h-4 w-4" />
        )}
        {badge}
      </button>

      {open && target
        ? createPortal(
            <div
              role="dialog"
              aria-label="Updates"
              className="fixed z-[210] w-[248px] rounded-lg border border-line bg-raised p-3 shadow-[var(--shadow-pop)]"
              style={place(hostRef.current, target)}
              onClick={(e) => e.stopPropagation()}
            >
              <p className="text-[12px] font-medium">Updates</p>

              <Body state={state} onCheck={check} onDownload={download} />
            </div>,
            target,
          )
        : null}
    </div>
  )
}

/** The panel body, one branch per state. */
function Body({
  state,
  onCheck,
  onDownload,
}: {
  state: UpdateState
  onCheck: () => void
  onDownload: () => void
}) {
  if (state.status === 'checking') {
    return (
      <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-ink-muted">
        <RefreshCw className="h-3 w-3 animate-spin" />
        Checking…
      </p>
    )
  }

  if (state.status === 'available') {
    return (
      <>
        <p className="mt-1.5 text-[11px] text-ink-muted">
          Version {state.version} is available. Rewind will not download anything until you ask.
        </p>
        <Button size="sm" className="mt-2 w-full" onClick={onDownload}>
          <ArrowDownToLine className="h-3 w-3" />
          Download {state.version}
        </Button>
      </>
    )
  }

  if (state.status === 'downloading') {
    const pct = Math.round((state.progress ?? 0) * 100)
    return (
      <>
        <p className="mt-1.5 text-[11px] text-ink-muted">Downloading {pct}%</p>
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-line">
          <div className="h-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
        </div>
      </>
    )
  }

  if (state.status === 'ready') {
    return (
      <>
        <p className="mt-1.5 text-[11px] text-ink-muted">
          {state.version} is downloaded and ready.
        </p>
        <Button
          size="sm"
          className="mt-2 w-full"
          onClick={() => {
            void api.quitAndInstall()
          }}
        >
          <RotateCw className="h-3 w-3" />
          Restart and install
        </Button>
      </>
    )
  }

  if (state.status === 'error') {
    return (
      <>
        <p className="mt-1.5 flex items-start gap-1.5 text-[11px] text-warn">
          <AlertCircle className="mt-px h-3 w-3 shrink-0" />
          <span>{state.error ?? 'Could not check for updates'}</span>
        </p>
        <Button size="sm" variant="outline" className="mt-2 w-full" onClick={onCheck}>
          <RefreshCw className="h-3 w-3" />
          Try again
        </Button>
      </>
    )
  }

  if (state.status === 'current') {
    return (
      <>
        <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-ink-muted">
          <Check className="h-3 w-3 text-accent" />
          Rewind is up to date.
        </p>
        {/* "Check again", not nothing. Without it this state is a dead end --
            the only route to re-checking would be closing the panel and
            reopening it, which reads as the feature having stopped working. */}
        <Button size="sm" variant="outline" className="mt-2 w-full" onClick={onCheck}>
          <RefreshCw className="h-3 w-3" />
          Check again
        </Button>
      </>
    )
  }

  return (
    <>
      <p className="mt-1.5 text-[11px] text-ink-muted">
        Rewind only contacts the network when you check.
      </p>
      <Button size="sm" variant="outline" className="mt-2 w-full" onClick={onCheck}>
        <RefreshCw className="h-3 w-3" />
        Check for updates
      </Button>
    </>
  )
}

/** Positions the popover under its trigger, flipped if it would leave the panel. */
function place(anchor: HTMLElement | null, body: HTMLElement): React.CSSProperties {
  if (!anchor) return { top: 44, right: 12 }
  const r = anchor.getBoundingClientRect()
  const w = 248
  const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))
  return { top: r.bottom + 6, left }
}
