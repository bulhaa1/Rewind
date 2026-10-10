import { useCallback, useEffect, useState } from 'react'
import { Circle, Square, Camera, Save, Loader2, Play } from 'lucide-react'
import { api } from '../lib/api'
import { Button } from './ui'
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
 * The capture controls.
 *
 * The arc shows how much of the rolling buffer is filled â€” the one thing a user
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
  onSaveReplay,
  onScreenshot,
  onBufferStart,
  onBufferStop,
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
  onSaveReplay: () => void
  onScreenshot: () => void
  onBufferStart: () => void
  onBufferStop: () => void
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
          <div className="relative shrink-0 text-accent">
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
              {sourceName || 'â€”'}
            </p>
            {sourceInactive ? (
              <span className="mt-0.5 inline-block text-[10px] text-warn">Window not available</span>
            ) : null}
          </div>
        </div>

        {/*
          Two actions on the first row, and Screenshot spanning the second. It was
          the third cell of a two-column grid, so a hole the width of a button sat
          beside it â€” a gap in the middle of the panel's primary controls read as a
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
        */}
        <div className="flex items-center gap-1.5 border-t border-line px-2 py-1.5">
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

        {lastSaved ? (
          <div className="border-t border-line px-3 py-1.5 text-center text-[11px] text-ink-faint">
            Last clip saved {new Date(lastSaved).toLocaleTimeString()}
          </div>
        ) : null}
      </div>
    </div>
  )
}