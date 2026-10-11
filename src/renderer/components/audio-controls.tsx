import { useEffect, useRef, useState } from 'react'
import { Volume2, VolumeX } from 'lucide-react'
import { api, formatHotkey } from '../lib/api'
import { cn } from './ui'

/** Percent readout for a 0-1 fader, which is every volume in the app. */
const asPercent = (v: number) => `${Math.round(v * 100)}%`

/**
 * Mute button, slider and readout.
 *
 * The value is tracked locally while dragging so the label tracks the pointer, and
 * only committed on release. Dragging also unmutes, which is what a slider
 * implies to anyone who has used one before.
 *
 * `max` lets a control express a range that is not 0-100%, which the mic input gain
 * needs (it runs 0-2). The slider always travels 0..max and commits `value / max`,
 * so a plain volume stays the default case and needs no special casing.
 */
export function VolumeControl({
  label,
  sublabel,
  level,
  disabled = false,
  title,
  max = 1,
  step = 0.01,
  format = asPercent,
  mutable = true,
  ariaLabel,
  onVolumeChange,
  onMuteToggle,
}: {
  label: string
  sublabel?: string
  level: { volume: number; muted: boolean }
  disabled?: boolean
  title?: string
  /** Top of the slider's range, in the same units the callback receives. */
  max?: number
  /** Granularity, in the callback's units. */
  step?: number
  format?: (value: number) => string
  /** A fader with nothing to mute (input gain) renders without the mute button. */
  mutable?: boolean
  ariaLabel?: string
  onVolumeChange: (v: number) => void
  onMuteToggle?: () => void
}) {
  const [drag, setDrag] = useState<number | null>(null)
  // Values are re-snapped to the step grid on the way out because a 0.05 step does not
  // survive `2.1 / 2` as an exact double, and a settings file full of
  // 1.0250000000000003 is a bad thing to hand a user.
  const grid = step / max
  const snap = (v: number) => Number((Math.round(v / grid) * grid).toFixed(4))
  const shown = drag ?? (level.muted ? 0 : snap(level.volume * max))
  const commit = () => {
    if (drag !== null) onVolumeChange(snap(drag / max))
    setDrag(null)
  }
  const readout = drag === null && level.muted ? 'muted' : format(snap(shown / max))
  const MuteIcon = level.muted ? VolumeX : Volume2

  return (
    <div className={cn('flex items-center gap-2', disabled && 'opacity-45')} title={title}>
      {mutable ? (
        <button
          type="button"
          onClick={onMuteToggle}
          disabled={disabled}
          aria-label={level.muted ? `Unmute ${label}` : `Mute ${label}`}
          aria-pressed={level.muted}
          className="shrink-0 text-ink-faint transition-colors hover:text-ink disabled:pointer-events-none"
        >
          <MuteIcon className={cn('h-3.5 w-3.5', level.muted && 'text-danger')} />
        </button>
      ) : null}

      <span className="w-[86px] shrink-0 truncate text-[12px]">{label}</span>

      <input
        type="range"
        min={0}
        max={max}
        step={grid}
        value={shown}
        disabled={disabled}
        aria-label={ariaLabel ?? `${label} volume`}
        onChange={(e) => setDrag(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        className="h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-line-strong accent-accent disabled:cursor-not-allowed"
      />

      <span className="tabular w-9 shrink-0 text-right text-[11px] text-ink-faint">{readout}</span>
    </div>
  )
}

/**
 * Accelerator chip, rendered as a physical key rather than a button.
 *
 * A keyboard shortcut is a thing on a keyboard, and showing it as one removes the
 * guesswork about whether "Alt + 1" is one chord or two. Each key is its own cap
 * with a seam, which also makes multi-key combinations read at a glance.
 */
export function HotkeyChip({ hotkey, onClick }: { hotkey: string; onClick?: () => void }) {
  const keys = formatHotkey(hotkey).split('+').map((k) => k.trim()).filter(Boolean)

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={onClick ? `Rebind shortcut, currently ${formatHotkey(hotkey)}` : undefined}
      title={onClick ? 'Click to rebind' : undefined}
      className="flex min-w-[112px] items-center justify-center gap-1 rounded-md px-1 py-1 transition-colors hover:bg-raised"
    >
      {keys.length ? (
        keys.map((key, i) => (
          <kbd
            key={`${key}-${i}`}
            className="rounded border border-line bg-raised px-1.5 py-0.5 font-mono text-[11px] leading-none text-ink-muted shadow-[0_1px_0_var(--color-line)]"
          >
            {key}
          </kbd>
        ))
      ) : (
        <kbd className="rounded border border-dashed border-line px-1.5 py-0.5 font-mono text-[11px] leading-none text-ink-faint">
          unbound
        </kbd>
      )}
    </button>
  )
}

/**
 * Streams the next global keypress back to the renderer for the rebind dialog.
 *
 * Escape cancels; every other key is swallowed so it cannot also fire the
 * application's own shortcuts while being bound.
 */
export function useHotkeyCapture(active: boolean, onCaptured: (hotkey: string) => void): void {
  const handler = useRef(onCaptured)
  useEffect(() => {
    handler.current = onCaptured
  }, [onCaptured])

  useEffect(() => {
    if (!active) return

    const off = api.on('hotkey-capture-key', (hotkey: string) => handler.current(hotkey))
    void api.startHotkeyCapture()

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKeyDown, true)

    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      void api.stopHotkeyCapture()
      off()
    }
  }, [active])
}