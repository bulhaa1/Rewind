import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, clipUrl, formatBytes, formatDuration, messageOf } from '../lib/api'
import { usePreviewAudio } from '../lib/editor-audio'
import { Button, CenteredSpinner, cn } from './ui'
import type { ClipAudioTrack } from '@shared/types.js'

interface ClipInfo {
  duration: number
  previewPath: string
  audioTracks: ClipAudioTrack[]
  /** Source size in bytes; drives the compress savings estimate. 0 if unreadable. */
  fileSize: number
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
  /*
   * Overall clip loudness, applied to every track.
   *
   * Kept separate from the per-track values rather than folded into them, so
   * moving the master does not overwrite what the user set per track: the two
   * multiply at save time. Folding it in would make "reset the track" and "nudge
   * the master" fight each other, and there would be no way back to the original
   * per-track balance without redoing it by hand.
   *
   * There is no separate mute: a fader at zero IS the mute, on screen and on save.
   */
  const [masterVolume, setMasterVolume] = useState(1)
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

  /*
   * What actually gets written: master x per-track, per stream.
   *
   * The multiply happens here rather than in the ffmpeg filter chain so that
   * main receives one plain number per track and never has to know a master
   * exists. Two sliders, one value.
   */
  const trackVolumes = useMemo(
    () =>
      tracks.map((t) => ({
        stream: t.stream,
        volume: masterVolume * (volumes[t.stream] ?? 1),
      })),
    [tracks, volumes, masterVolume],
  )

  // The clip row's waveform: the loudest of the tracks at each point, so the
  // master line reads as the shape of the whole mix without decoding it again.
  // Computed here because every hook must sit above the early returns below.
  const masterPeaks = useMemo(() => {
    const arrays = tracks.map((t) => peaks[t.stream]).filter((p): p is number[] => !!p && p.length > 0)
    if (arrays.length === 0) return null
    const len = Math.min(...arrays.map((a) => a.length))
    const out = new Array<number>(len)
    for (let i = 0; i < len; i++) {
      let loudest = 0
      for (const a of arrays) if (a[i] > loudest) loudest = a[i]
      out[i] = loudest
    }
    return out
  }, [tracks, peaks])

  const volumesChanged = masterVolume !== 1 || Object.values(volumes).some((v) => v !== 1)

  // Live monitoring: the sliders are heard as they are dragged, no re-encode.
  usePreviewAudio({ ready: !loading, broken: !!previewError, videoRef, tracks, volumes, masterVolume })

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
          {info && info.fileSize > 0 ? ` · ${formatBytes(info.fileSize)}` : ''}
        </span>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-4 py-3">
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

        <div className="flex shrink-0 flex-col gap-1.5">
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
            <>
              <MasterVolumeRow
                value={masterVolume}
                onChange={setMasterVolume}
                peaks={masterPeaks ?? undefined}
                startSec={startSec}
                endSec={endSec}
                currentSec={currentSec}
                duration={duration}
                onSeek={seek}
              />
              <div className="flex flex-col gap-1">
                {tracks.map((track) => (
                  <AudioTrackLane
                    key={track.stream}
                    label={track.label}
                    peaks={peaks[track.stream]}
                    volume={volumes[track.stream] ?? 1}
                    startSec={startSec}
                    endSec={endSec}
                    currentSec={currentSec}
                    duration={duration}
                    onSeek={seek}
                    onVolumeChange={(v) => setVolumes((prev) => ({ ...prev, [track.stream]: v }))}
                  />
                ))}
              </div>
            </>
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

          <ExportSection
            clipPath={clipPath}
            startSec={startSec}
            endSec={endSec}
            duration={duration}
            fileSize={info.fileSize}
            busy={!!saving}
          />

          {saveError ? <p className="text-[11px] text-danger">{saveError}</p> : null}
        </div>
      </div>

      <footer className="flex shrink-0 items-center gap-2 border-t border-line/60 px-4 py-2.5">
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
          title="Writes the trimmed range to a new file; the original is kept"
        >
          {saving?.mode === 'copy' ? 'Saving…' : 'Save a copy'}
        </Button>
        <Button
          variant="primary"
          disabled={!!saving || selectionLength < 1}
          onClick={() => void save('overwrite')}
          title="Writes the trimmed range over the original clip"
        >
          {saving?.mode === 'overwrite' ? 'Saving…' : 'Replace original'}
        </Button>
      </footer>
    </div>
  )
}

/**
 * Compress: a smaller MP4 copy of the selected range, at the source's resolution.
 *
 * Each Quality chip is a fraction of the original clip's own bitrate — the point
 * of compressing is to reduce, so the ask is always below what the source spent
 * and the file can never come out larger. The readout shows the size that
 * bitrate produces and the exact reduction against the original clip.
 */
function ExportSection({
  clipPath,
  startSec,
  endSec,
  duration,
  fileSize,
  busy,
}: {
  clipPath: string
  startSec: number
  endSec: number
  duration: number
  fileSize: number
  busy: boolean
}) {
  /** Fraction of the source's own bitrate each chip encodes at. */
  const QUALITY_FRACTIONS = { low: 0.4, medium: 0.65, high: 0.9 } as const
  type Quality = keyof typeof QUALITY_FRACTIONS
  const [quality, setQuality] = useState<Quality>('medium')
  const [running, setRunning] = useState(false)
  const [percent, setPercent] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ path: string; bytes: number } | null>(null)
  // Off by default: the box collapses to its title, out of the way of the trim work
  // it sits under, and only opens when the user asks for a compressed copy.
  const [compressOn, setCompressOn] = useState(false)

  useEffect(() => {
    return api.on('export-progress', (p) => setPercent(p.percent))
  }, [])

  const exportLength = Math.max(0, endSec - startSec)

  /*
   * The size model: each chip encodes at a fraction of the source's own bitrate
   * (video = fraction − 128 kbps of audio, floored at 200). The readout and the
   * target the encoder receives are the same arithmetic, so the file lands on the
   * number shown. On very low-bitrate sources the 200 kbps floor can exceed the
   * fraction — the percent readout says so honestly.
   */
  const srcKbps = fileSize > 0 && duration > 0 ? (fileSize * 8) / duration / 1000 : 0
  // The validator caps an export at 500 MB; keep the ask inside it instead of
  // letting a long range produce a number the button then refuses.
  const cap500Kbps = exportLength > 0 ? Math.max(200, (500 * 8 * 1024) / exportLength - 129) : Infinity
  const videoKbps = Math.min(Math.max(200, Math.floor(srcKbps * QUALITY_FRACTIONS[quality]) - 128), cap500Kbps)
  // +129, not +128: main recomputes the video bitrate from this target with a
  // floor at 200, and one kbps of headroom keeps the roundtrip above the floor.
  const estMb = Math.max(0.1, ((videoKbps + 129) * exportLength) / 8 / 1024)

  // The exact reduction against the original clip's size.
  const baselineMb = fileSize / 1024 / 1024
  const savedPct = baselineMb > 0 ? ((baselineMb - estMb) / baselineMb) * 100 : 0
  const savingsLine =
    baselineMb <= 0
      ? null
      : savedPct > 0
        ? `${Math.round(savedPct)}% smaller`
        : savedPct < 0
          ? `${Math.abs(Math.round(savedPct))}% larger`
          : 'same size'

  const run = async () => {
    setRunning(true)
    setError(null)
    setResult(null)
    setPercent(0)
    try {
      // Always a copy in the Compressed folder; the original is never overwritten.
      const req = {
        clipPath,
        startSec,
        endSec,
        targetMb: Math.max(0.1, ((videoKbps + 129) * exportLength) / 8 / 1024),
      }
      const res = await api.editorExport(req)
      if (!res.success || !res.data) {
        setError(res.success ? 'Export failed' : res.error)
      } else {
        setResult({ path: res.data.path, bytes: res.data.bytes })
      }
    } catch (e) {
      setError(messageOf(e, 'Export failed'))
    } finally {
      setRunning(false)
    }
  }

  const exportDisabledReason =
    exportLength < 1 ? 'Select at least 1 second to export' : running ? 'An export is already running' : null

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface px-3 py-2" data-testid="export-section">
      {/* Both rows are nowrap on purpose: at the window's minimum width they fit,
          and a resize reflows nothing — the flexible text shrinks instead. */}
      <div className="flex flex-nowrap items-center gap-x-3">
        <span className="text-[12px] font-medium">Compress</span>
        <button
          type="button"
          aria-pressed={compressOn}
          data-testid="compress-toggle"
          title={compressOn ? 'Hide the compressor' : 'Show the compressor'}
          onClick={() => setCompressOn(!compressOn)}
          className={cn(
            'rounded border px-2 py-0.5 text-[11px] transition-colors',
            compressOn
              ? 'border-accent/60 bg-accent/10 text-ink'
              : 'border-line text-ink-muted hover:text-ink',
          )}
        >
          {compressOn ? 'On' : 'Off'}
        </button>
        {compressOn ? (
          <>
            <span className="text-[11px] text-ink-muted">Quality</span>
            {(Object.keys(QUALITY_FRACTIONS) as Quality[]).map((label) => (
              <button
                key={label}
                type="button"
                disabled={running}
                data-testid={`quality-${label}`}
                onClick={() => setQuality(label)}
                className={cn(
                  'rounded border px-2 py-0.5 text-[11px] capitalize transition-colors',
                  quality === label
                    ? 'border-accent/60 bg-accent/10 text-ink'
                    : 'border-line text-ink-muted hover:text-ink',
                )}
              >
                {label}
              </button>
            ))}
            <span className="tabular text-[11px] text-ink-muted" data-testid="size-readout">
              ≈ {estMb < 10 ? estMb.toFixed(1) : Math.round(estMb)} MB
            </span>
            {savingsLine ? <span className="tabular text-[11px] text-accent">{savingsLine}</span> : null}

            {/* The action rides the same line as the settings it uses, so the panel fills
                its width instead of stacking half-empty rows. */}
            <span className="ml-auto" title={exportDisabledReason ?? undefined}>
              <Button
                variant="primary"
                size="sm"
                data-testid="export-button"
                disabled={busy || running || exportLength < 1}
                onClick={() => void run()}
              >
                Compress to new file
              </Button>
            </span>
          </>
        ) : null}
      </div>

      {(running || result) && (
        <div className="mt-1 flex flex-nowrap items-center gap-x-3 overflow-hidden">
          <span className="truncate text-[11px] text-ink-faint">
            Writes a smaller copy to the Compressed folder — the original is untouched.
          </span>
          {running ? (
          <>
            <span className="tabular shrink-0 text-[11px] text-ink-muted">{percent}%</span>
            <div className="h-1 w-32 shrink-0 overflow-hidden rounded bg-line">
              <div className="h-full bg-accent transition-[width]" style={{ width: `${percent}%` }} />
            </div>
            <Button variant="ghost" size="sm" onClick={() => void api.editorExportCancel()}>
              Cancel
            </Button>
          </>
        ) : null}
        {result ? (
          <span className="flex min-w-0 items-center gap-2 text-[11px] text-ink-muted">
            <span className="truncate">
              Saved <span title={result.path}>{result.path.split(/[\\/]/).pop()}</span> ({formatBytes(result.bytes)})
            </span>
            <Button variant="ghost" size="sm" onClick={() => void api.showClipInFolder(result.path)}>
              Show in folder
            </Button>
          </span>
        ) : null}
        </div>
      )}
      {error ? <p className="mt-1 text-[11px] text-danger">{error}</p> : null}
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
  const [dragging, setDragging] = useState<'start' | 'end' | 'move' | null>(null)
  /**
   * Where the move gesture began.
   *
   * Held for the whole gesture rather than read from live props, because a drag
   * that recomputed its origin from the current start/end on every mousemove
   * would compound: each event would measure from where the last one landed, and
   * the selection would run away from the cursor.
   */
  const moveOrigin = useRef<{ x: number; start: number; end: number; moved: boolean } | null>(null)

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
      if (dragging === 'start') {
        onChangeStart(Math.min(t, endSec - 0.1))
        return
      }
      if (dragging === 'end') {
        onChangeEnd(Math.max(t, startSec + 0.1))
        return
      }

      const origin = moveOrigin.current
      const rect = laneRef.current?.getBoundingClientRect()
      if (!origin || !rect || rect.width <= 0) return
      origin.moved = true

      const length = origin.end - origin.start
      let delta = ((e.clientX - origin.x) / rect.width) * duration
      // Slide the window rather than resize it: clamp the travel so neither end
      // can leave the clip, which keeps the selection length exactly as it was.
      delta = Math.max(-origin.start, Math.min(duration - origin.end, delta))
      onChangeStart(origin.start + delta)
      onChangeEnd(origin.end + delta)
    }

    const onUp = () => {
      // A press with no movement is a click, not a drag: scrub there rather than
      // silently doing nothing, which is what swallowing it would look like.
      const origin = moveOrigin.current
      if (origin && !origin.moved) onSeek(toSeconds(origin.x))
      moveOrigin.current = null
      setDragging(null)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [dragging, toSeconds, startSec, endSec, duration, onSeek, onChangeStart, onChangeEnd])

  const beginMove = (e: React.MouseEvent) => {
    e.stopPropagation()
    moveOrigin.current = { x: e.clientX, start: startSec, end: endSec, moved: false }
    setDragging('move')
  }

  /*
   * Wheel scrub: scroll up rewinds, scroll down advances. The first notch lands
   * immediately, so a single scroll responds at once; the rest coalesce into one
   * seek per animation frame, because the wheel fires far faster than a seek can
   * land -- the same unthrottled-seek lesson that ended the rail's hover scrub.
   */
  const pendingRef = useRef<number | null>(null)
  const lastRef = useRef<number | null>(null)
  const wheelRafRef = useRef<number | null>(null)
  const currentRef = useRef(currentSec)
  currentRef.current = currentSec

  useEffect(() => {
    const lane = laneRef.current
    if (!lane) return
    const clampToClip = (t: number) => Math.max(0, Math.min(duration, t))
    const flush = () => {
      wheelRafRef.current = null
      const target = pendingRef.current
      pendingRef.current = null
      // The chain dies with its frame: once the playhead has moved, the next
      // scroll continues from wherever the video actually is, not from a stale
      // scrub target.
      lastRef.current = null
      if (target !== null) onSeek(target)
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const step = (e.deltaY || e.deltaX) / 100 // one notch ≈ 1 second
      const base = pendingRef.current ?? lastRef.current ?? currentRef.current
      const next = clampToClip(base + step)
      if (wheelRafRef.current !== null) {
        // A frame is already queued: ride along with it.
        pendingRef.current = next
        return
      }
      // Leading edge: same-frame events chain from this value.
      lastRef.current = next
      onSeek(next)
      wheelRafRef.current = requestAnimationFrame(flush)
    }
    lane.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      lane.removeEventListener('wheel', onWheel)
      if (wheelRafRef.current !== null) cancelAnimationFrame(wheelRafRef.current)
      wheelRafRef.current = null
      pendingRef.current = null
      lastRef.current = null
    }
  }, [duration, onSeek])

  const startPct = pct(startSec, duration)
  const endPct = pct(endSec, duration)
  const playheadPct = pct(currentSec, duration)

  return (
    <div className="relative">
      <div
        ref={laneRef}
        role="slider"
        tabIndex={0}
        title="Scroll to scrub · click to seek · drag the handles to trim"
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
          onMouseDown={beginMove}
          onClick={(e) => e.stopPropagation()}
          title="Drag to move the whole selection"
          className={cn(
            'absolute inset-y-0 rounded bg-accent/15',
            dragging === 'move' ? 'cursor-grabbing' : 'cursor-grab',
          )}
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

/**
 * Overall clip loudness, on the same lane shape as the per-track rows.
 *
 * The master volume is kept separate from the per-track values rather than folded
 * into them, so moving the master does not overwrite what the user set per track:
 * the two multiply at save time. Its waveform is the loudest of the tracks at each
 * point, so the row reads as the shape of the whole mix without decoding it again.
 */
function MasterVolumeRow({
  value,
  onChange,
  peaks,
  startSec,
  endSec,
  currentSec,
  duration,
  onSeek,
}: {
  value: number
  onChange: (v: number) => void
  /** Loudest of the tracks at each point — the shape of the whole mix. */
  peaks?: number[]
  startSec: number
  endSec: number
  currentSec: number
  duration: number
  onSeek: (t: number) => void
}) {
  const shown = value

  return (
    // Same grid as AudioTrackLane, cell for cell: label 20, waveform, slider 20,
    // readout 9. The label cell stays the same width so the waveform and slider
    // start at the same x as the Desktop and Microphone rows.
    <div className="flex items-center gap-2">
      <span className="w-20 shrink-0 truncate text-xs text-ink-muted">Clip</span>
      <LaneGraph
        label="Clip volume"
        peaks={peaks}
        startSec={startSec}
        endSec={endSec}
        currentSec={currentSec}
        duration={duration}
        onSeek={onSeek}
      />
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={Math.round(shown * 100)}
        aria-label="Clip volume"
        title="Applies to every audio track, on top of each track's own volume."
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        className="h-1 w-20 shrink-0 cursor-pointer appearance-none rounded-full bg-line-strong accent-accent"
      />
      <span className="tabular w-9 shrink-0 text-right text-[11px] text-ink-faint">{Math.round(shown * 100)}%</span>
    </div>
  )
}

/**
 * The waveform lane shared by every audio row: the peak envelope, the trim window
 * (kept range bright, cutaways dimmed) and the playhead, clickable to seek.
 *
 * The waveform spans the whole clip, because that is what the engine decoded.
 * What the user is trimming is a window inside it, so the lane shows that window
 * the way the video timeline does. Without this the lane looked identical whether
 * trimmed or not, and read as though the trim had not been applied at all.
 */
function LaneGraph({
  label,
  peaks,
  startSec,
  endSec,
  currentSec,
  duration,
  onSeek,
}: {
  label: string
  peaks?: number[]
  startSec: number
  endSec: number
  currentSec: number
  duration: number
  onSeek: (t: number) => void
}) {
  const laneRef = useRef<HTMLDivElement>(null)

  const toSeconds = useCallback(
    (clientX: number) => {
      const el = laneRef.current
      if (!el) return 0
      const r = el.getBoundingClientRect()
      if (r.width <= 0) return 0
      return Math.max(0, Math.min(duration, ((clientX - r.left) / r.width) * duration))
    },
    [duration],
  )

  const startPct = pct(startSec, duration)
  const endPct = pct(endSec, duration)
  const playheadPct = pct(currentSec, duration)

  return (
    <div
      ref={laneRef}
      role="slider"
      tabIndex={0}
      aria-label={`${label} playhead`}
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(currentSec)}
      aria-valuetext={`${formatDuration(currentSec)} of ${formatDuration(duration)}`}
      onClick={(e) => onSeek(toSeconds(e.clientX))}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 5 : 1
        if (e.key === 'ArrowRight') onSeek(Math.min(endSec, currentSec + step))
        else if (e.key === 'ArrowLeft') onSeek(Math.max(startSec, currentSec - step))
        else return
        e.preventDefault()
      }}
      className="relative h-8 flex-1 cursor-pointer overflow-hidden rounded bg-raised/40"
    >
      {peaks && peaks.length > 0 ? (
        <Waveform peaks={peaks} />
      ) : (
        <div className="flex h-full items-center justify-center text-[11px] text-ink-muted">
          No waveform data
        </div>
      )}

      {/* Cut away: dimmed, and not clickable-looking. */}
      {startPct > 0 ? (
        <div
          className="absolute inset-y-0 left-0 bg-canvas/60"
          style={{ width: `${startPct}%` }}
          title={`Trimmed — ${formatDuration(startSec)}`}
        />
      ) : null}
      {endPct < 100 ? (
        <div
          className="absolute inset-y-0 right-0 bg-canvas/60"
          style={{ width: `${Math.max(0, 100 - endPct)}%` }}
          title={`Trimmed — ${formatDuration(endSec)}`}
        />
      ) : null}

      {/* Kept range, matching the accent of the video timeline's selection. */}
      <div
        className="pointer-events-none absolute inset-y-0 border-x border-accent/60 bg-accent/10"
        style={{ left: `${startPct}%`, width: `${Math.max(0, endPct - startPct)}%` }}
      />

      {/* Same playhead as the video lane, so the two read as one timeline. */}
      <div className="absolute inset-y-0 w-px bg-ink" style={{ left: `${playheadPct}%` }} />
    </div>
  )
}

/** One audio track: a label, a volume slider, and its peak envelope. */
function AudioTrackLane({
  label,
  peaks,
  volume,
  startSec,
  endSec,
  currentSec,
  duration,
  onSeek,
  onVolumeChange,
}: {
  label: string
  peaks?: number[]
  volume: number
  startSec: number
  endSec: number
  currentSec: number
  duration: number
  onSeek: (t: number) => void
  onVolumeChange: (v: number) => void
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-20 shrink-0 truncate text-xs text-ink-muted">{label}</span>
      <LaneGraph
        label={label}
        peaks={peaks}
        startSec={startSec}
        endSec={endSec}
        currentSec={currentSec}
        duration={duration}
        onSeek={onSeek}
      />
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={Math.round(volume * 100)}
        aria-label={`${label} volume`}
        onChange={(e) => onVolumeChange(Number(e.target.value) / 100)}
        className="h-1 w-20 shrink-0 cursor-pointer appearance-none rounded-full bg-line-strong accent-accent"
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