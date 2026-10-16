import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Palette } from 'lucide-react'
import { api, unwrap } from '../lib/api'
import { QK } from '../lib/queries'
import { THEMES } from '@shared/constants.js'
import type { ThemeName } from '@shared/types.js'

/**
 * The theme picker, in the titlebar so it is reachable from the main page.
 *
 * Same popover pattern as the update button. Selecting a theme persists it and
 * every window picks it up through `useTheme`; the swap itself is pure CSS.
 */
export function ThemeButton() {
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState<HTMLElement | null>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const client = useQueryClient()
  const { data: current } = useQuery({
    queryKey: QK.setting('theme'),
    queryFn: () => unwrap(api.getTheme()),
    staleTime: Infinity,
  })

  useEffect(() => setTarget(document.body), [])

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

  const select = (value: ThemeName) => {
    setOpen(false)
    void api.setTheme(value).then(() => client.invalidateQueries({ queryKey: QK.setting('theme') }))
  }

  return (
    <div className="relative" ref={hostRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Theme"
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex h-7 w-7 items-center justify-center rounded text-ink-muted transition-colors hover:bg-raised hover:text-ink"
      >
        <Palette className="h-4 w-4" />
      </button>

      {open && target
        ? createPortal(
            <div
              role="menu"
              aria-label="Theme"
              className="fixed z-[210] w-[180px] rounded-lg border border-line bg-raised p-1.5 shadow-[var(--shadow-pop)]"
              style={place(hostRef.current, target)}
              onClick={(e) => e.stopPropagation()}
            >
              {THEMES.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  role="menuitem"
                  aria-current={current === t.value}
                  onClick={() => select(t.value)}
                  className={`flex w-full items-center justify-between rounded px-2.5 py-1.5 text-left text-[12px] transition-colors hover:bg-surface ${
                    current === t.value ? 'text-accent' : 'text-ink-muted'
                  }`}
                >
                  {t.label}
                  {current === t.value ? <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent" /> : null}
                </button>
              ))}
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
  const w = 180
  const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))
  return { top: r.bottom + 6, left }
}
