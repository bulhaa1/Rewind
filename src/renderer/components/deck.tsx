import { useEffect, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Camera, ChevronDown, ChevronUp, CircleDot, Save } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import { api } from '../lib/api'
import { QK, SETTINGS, hotkeysQuery } from '../lib/queries'
import { useHeldSeconds } from '../lib/hooks'
import { HotkeyChip } from './audio-controls'
import { SettingSelect } from './controls'
import { HotkeyDialog } from './record'
import { InlineSpinner, cn } from './ui'
import { BUFFER_DURATION_MAX, BUFFER_DURATION_MIN, QUICK_CLIP_DEFAULT, QUICK_CLIP_OPTIONS } from '@shared/constants.js'
import type { HotkeyAction } from '@shared/types.js'

const DIAL_RADIUS = 64
const CIRCUMFERENCE = 2 * Math.PI * DIAL_RADIUS

/** The buffer lengths offered in the deck. Anything else is shown alongside them. */
const LIMIT_OPTIONS = [
  { seconds: 30, label: '30s' },
  { seconds: 60, label: '1m' },
  { seconds: 120, label: '2m' },
  { seconds: 300, label: '5m' },
]

/** One press of the custom limit's stepper, in seconds. */
const LIMIT_STEP = 5

/**
 * The buffer dial.
 *
 * One control doing three jobs: start/stop on click, a gauge whose ring fills
 * across the rolling window, and the brand mark at rest. The ring is drawn from
 * `stroke-dashoffset` only, so a fill step is a paint of one number per second —
 * never an animation of layout, and never a repaint loop.
 *
 * `pulseKey` changes once per save: the ring throws off a single outward ripple,
 * which is the confirmation that the clip landed without a toast covering the
 * clips it just added.
 */
export function BufferDial({
  active,
  seconds,
  duration,
  busy,
  pulseKey,
  onToggle,
}: {
  active: boolean
  seconds: number
  duration: number
  busy: boolean
  pulseKey: number
  onToggle: () => void
}) {
  const progress = duration > 0 ? Math.min(Math.max(seconds / duration, 0), 1) : 0
  // Windows' "animations off" reaches us as prefers-reduced-motion. The dial still
  // has to say it can be pressed, so nothing here leans on movement alone: the
  // resting ring is drawn and visible whether or not it is breathing.
  const still = useReducedMotion() ?? false

  return (
    <motion.button
      type="button"
      data-testid="dial"
      onClick={onToggle}
      disabled={busy}
      aria-pressed={active}
      aria-label={active ? 'Stop the replay buffer' : 'Start the replay buffer'}
      title={active ? 'Click to stop the buffer' : 'Click to start the buffer'}
      whileTap={{ scale: 0.98 }}
      transition={{ type: 'spring', stiffness: 420, damping: 34 }}
      className="group relative grid h-[150px] w-[150px] shrink-0 cursor-pointer place-items-center rounded-full outline-none transition-colors hover:bg-raised/40 focus-visible:ring-2 focus-visible:ring-accent/50 disabled:cursor-default disabled:opacity-60"
    >
      <svg viewBox="0 0 150 150" className="h-[150px] w-[150px] -rotate-90">
        <circle cx="75" cy="75" r={DIAL_RADIUS} fill="none" stroke="var(--color-line)" strokeWidth={2} />
        <circle
          cx="75"
          cy="75"
          r={DIAL_RADIUS}
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth={3}
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - progress)}
          style={{ transition: 'stroke-dashoffset 0.9s linear' }}
          className={cn('transition-opacity', active ? 'opacity-100' : 'opacity-0')}
        />
      </svg>

      {/* At rest the ring breathes, and that is what says "press me" without a
          label. With animation off it rests drawn and visible instead of only
          mid-breath, because the invitation cannot be the movement itself. */}
      {!active && !busy ? (
        <motion.span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-full border border-accent/70 transition-colors group-hover:border-accent"
          animate={still ? { opacity: 0.6, scale: 1 } : { opacity: [0.2, 0.65, 0.2], scale: [0.985, 1.05, 0.985] }}
          transition={
            still
              ? { duration: 0.2 }
              : { duration: 2.6, times: [0, 0.5, 1], repeat: Infinity, ease: 'easeInOut' }
          }
        />
      ) : null}

      {/* The save ripple. Keyed so each save restarts it. Without animation it
          fades rather than expanding, so the confirmation stays movement-free. */}
      <motion.span
        key={pulseKey}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-full border border-accent"
        initial={{ opacity: 0.5, scale: 0.97 }}
        animate={still ? { opacity: 0 } : { opacity: 0, scale: 1.14 }}
        transition={{ duration: still ? 0.5 : 1.2, ease: 'easeOut' }}
      />

      <span className="absolute inset-0 flex flex-col items-center justify-center gap-1">
        {busy ? (
          <InlineSpinner />
        ) : (
          <>
            <span className="label">{active ? 'Buffer on' : 'Buffer off'}</span>
            <span className={cn('tabular text-[22px] font-semibold', active ? 'text-ink' : 'text-ink-faint')}>
              {active ? `${seconds}s` : '—'}
            </span>
            <span
              className={cn(
                'text-[11px] text-ink-faint',
                !active && 'transition-colors group-hover:text-ink-muted',
              )}
            >
              {active ? `of ${duration}s` : 'click to start'}
            </span>
          </>
        )}
      </span>
    </motion.button>
  )
}

/**
 * One capture action: icon, label, and the hotkey that also triggers it.
 *
 * The row is the button; the chip beside it rebinds. Splitting them keeps the
 * click target large without making the shortcut itself clickable by accident.
 */
function ActionRow({
  testid,
  icon,
  label,
  hotkey,
  onClick,
  onEditHotkey,
  busy,
  tone = 'quiet',
}: {
  testid: string
  icon: ReactNode
  label: string
  hotkey?: string
  onClick: () => void
  onEditHotkey?: () => void
  busy?: boolean
  tone?: 'quiet' | 'primary' | 'danger'
}) {
  return (
    <div
      className={cn(
        'group flex h-11 items-center gap-3 rounded-lg border px-3 transition-colors',
        tone === 'primary' && 'border-accent/30 bg-accent-soft hover:border-accent/60',
        tone === 'quiet' && 'border-line hover:border-line-strong hover:bg-raised',
        tone === 'danger' && 'border-danger/40 bg-danger/10 hover:border-danger/70',
      )}
    >
      <button
        type="button"
        data-testid={testid}
        onClick={onClick}
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
      >
        <span
          className={cn(
            'shrink-0',
            tone === 'primary' ? 'text-accent' : tone === 'danger' ? 'text-danger' : 'text-ink-muted',
          )}
        >
          {icon}
        </span>
        <span className={cn('truncate text-[13px]', tone === 'danger' ? 'text-danger' : 'text-ink')}>{label}</span>
        {busy ? <InlineSpinner /> : null}
      </button>
      {hotkey && onEditHotkey ? <HotkeyChip hotkey={hotkey} onClick={onEditHotkey} variant="keycap" /> : null}
    </div>
  )
}

/**
 * The capture deck: the dial, what is being captured, the three actions, and the
 * buffer limit.
 *
 * Owns the one-second tick the dial reads and the recording-state poll, because
 * both belong to the control that shows them rather than to the window.
 */
export function Deck({
  bufferActive,
  bufferBusy,
  startedAt,
  duration,
  saving,
  capturing,
  pulseKey,
  sourceName,
  onToggleBuffer,
  onSaveClip,
  onScreenshot,
  onSetBufferSeconds,
}: {
  bufferActive: boolean
  bufferBusy: boolean
  startedAt: number
  duration: number
  saving: boolean
  capturing: boolean
  pulseKey: number
  sourceName: string
  onToggleBuffer: () => void
  onSaveClip: () => void
  onScreenshot: () => void
  onSetBufferSeconds: (seconds: number) => void
}) {
  const client = useQueryClient()
  const { data: hotkeys } = useQuery(hotkeysQuery)
  const [editAction, setEditAction] = useState<HotkeyAction | null>(null)

  // How much footage is recoverable right now, from the one implementation in
  // lib/hooks.ts, so the dial and the status strip cannot disagree about it.
  const held = useHeldSeconds(bufferActive, startedAt, duration)

  // Manual recording is a different thing from the buffer, and the engine is the
  // only authority on whether it is running.
  const [recording, setRecording] = useState(false)
  const [recordBusy, setRecordBusy] = useState(false)

  const readRecording = async (): Promise<boolean | null> => {
    const res = await api.getRecordingState()
    if (!res.success) return null
    const data = res.data as unknown
    return typeof data === 'boolean' ? data : !!(data as { recording?: boolean } | null)?.recording
  }

  useEffect(() => {
    let alive = true
    const tick = async () => {
      const value = await readRecording()
      if (alive && value !== null) setRecording(value)
    }
    void tick()
    const id = setInterval(() => void tick(), 2000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])

  const toggleRecording = () => {
    if (recordBusy) return
    setRecordBusy(true)
    void (async () => {
      try {
        const res = recording ? await api.stopRecording() : await api.startRecording()
        if (!res.success) throw new Error(res.error)
      } catch {
        /* the status strip and toasts report engine failures */
      } finally {
        setRecordBusy(false)
        const value = await readRecording()
        if (value !== null) setRecording(value)
      }
    })()
  }

  // A duration the user set elsewhere (or an older value) still shows, so the
  // strip never claims a limit that is not in force.
  const known = LIMIT_OPTIONS.some((o) => o.seconds === duration)
  const options = known ? LIMIT_OPTIONS : [...LIMIT_OPTIONS, { seconds: duration, label: `${duration}s` }]

  // Custom limit: the presets cover the common windows, this covers the rest of
  // the 5-600s range the engine accepts. It applies on Enter or blur, so typing
  // "120" does not restart the buffer three times on the way there.
  const [customLimit, setCustomLimit] = useState(() => String(duration))
  useEffect(() => {
    setCustomLimit(String(duration))
  }, [duration])

  const applyCustomLimit = () => {
    const typed = Math.round(Number(customLimit))
    if (!Number.isFinite(typed) || customLimit.trim() === '') {
      setCustomLimit(String(duration))
      return
    }
    const clamped = Math.min(Math.max(typed, BUFFER_DURATION_MIN), BUFFER_DURATION_MAX)
    setCustomLimit(String(clamped))
    if (clamped !== duration) onSetBufferSeconds(clamped)
  }

  // The stepper's own presses, which land immediately: one press is one intent,
  // unlike typing "120" which is three.
  const stepLimit = (delta: number) => {
    const typed = Math.round(Number(customLimit))
    const from = Number.isFinite(typed) && customLimit.trim() !== '' ? typed : duration
    const next = Math.min(Math.max(from + delta, BUFFER_DURATION_MIN), BUFFER_DURATION_MAX)
    setCustomLimit(String(next))
    if (next !== duration) onSetBufferSeconds(next)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scroll-clean p-6">
      <div className="flex items-center gap-8">
        <BufferDial
          active={bufferActive}
          seconds={held}
          duration={duration}
          busy={bufferBusy}
          pulseKey={pulseKey}
          onToggle={onToggleBuffer}
        />

        <div className="min-w-0">
          <p className="truncate text-[13px] text-ink" title={sourceName}>
            {bufferActive ? `Capturing: ${sourceName || '—'}` : 'Not capturing'}
          </p>
          <p className="mt-1.5 text-[12px] text-ink-faint">
            {bufferActive
              ? `A clip keeps the last ${duration}s of it`
              : 'Start the buffer and the last minute is always on disk'}
          </p>
        </div>
      </div>

      <div className="mt-8 flex flex-col gap-2">
        <ActionRow
          testid="save-clip"
          tone="primary"
          icon={<Save className="h-4 w-4" strokeWidth={1.5} />}
          label="Save clip"
          hotkey={hotkeys?.['save-replay']}
          onClick={onSaveClip}
          onEditHotkey={() => setEditAction('save-replay')}
          busy={saving}
        />
        <ActionRow
          testid="record"
          tone={recording ? 'danger' : 'quiet'}
          icon={<CircleDot className="h-4 w-4" strokeWidth={1.5} />}
          label={recording ? 'Stop recording' : 'Record'}
          hotkey={hotkeys?.['toggle-record']}
          onClick={toggleRecording}
          onEditHotkey={() => setEditAction('toggle-record')}
          busy={recordBusy}
        />
        <ActionRow
          testid="screenshot"
          icon={<Camera className="h-4 w-4" strokeWidth={1.5} />}
          label="Screenshot"
          hotkey={hotkeys?.screenshot}
          onClick={onScreenshot}
          onEditHotkey={() => setEditAction('screenshot')}
          busy={capturing}
        />
      </div>

      {/* The controls anchor to the bottom of the pane so the dial keeps the top. */}
      <div className="mt-auto flex flex-col gap-3 border-t border-line pt-4">
        <div className="flex items-center gap-3">
          <span className="label shrink-0">Buffer limit</span>
          <div className="flex items-center gap-1" data-testid="buffer-limit">
          {options.map((option) => {
            const current = option.seconds === duration
            return (
              <button
                key={option.seconds}
                type="button"
                data-testid={`buffer-limit-${option.seconds}`}
                aria-pressed={current}
                onClick={() => onSetBufferSeconds(option.seconds)}
                className={cn(
                  'tabular h-7 rounded-md border px-2.5 text-[12px] transition-colors',
                  current
                    ? 'border-accent/50 bg-accent-soft text-ink'
                    : 'border-line text-ink-muted hover:border-line-strong hover:text-ink',
                )}
              >
                {option.label}
              </button>
            )
          })}
          </div>

          {/* Any window the presets do not cover, inside the engine's 5-600s range.
              The spinner is the deck's own: the native one is a light grey box that
              belongs to no other control here. */}
          <div className="ml-auto flex h-7 items-center rounded-md border border-line bg-raised/50 focus-within:border-accent">
            <input
              type="number"
              inputMode="numeric"
              min={BUFFER_DURATION_MIN}
              max={BUFFER_DURATION_MAX}
              value={customLimit}
              onChange={(e) => setCustomLimit(e.target.value)}
              onBlur={applyCustomLimit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  stepLimit(LIMIT_STEP)
                }
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  stepLimit(-LIMIT_STEP)
                }
              }}
              aria-label="Custom buffer limit in seconds"
              title={`Custom limit, ${BUFFER_DURATION_MIN}-${BUFFER_DURATION_MAX} seconds`}
              data-testid="buffer-limit-custom"
              className="tabular h-full w-[46px] bg-transparent px-2 text-right text-[12px] outline-none"
            />
            <span className="flex h-full flex-col border-l border-line">
              <button
                type="button"
                aria-label="Longer buffer"
                title="Longer"
                onClick={() => stepLimit(LIMIT_STEP)}
                className="flex h-1/2 w-4 items-center justify-center rounded-tr-[5px] text-ink-faint transition-colors hover:bg-raised hover:text-ink"
              >
                <ChevronUp className="h-2.5 w-2.5" strokeWidth={2} />
              </button>
              <button
                type="button"
                aria-label="Shorter buffer"
                title="Shorter"
                onClick={() => stepLimit(-LIMIT_STEP)}
                className="flex h-1/2 w-4 items-center justify-center rounded-br-[5px] text-ink-faint transition-colors hover:bg-raised hover:text-ink"
              >
                <ChevronDown className="h-2.5 w-2.5" strokeWidth={2} />
              </button>
            </span>
            <span className="pl-1 pr-1.5 text-[11px] text-ink-faint">s</span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <span className="label shrink-0">Quick clip</span>
          <SettingSelect
            binding={SETTINGS.quickClipSeconds}
            initial={QUICK_CLIP_DEFAULT}
            options={QUICK_CLIP_OPTIONS}
            label="Quick clip length"
          />
          <span className="min-w-0 truncate text-[11px] text-ink-faint">kept by the quick-clip hotkey</span>
          {hotkeys?.['save-quick-clip'] ? (
            <span className="ml-auto">
              <HotkeyChip
                hotkey={hotkeys['save-quick-clip']}
                onClick={() => setEditAction('save-quick-clip')}
                variant="keycap"
              />
            </span>
          ) : null}
        </div>
      </div>

      <HotkeyDialog
        action={editAction}
        current={editAction ? (hotkeys?.[editAction] ?? '') : ''}
        onClose={() => setEditAction(null)}
        onSaved={() => void client.invalidateQueries({ queryKey: QK.hotkeys })}
      />
    </div>
  )
}
