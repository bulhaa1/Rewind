import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, formatDuration, messageOf } from '../lib/api'
import { Button, CenteredSpinner } from './ui'
import type { ClipAudioTrack } from '@shared/types.js'

interface ClipInfo {
  duration: number
  previewPath: string
  audioTracks: ClipAudioTrack[]
}

/** Maps the clip path to the privileged scheme the renderer can stream from. */
function clipUrl(filePath: string): string {
  return `rewind-clip://local/${encodeURIComponent(filePath)}`
}

/**
 * Chrome-less video element.
 *
 * A plain `<video>` is used rather than wavesurfer's media element because the
 * editor needs frame-accurate `currentTime` control for trim scrubbing, and the
 * browser's own controls would fight the timeline. The element ref is owned by the
 * parent so seeking and play/pause can drive it directly.
 */
function VideoPreview({
  src,
  videoRef,
  onTimeUpdate,
  onDurationChange,
  onPlayStateChange,
  onError,
}: {
  src: string
  videoRef: React.MutableRefObject<HTMLVideoElement | null>
  onTimeUpdate: (t: number) => void
  onDurationChange: (d: number) => void
  onPlayStateChange: (playing: boolean) => void
  onError: (msg: string) => void
}) {
  useEffect(() => {
    const el = videoRef.current
    if (!el) return

    const onTime = () => onTimeUpdate(el.currentTime)
    const onDuration = () => {
      if (Number.isFinite(el.duration) && el.duration > 0) onDurationChange(el.duration)
    }
    const onPlay = () => onPlayStateChange(true)
    const onPause = () => onPlayStateChange(false)
    const onEnded = () => onPlayStateChange(false)
    const onErr = () => {
      const codes: Record<number, string> = {
        1: 'MEDIA_ERR_ABORTED',
        2: 'MEDIA_ERR_NETWORK',
        3: 'MEDIA_ERR_DECODE',
        4: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
      }
      const code = el.error?.code ?? 0
      onError(`Video load failed: ${codes[code] ?? `code ${code}`} (${src})`)
    }

    el.addEventListener('timeupdate', onTime)
    el.addEventListener('durationchange', onDuration)
    el.addEventListener('loadedmetadata', onDuration)
    el.addEventListener('play', onPlay)
    el.addEventListener('pause', onPause)
    el.addEventListener('ended', onEnded)
    el.addEventListener('error', onErr)

    return () => {
      el.removeEventListener('timeupdate', onTime)
      el.removeEventListener('durationchange', onDuration)
      el.removeEventListener('loadedmetadata', onDuration)
      el.removeEventListener('play', onPlay)
      el.removeEventListener('pause', onPause)
      el.removeEventListener('ended', onEnded)
      el.removeEventListener('error', onErr)
    }
  }, [src, videoRef, onTimeUpdate, onDurationChange, onPlayStateChange, onError])

  return <video ref={videoRef} src={src} preload="auto" controls={false} className="max-h-full max-w-full" />
}

/** Seconds to a percentage of the timeline, clamped to [0, 100]. */
function pct(seconds: number, duration: number): number {
  const total = duration > 0 ? duration : 1
  return (Math.max(0, Math.min(seconds, total)) / total) * 100
}

/**
 * The clip editor.
 *
 * Trim range, per-track volume, and copy-or-overwrite. Waveform peaks are computed
 * in the main process (ffmpeg decode) and rendered as bars, which avoids shipping a
 * waveform renderer and keeps memory bounded for long clips.
 */
export function EditorPage({ clipPath }: { clipPath: string }) {
  const [loading, setLoading] = useState(true)
  const [info, setInfo] = useState<ClipInfo | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState<{ mode: 'overwrite' | 'copy' } | null>(null)

  const [duration, setDuration] = useState(0)
  const [startSec, setStartSec] = useState(0)
  const [endSec, setEndSec] = useState(0)
  const [currentSec, setCurrentSec] = useState(0)
  const [playing, setPlaying] = useState(false)
  // Kept apart from `loadError`: a preview that will not decode is not a reason to
  // throw away the loaded metadata and the trim range the user has already set.
  const [previewError, setPreviewError] = useState<string | null>(null)

  const [tracks, setTracks] = useState<ClipAudioTrack[]>([])
  const [volumes, setVolumes] = useState<Record<number, number>>({})
  const [peaks, setPeaks] = useState<Record<number, number[]>>({})

  const videoRef = useRef<HTMLVideoElement>(null)

  /**
   * Moves the playhead.
   *
   * This must drive the element, not just React state: the trim handles and the
   * timeline lane both call it, and previously they only moved a label while the
   * video kept playing, so "seeking" appeared to do nothing.
   */
  const seek = useCallback(
    (t: number) => {
      const video = videoRef.current
      const limit = Number.isFinite(video?.duration) && (video?.duration ?? 0) > 0 ? video!.duration : t
      const target = Math.max(0, Math.min(t, limit))
      if (video) video.currentTime = target
      setCurrentSec(target)
    },
    [],
  )

  /** Play/pause the element, keeping the trim window in view. */
  const togglePlay = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) {
      // Restart from the trim start when the playhead has run past the selection.
      if (video.currentTime < startSec || video.currentTime >= endSec) seek(startSec)
      void video.play().catch(() => setPlaying(false))
    } else {
      video.pause()
    }
  }, [startSec, endSec, seek])

  // Load clip metadata, then waveform peaks for each audio track.
  useEffect(() => {
    let cancelled = false

    void (async () => {
      setLoading(true)
      try {
        const res = await api.editorGetClipInfo(clipPath)
        if (cancelled) return
        if (!res.success || !res.data) {
          // `error` only exists on the failure branch of the envelope.
          setLoadError(res.success ? 'Failed to load clip' : res.error)
          setLoading(false)
          return
        }

        const data = res.data as ClipInfo
        setInfo(data)
        setDuration(data.duration || 0)
        setStartSec(0)
        setEndSec(data.duration || 0)
        setTracks(data.audioTracks)
        setLoading(false)

        for (const track of data.audioTracks) {
          const peaksRes = await api.editorGetTrackPeaks(clipPath, track.stream)
          if (cancelled) return
          if (peaksRes.success && peaksRes.data) {
            setPeaks((prev) => ({ ...prev, [track.stream]: peaksRes.data as number[] }))
          }
        }
      } catch (e) {
        if (!cancelled) {
          setLoadError(messageOf(e, 'Failed to load clip'))
          setLoading(false)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [clipPath])

  // Playback is clamped to the trim range.
  const onTimeUpdate = useCallback(
    (t: number) => {
      setCurrentSec(t)
      if (t >= endSec) {
        setCurrentSec(startSec)
        seek(startSec)
      }
    },
    [endSec, startSec, seek],
  )

  const onPlayStateChange = useCallback((next: boolean) => {
    setPlaying(next)
  }, [])

  // Space toggles playback, Escape cancels; both ignored while typing.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.code === 'Space') {
        e.preventDefault()
        togglePlay()
      } else if (e.code === 'Escape') {
        void api.editorCancel()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [togglePlay])

  const trackVolumes = useMemo(
    () => tracks.map((t) => ({ stream: t.stream, volume: volumes[t.stream] ?? 1 })),
    [tracks, volumes],
  )

  const volumesChanged = trackVolumes.some((t) => t.volume !== 1)

  const save = async (mode: 'overwrite' | 'copy') => {
    setSaving({ mode })
    setSaveError(null)
    try {
      const res = await api.editorSaveClip({ clipPath, startSec, endSec, mode, trackVolumes })
      if (!res.success) {
        setSaveError(res.error || 'Failed to save clip')
        setSaving(null)
        return
      }
      await api.editorCancel()
    } catch (e) {
      setSaveError(messageOf(e, 'Failed to save clip'))
      setSaving(null)
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-canvas">
        <CenteredSpinner />
      </div>
    )
  }

  if (loadError || !info) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-canvas p-6 text-center">
        <p className="text-sm text-danger">{loadError}</p>
        <Button variant="ghost" size="sm" onClick={() => void api.editorCancel()}>
          Close editor
        </Button>
      </div>
    )
  }

  const selectionLength = Math.max(0, endSec - startSec)

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-canvas text-ink">
      <header className="flex shrink-0 items-center gap-2 border-b border-line/60 px-5 py-3">
        <ScissorsIcon />
        <h1 className="text-sm font-medium">Edit Clip</h1>
        <span className="ml-2 truncate text-xs text-ink-muted" title={clipPath}>
          {clipPath.split(/[\\/]/).pop()}
        </span>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden p-5">
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-md bg-black/40">
          <div className="relative">
            {previewError ? (
              <div className="flex max-w-[26rem] flex-col items-center gap-1.5 p-6 text-center">
                <p className="text-[13px] text-danger">Preview unavailable</p>
                <p className="text-[11px] text-ink-muted">{previewError}</p>
                <p className="text-[11px] text-ink-faint">
                  Trimming still works. Use the timeline to set the start and end points.
                </p>
              </div>
            ) : (
              <VideoPreview
                videoRef={videoRef}
                src={clipUrl(info.previewPath)}
                onTimeUpdate={onTimeUpdate}
                onDurationChange={(d) => {
                  if (duration === 0 && d > 0) setDuration(d)
                }}
                onPlayStateChange={onPlayStateChange}
                onError={setPreviewError}
              />
            )}

            {/* Transport overlay: the video has no native controls, so playback needs
                an explicit control or the element is effectively frozen. */}
            {!previewError && (
              <button
                type="button"
                onClick={togglePlay}
                aria-label={playing ? 'Pause' : 'Play'}
                className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors hover:bg-black/20"
              >
                <span
                  className={
                    'flex h-14 w-14 items-center justify-center rounded-full bg-black/60 text-white transition-opacity ' +
                    (playing ? 'opacity-0 hover:opacity-100' : 'opacity-90')
                  }
                >
                  {playing ? (
                    <svg className="h-6 w-6" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                      <rect x="6" y="5" width="4" height="14" rx="1" />
                      <rect x="14" y="5" width="4" height="14" rx="1" />
                    </svg>
                  ) : (
                    <svg className="ml-1 h-6 w-6" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                      <path d="M8 5.14v13.72a1 1 0 0 0 1.54.84l10.3-6.86a1 1 0 0 0 0-1.68L9.54 4.3A1 1 0 0 0 8 5.14z" />
                    </svg>
                  )}
                </span>
              </button>
            )}
          </div>
        </div>

        <div className="flex shrink-0 flex-col gap-2 pb-3">
          <Timeline
            duration={duration}
            startSec={startSec}
            endSec={endSec}
            currentSec={currentSec}
            onSeek={seek}
            onChangeStart={setStartSec}
            onChangeEnd={setEndSec}
          />

          {tracks.length > 0 ? (
            <div className="flex flex-col gap-1">
              {tracks.map((track) => (
                <AudioTrackLane
                  key={track.stream}
                  label={track.label}
                  stream={track.stream}
                  peaks={peaks[track.stream]}
                  volume={volumes[track.stream] ?? 1}
                  onVolumeChange={(v) => setVolumes((prev) => ({ ...prev, [track.stream]: v }))}
                />
              ))}
            </div>
          ) : (
            <p className="text-center text-[11px] text-ink-faint">No audio loaded</p>
          )}

          <div className="tabular flex items-center justify-between pt-1 text-[11px] text-ink-faint">
            <span>
              {formatDuration(currentSec)} / {formatDuration(duration)}
            </span>
            <span>
              Trim: {formatDuration(startSec)} → {formatDuration(endSec)} ({formatDuration(selectionLength)})
            </span>
          </div>

          {saveError ? <p className="text-[11px] text-danger">{saveError}</p> : null}
        </div>
      </div>

      <footer className="flex shrink-0 items-center gap-2 border-t border-line/60 px-5 py-3">
        <p className="flex-1 text-[11px] text-ink-faint">
          {volumesChanged ? 'Audio volumes changed — the clip will be re-encoded.' : 'No audio changes — trim is a stream copy.'}
        </p>
        <Button variant="secondary" disabled={!!saving} onClick={() => void api.editorCancel()}>
          Close
        </Button>
        <Button
          variant="secondary"
          disabled={!!saving || selectionLength < 1}
          onClick={() => void save('copy')}
        >
          {saving?.mode === 'copy' ? 'Saving…' : 'Save as Copy'}
        </Button>
        <Button
          variant="primary"
          disabled={!!saving || selectionLength < 1}
          onClick={() => void save('overwrite')}
        >
          {saving?.mode === 'overwrite' ? 'Saving…' : 'Overwrite'}
        </Button>
      </footer>
    </div>
  )
}

/**
 * Trim timeline.
 *
 * The selected region is a draggable overlay between two handles; clicking the
 * lane scrubs. Handles clamp against each other so the region can't invert.
 */
function Timeline({
  duration,
  startSec,
  endSec,
  currentSec,
  onSeek,
  onChangeStart,
  onChangeEnd,
}: {
  duration: number
  startSec: number
  endSec: number
  currentSec: number
  onSeek: (t: number) => void
  onChangeStart: (t: number) => void
  onChangeEnd: (t: number) => void
}) {
  const laneRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState<'start' | 'end' | null>(null)

  const toSeconds = useCallback(
    (clientX: number) => {
      const rect = laneRef.current?.getBoundingClientRect()
      if (!rect || duration <= 0) return 0
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
      return ratio * duration
    },
    [duration],
  )

  useEffect(() => {
    if (!dragging) return

    const onMove = (e: MouseEvent) => {
      const t = toSeconds(e.clientX)
      if (dragging === 'start') onChangeStart(Math.min(t, endSec - 0.1))
      else onChangeEnd(Math.max(t, startSec + 0.1))
    }
    const onUp = () => setDragging(null)

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [dragging, toSeconds, startSec, endSec, onChangeStart, onChangeEnd])

  const startPct = pct(startSec, duration)
  const endPct = pct(endSec, duration)
  const playheadPct = pct(currentSec, duration)

  return (
    <div className="relative">
      <div
        ref={laneRef}
        role="slider"
        tabIndex={0}
        aria-label="Playhead"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(currentSec)}
        aria-valuetext={`${formatDuration(currentSec)} of ${formatDuration(duration)}`}
        onClick={(e) => onSeek(toSeconds(e.clientX))}
        onKeyDown={(e) => {
          // A control that declares `role="slider"` has to answer to the keyboard.
          // Dragging the handles needs a pointer, so this moves the playhead, which
          // is what the lane's own affordance is for.
          const step = e.shiftKey ? 5 : 1
          if (e.key === 'ArrowRight') onSeek(currentSec + step)
          else if (e.key === 'ArrowLeft') onSeek(currentSec - step)
          else if (e.key === 'Home') onSeek(0)
          else if (e.key === 'End') onSeek(duration)
          else return
          e.preventDefault()
        }}
        className="relative h-8 cursor-pointer rounded bg-raised/60"
      >
        <div
          className="absolute inset-y-0 rounded bg-accent/15"
          style={{ left: `${startPct}%`, width: `${Math.max(0, endPct - startPct)}%` }}
        />
        <div
          onMouseDown={(e) => {
            e.stopPropagation()
            setDragging('start')
          }}
          className="absolute inset-y-0 w-2.5 cursor-ew-resize rounded bg-accent"
          style={{ left: `calc(${startPct}% - 5px)` }}
          title={`Trim start — ${formatDuration(startSec)}`}
        />
        <div
          onMouseDown={(e) => {
            e.stopPropagation()
            setDragging('end')
          }}
          className="absolute inset-y-0 w-2.5 cursor-ew-resize rounded bg-accent"
          style={{ left: `calc(${endPct}% - 5px)` }}
          title={`Trim end — ${formatDuration(endSec)}`}
        />
        <div className="absolute inset-y-0 w-px bg-ink" style={{ left: `${playheadPct}%` }} />
      </div>
    </div>
  )
}

/** One audio track: a label, a volume slider, and its peak envelope. */
function AudioTrackLane({
  label,
  peaks,
  volume,
  onVolumeChange,
}: {
  label: string
  stream: number
  peaks?: number[]
  volume: number
  onVolumeChange: (v: number) => void
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-20 shrink-0 truncate text-xs text-ink-muted">{label}</span>

      <div className="h-8 flex-1 overflow-hidden rounded bg-raised/40">
        {peaks && peaks.length > 0 ? (
          <Waveform peaks={peaks} />
        ) : (
          <div className="flex h-full items-center justify-center text-[10px] text-ink-muted">
            No waveform data
          </div>
        )}
      </div>

      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={Math.round(volume * 100)}
        aria-label={`${label} volume`}
        onChange={(e) => onVolumeChange(Number(e.target.value) / 100)}
        className="w-20 shrink-0 accent-accent"
      />
      <span className="tabular w-9 shrink-0 text-right text-[11px] text-ink-faint">
        {Math.round(volume * 100)}%
      </span>
    </div>
  )
}

/**
 * Peak envelope as mirrored bars.
 *
 * The engine returns one bucket per audio frame — about two thousand for a
 * forty-second clip — which is several times more bars than the lane has pixels.
 * Rendering them all gave each bar a 1px floor plus a 1px gap, so the envelope
 * compressed into a dotted hairline and the waveform told you nothing. The bars
 * are reduced to what the lane can actually show, keeping the tallest peak in each
 * pixel, so a transient is never averaged away by the quiet around it.
 */
function Waveform({ peaks }: { peaks: number[] }) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // A bar plus its 1px gap occupies two pixels, so that is the real budget.
  const budget = Math.max(1, Math.floor(width / 2))
  const bars = useMemo(() => {
    if (peaks.length <= budget) return peaks
    const step = peaks.length / budget
    const out: number[] = []
    for (let i = 0; i < budget; i++) {
      const from = Math.floor(i * step)
      const to = Math.max(from + 1, Math.floor((i + 1) * step))
      let tallest = 0
      for (let j = from; j < to && j < peaks.length; j++) tallest = Math.max(tallest, peaks[j])
      out.push(tallest)
    }
    return out
  }, [peaks, budget])

  /*
   * Normalise against the loudest bar, so the waveform uses the lane's height.
   *
   * Absolute amplitude is the wrong scale here. A quiet recording peaks around
   * 0.02-0.07, which is 2-7% of the lane -- and the 2px floor below then pins
   * almost every bar to the same stubby height, which reads as a flat line rather
   * than as quiet audio. Dividing by the maximum keeps the *shape*, which is what
   * a waveform is for, and makes a quiet clip legible instead of blank.
   *
   * A floor on the divisor stops a near-silent clip from being stretched into a
   * dramatic-looking waveform out of noise.
   */
  const { shaped, loudest } = useMemo(() => {
    let max = 0
    for (const p of bars) if (p > max) max = p
    const scale = Math.max(max, 0.05)
    return { shaped: bars.map((p) => Math.min(1, p / scale)), loudest: max }
  }, [bars])

  return (
    <div ref={ref} className="flex h-full items-center gap-px px-1">
      {shaped.map((peak, i) => (
        <div
          key={i}
          className="min-w-px flex-1 rounded-sm bg-accent/50"
          style={{ height: `${Math.max(2, peak * 100)}%` }}
          title={`Peak ${Math.round(peak * 100)}% of the loudest sample in this track`}
        />
      ))}
      {/* Peak level is the one number worth showing: after normalising, the
          waveform no longer tells you whether the recording was quiet or loud. */}
      {loudest > 0 ? (
        <span className="ml-1.5 shrink-0 self-start text-[9px] tabular-nums text-ink-muted">
          peak {loudest < 0.01 ? '<1' : Math.round(loudest * 100)}%
        </span>
      ) : null}
    </div>
  )
}

function ScissorsIcon() {
  return (
    <svg className="h-4 w-4 text-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M20 4 8.12 15.88" />
      <path d="M14.47 14.48 20 20" />
      <path d="M8.12 8.12 12 12" />
    </svg>
  )
}