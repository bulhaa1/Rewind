import { useCallback, useEffect, useState } from 'react'
import { Circle, Square, Camera, Save, Loader2, Play } from 'lucide-react'
import { api } from '../lib/api'
import { Button, cn } from './ui'
import { ScannerSweep } from './mark'

/** mm:ss for the continuous recorder; hh:mm:ss once past an hour. */
function elapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
}

/**
 * Slider positions the buffer length snaps to.
 *
 * Equal travel per gap rather than a linear seconds scale, because a linear one
 * spends half the track on 300-600s and crushes 5-15s into a few pixels. Here
 * every gap gets the same width, so the short lengths people actually use are
 * as easy to land as the long ones. Any value between two anchors still works --
 * these are detents, not the only stops.
 *
 * SEGMENT_TRAVEL is set from the widest gap (300s) so that gap resolves to one
 * second per step. At 100 the 300-600s range advanced in 3s jumps and 220 of
 * the 596 possible values could not be landed on at all, which is the opposite
 * of letting someone pick any length.
 */
const BUFFER_LENGTH_ANCHORS: readonly number[] = [5, 15, 30, 60, 90, 120, 180, 300, 600]
const SEGMENT_TRAVEL = 300
const SLIDER_MAX = (BUFFER_LENGTH_ANCHORS.length - 1) * SEGMENT_TRAVEL

function sliderToSeconds(position: number): number {
  const p = Math.min(Math.max(position, 0), SLIDER_MAX)
  const i = Math.min(Math.floor(p / SEGMENT_TRAVEL), BUFFER_LENGTH_ANCHORS.length - 2)
  const frac = (p - i * SEGMENT_TRAVEL) / SEGMENT_TRAVEL
  return BUFFER_LENGTH_ANCHORS[i] + frac * (BUFFER_LENGTH_ANCHORS[i + 1] - BUFFER_LENGTH_ANCHORS[i])
}

function secondsToSlider(seconds: number): number {
  const last = BUFFER_LENGTH_ANCHORS.length - 2
  const d = Math.min(Math.max(seconds, BUFFER_LENGTH_ANCHORS[0]), BUFFER_LENGTH_ANCHORS[last + 1])
  let i = 0
  while (i < last && d > BUFFER_LENGTH_ANCHORS[i + 1]) i++
  const span = BUFFER_LENGTH_ANCHORS[i + 1] - BUFFER_LENGTH_ANCHORS[i]
  return i * SEGMENT_TRAVEL + ((d - BUFFER_LENGTH_ANCHORS[i]) / span) * SEGMENT_TRAVEL
}

/** Pulls to the nearest anchor when within a second of one, so detents feel real. */
function snapSeconds(raw: number): number {
  let nearest = BUFFER_LENGTH_ANCHORS[0]
  for (const a of BUFFER_LENGTH_ANCHORS) {
    if (Math.abs(a - raw) < Math.abs(nearest - raw)) nearest = a
  }
  return Math.abs(nearest - raw) <= 1 ? nearest : Math.round(raw)
}

function formatBufferLength(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/**
 * How much footage the buffer keeps.
 *
 * Commits on release rather than on every pixel, matching the volume sliders:
 * each step of this range rebuilds the replay chain, and a user dragging from
 * 30s to 3m would otherwise queue sixty rebuilds.
 */
function BufferLengthSlider({
  seconds,
  onCommit,
  disabled,
}: {
  seconds: number
  onCommit: (seconds: number) => void
  disabled: boolean
}) {
  const [drag, setDrag] = useState<number | null>(null)
  const position = drag === null ? secondsToSlider(seconds) : drag
  const shown = drag === null ? seconds : snapSeconds(sliderToSeconds(drag))

  const commit = () => {
    if (drag === null) return
    const next = snapSeconds(sliderToSeconds(drag))
    setDrag(null)
    if (next !== seconds) onCommit(next)
  }

  return (
    <div className="flex items-center gap-2 px-2 pb-2">
      <div className="relative min-w-0 flex-1">
        <input
          type="range"
          min={0}
          max={SLIDER_MAX}
          step={1}
          value={position}
          disabled={disabled}
          aria-label="Buffer length"
          onChange={(e) => setDrag(Number(e.target.value))}
          onPointerUp={commit}
          onKeyUp={commit}
          className="h-1 w-full cursor-pointer appearance-none rounded-full bg-line-strong accent-accent disabled:cursor-not-allowed"
        />
        <div className="pointer-events-none absolute inset-x-0 top-2 h-1">
          {BUFFER_LENGTH_ANCHORS.map((a) => (
            <span
              key={a}
              className="absolute w-px bg-line-strong"
              style={{ left: `${(secondsToSlider(a) / SLIDER_MAX) * 100}%` }}
            />
          ))}
        </div>
      </div>
      <span className="tabular w-10 shrink-0 text-right text-[11px] text-ink-faint">
        {formatBufferLength(shown)}
      </span>
    </div>
  )
}

/**
 * The capture controls.
 *
 * The arc shows how much of the rolling buffer is filled — the one thing a user
 * needs before deciding a moment is still recoverable. Instant replay and
 * continuous recording are separate affordances because they answer different
 * questions: "keep that second" versus "record the next twenty minutes".
 */
export function CaptureControls({
  status,
  sourceName,
  sourceInactive,
  saving,
  capturing,
  lastSaved,
  bufferActive,
  bufferBusy,
  bufferSeconds,
  onSaveReplay,
  onScreenshot,
  onBufferStart,
  onBufferStop,
  onBufferSeconds,
}: {
  status: string
  sourceName: string
  sourceInactive: boolean
  saving: boolean
  capturing: boolean
  lastSaved: number | null
  /** Whether the rolling buffer is currently capturing. */
  bufferActive: boolean
  /** A start/stop request is in flight. */
  bufferBusy: boolean
  /** How much footage the buffer keeps, in seconds. */
  bufferSeconds: number
  onSaveReplay: () => void
  onScreenshot: () => void
  onBufferStart: () => void
  onBufferStop: () => void
  onBufferSeconds: (seconds: number) => void
}) {
  const ready = status === 'ready' || status === 'saving'
  const initializing = status === 'initializing'

  const [recording, setRecording] = useState(false)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [busy, setBusy] = useState(false)

  // Poll the recorder's own clock rather than counting locally, so the displayed
  // time matches what OBS actually considers elapsed.
  useEffect(() => {
    let alive = true
    const tick = async () => {
      const res = await api.getRecordingState().catch(() => null)
      if (!alive || !res || !res.success) return
      setRecording(res.data.recording)
      setElapsedMs(res.data.elapsedMs)
    }
    void tick()
    const id = setInterval(tick, recording ? 500 : 1500)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [recording])

  const toggleRecording = useCallback(async () => {
    if (busy) return
    setBusy(true)
    try {
      if (recording) {
        const res = await api.stopRecording()
        if (!res.success) throw new Error(res.error)
      } else {
        const res = await api.startRecording()
        if (!res.success) throw new Error(res.error)
      }
      const state = await api.getRecordingState()
      if (state.success) {
        setRecording(state.data.recording)
        setElapsedMs(state.data.elapsedMs)
      }
    } catch (e) {
      // Re-read the real state rather than guessing: a failed start or stop may
      // still have transitioned OBS one way or the other.
      await api
        .getRecordingState()
        .then((s) => {
          if (s.success) setRecording(s.data.recording)
        })
        .catch(() => {})
      throw e
    } finally {
      setBusy(false)
    }
  }, [busy, recording])

  return (
    <div className="shrink-0 px-3 pb-3 pt-3">
      <div className="rounded-lg border border-line bg-surface">
        <div className="flex items-center gap-3 p-3">
          <div
            className={cn(
              'relative shrink-0 text-accent transition-opacity duration-300',
              // The record timer is drawn in the middle of the rings, so while it is
              // up the sweep reads as clutter behind the digits rather than as a
              // separate element. Fading it back makes the timer the figure and the
              // sweep the ground. The blur is small on purpose: enough to stop the
              // accent competing, not enough to turn it to mush.
              recording && 'opacity-20 blur-[0.7px]',
            )}
          >
            <ScannerSweep active={ready || recording} size={72} />
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              {recording ? (
                <>
                  <span className="tabular text-sm font-medium text-danger">{elapsed(elapsedMs)}</span>
                  <span className="text-[9px] uppercase tracking-wider text-ink-faint">rec</span>
                </>
              ) : null}
            </div>
          </div>

          <div className="min-w-0 flex-1">
            <p className="label">Capturing</p>
            <p className="truncate text-[13px] font-medium" title={sourceName}>
              {sourceName || '—'}
            </p>
            {sourceInactive ? (
              <span className="mt-0.5 inline-block text-[10px] text-warn">Window not available</span>
            ) : null}
          </div>
        </div>

        {/*
          Two actions on the first row, and Screenshot spanning the second. It was
          the third cell of a two-column grid, so a hole the width of a button sat
          beside it — a gap in the middle of the panel's primary controls read as a
          control that failed to load.
        */}
        <div className="grid grid-cols-2 gap-1.5 border-t border-line p-2">
          <Button
            variant={recording ? 'danger' : 'secondary'}
            size="md"
            disabled={!ready || busy}
            onClick={() => void toggleRecording().catch(() => {})}
            title={recording ? 'Stop recording and save' : 'Record continuously until stopped'}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : recording ? <Square className="h-3.5 w-3.5" /> : <Circle className="h-3.5 w-3.5" />}
            {recording ? 'Stop' : 'Record'}
          </Button>

          <Button variant="secondary" size="md" disabled={!ready || saving} onClick={onSaveReplay}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save Clip
          </Button>

          <Button
            variant="ghost"
            size="md"
            className="col-span-2"
            disabled={capturing}
            onClick={onScreenshot}
            title="Take a screenshot of the captured display"
          >
            {capturing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Camera className="h-3.5 w-3.5" />}
            Screenshot
          </Button>
        </div>

        {/*
          Buffer control is separate from the actions above on purpose. Record and
          Save Clip are things you want during a moment; starting and stopping the
          rolling buffer is setup, and mixing the two makes the primary actions
          harder to find. Both buttons stay live and both are idempotent, so a
          stray press on the wrong one does nothing rather than doing the opposite.

          The length sits with the buttons rather than in Settings: it is the one
          buffer setting anyone changes between sessions, and burying it behind a
          settings click is how people end up unsure what they are actually
          keeping.
        */}
        <div className="border-t border-line">
          <div className="flex items-center gap-1.5 px-2 py-1.5">
            <span className="label flex-1 pl-1">Buffer</span>
            <Button
              variant="outline"
              size="sm"
              disabled={bufferBusy || initializing || bufferActive}
              onClick={onBufferStart}
              title={bufferActive ? 'The rolling buffer is already running' : 'Start capturing into the rolling buffer'}
            >
              <Play className="h-3 w-3" />
              Start
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={bufferBusy || initializing || !bufferActive}
              onClick={onBufferStop}
              title={bufferActive ? 'Stop the rolling buffer' : 'The rolling buffer is already stopped'}
            >
              <Square className="h-3 w-3" />
              Stop
            </Button>
          </div>
          <BufferLengthSlider
            seconds={bufferSeconds}
            onCommit={onBufferSeconds}
            disabled={bufferBusy || initializing}
          />
        </div>

        {lastSaved ? (
          <div className="border-t border-line px-3 py-1.5 text-center text-[11px] text-ink-faint">
            Last clip saved {new Date(lastSaved).toLocaleTimeString()}
          </div>
        ) : null}
      </div>
    </div>
  )
}