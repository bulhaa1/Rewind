import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Info } from 'lucide-react'
import { api } from '../lib/api'
import { Button } from './ui'

const SOURCE_URL = 'https://github.com/bulhaa1/Rewind'

/**
 * The update control.
 *
 * Sits beside the settings gear. Hidden when the updater does not support this
 * build (unpacked or portable), matching the old update button's gating.
 *
 * Rewind is end of life: the button no longer checks for updates and never
 * touches the network. Clicking it opens this panel, which says so and links to
 * the source. The updater itself is left in place but unreachable.
 */
export function UpdateButton() {
  const [supported, setSupported] = useState(false)
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState<HTMLElement | null>(null)
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => setTarget(document.body), [])

  useEffect(() => {
    let alive = true
    void api.getUpdateState().then((r) => {
      if (alive && r.success) setSupported((r.data as { supported: boolean }).supported)
    })
    return () => {
      alive = false
    }
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
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!supported) return null

  return (
    <div className="relative" ref={hostRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Updates"
        aria-expanded={open}
        aria-haspopup="dialog"
        className="flex h-7 w-7 items-center justify-center rounded text-ink-muted transition-colors hover:bg-raised hover:text-ink"
      >
        <Info className="h-4 w-4" />
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
              <p className="text-[12px] font-medium">Rewind is end of life</p>
              <p className="mt-1.5 text-[11px] text-ink-muted">
                Development has stopped and no further updates will be released. The app keeps
                working as it is.
              </p>
              <p className="mt-1.5 text-[11px] text-ink-muted">
                The source code is free to use — you are welcome to build a similar app and
                improve upon it.
              </p>
              <Button
                size="sm"
                variant="outline"
                className="mt-2 w-full"
                onClick={() => void api.openExternal(SOURCE_URL)}
              >
                View source on GitHub
              </Button>
            </div>,
            target,
          )
        : null}
    </div>
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
