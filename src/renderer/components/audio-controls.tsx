import { useEffect, useRef, useState } from 'react'
import { Volume2, VolumeX } from 'lucide-react'
import { api, formatHotkey } from '../lib/api'
import { cn } from './ui'

/**
 * Mute button, slider and readout.
 *
 * The value is tracked locally while dragging so the label tracks the pointer, and
 * only committed on release. Dragging also unmutes, which is what a slider
 * implies to anyone who has used one before.
 */
export function VolumeControl({
  label,
  sublabel,
  level,
  disabled = false,
  title,
  onVolumeChange,
  onMuteToggle,
}: {
  label: string
  sublabel?: string
  level: { volume: number; muted: boolean }
  disabled?: boolean
  title?: string
  onVolumeChange: (v: number) => void
  onMuteToggle: () => void
}) {
  const [drag, setDrag] = useState<number | null>(null)
  const shown = drag ?? (level.muted ? 0 : Math.round(level.volume * 100))
  const MuteIcon = level.muted ? VolumeX : Volume2

  return (
    <div className={cn('flex items-center gap-2', disabled && 'opacity-45')} title={title}>
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

      <span className="w-[86px] shrink-0 truncate text-[12px]">{label}</span>

      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={shown}
        disabled={disabled}
        aria-label={`${label} volume`}
        onChange={(e) => setDrag(Number(e.target.value))}
        onPointerUp={() => {
          if (drag !== null) onVolumeChange(drag / 100)
          setDrag(null)
        }}
        onKeyUp={() => {
          if (drag !== null) onVolumeChange(drag / 100)
          setDrag(null)
        }}
        className="h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-line-strong accent-accent disabled:cursor-not-allowed"
      />

      <span className="tabular w-9 shrink-0 text-right text-[11px] text-ink-faint">
        {drag === null && level.muted ? 'muted' : `${shown}%`}
      </span>
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