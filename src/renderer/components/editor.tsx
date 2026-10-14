import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Volume2, VolumeX } from 'lucide-react'
import { api, clipUrl, formatBytes, formatDuration, messageOf } from '../lib/api'
import { usePreviewAudio } from '../lib/editor-audio'
import { Button, CenteredSpinner, cn } from './ui'
import type { ClipAudioTrack } from '@shared/types.js'

interface ClipInfo {
  duration: number
  previewPath: string
  audioTracks: ClipAudioTrack[]
  /** Source size in bytes; drives the trim savings estimate. 0 if unreadable. */
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
   */
  const [masterVolume, setMasterVolume] = useState(1)
  /*
   * Whether the whole clip is muted.
   *
   * Held up here rather than inside the row, because the save has to know: if
   * only the row knew, a muted clip would still be written at full volume and
   * the mute would be a lie that only exists on screen.
   */
  const [masterMuted, setMasterMuted] = useState(false)
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
        volume: masterMuted ? 0 : masterVolume * (volumes[t.stream] ?? 1),
      })),
    [tracks, volumes, masterVolume, masterMuted],
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

  const volumesChanged = masterMuted || masterVolume !== 1 || Object.values(volumes).some((v) => v !== 1)

  // Live monitoring: the sliders are heard as they are dragged, no re-encode.
  usePreviewAudio({ ready: !loading, videoRef, tracks, volumes, masterVolume, masterMuted })

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

  /*
   * What trimming is worth, in bytes.
   *
   * Arithmetic on duration, not a measurement: a trim is a stream copy, so what
   * survives is the portion of the clip in time, and a constant bitrate is the
   * only case where bytes and seconds scale exactly. Real clips have a variable
   * bitrate, so this is an estimate and is labelled as one.
   *
   * Plain arithmetic, deliberately not a useMemo. This sits below the `if (loading)`
   * early return above, and a hook added below an early return runs on some
   * renders and not others -- React rejects that outright ("rendered more hooks
   * than during the previous render") and the editor renders nothing at all. A
   * multiplication and a division are not worth that hazard.
   *
   * Shown only once something is actually cut, because "0 MB saved" on an
   * untouched clip is noise rather than information.
   */
  const savedBytes = (() => {
    const size = info?.fileSize ?? 0
    if (size <= 0 || duration <= 0) return 0
    const kept = Math.max(0, Math.min(1, selectionLength / duration))
    return size * (1 - kept)
  })()

  const savedLabel = formatBytes(savedBytes)

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
            <>
              <MasterVolumeRow
                value={masterVolume}
                muted={masterMuted}
                onChange={setMasterVolume}
                onMuteChange={setMasterMuted}
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
            {savedBytes > 0 ? (
              <span
                className="text-accent"
                title="Estimated from the clip size and the trim length. A trim is a stream copy, so this assumes a constant bitrate."
              >
                ≈ {savedLabel} saved
              </span>
            ) : null}
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
 * Export: a shareable GIF, a small MP4 of the trim range, or a compressed copy.
 *
 * One pipeline in the main process; the two buttons differ only in the range they
 * send — Export cuts the trim selection, Compress re-encodes the whole clip. A
 * target size is honoured exactly for MP4 (two-pass); a GIF gets the real size
 * shown after, because GIF bytes cannot be targeted without trial encodes.
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
  const [format, setFormat] = useState<'mp4' | 'gif'>('mp4')
  const [height, setHeight] = useState<0 | 480 | 720 | 1080>(720)
  const [gifFps, setGifFps] = useState<10 | 15 | 20>(15)
  const [audio, setAudio] = useState(true)
  const [targetMb, setTargetMb] = useState('')
  const [running, setRunning] = useState(false)
  const [percent, setPercent] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ path: string; bytes: number } | null>(null)

  useEffect(() => {
    return api.on('export-progress', (p) => setPercent(p.percent))
  }, [])

  const run = async (kind: 'export' | 'compress') => {
    setRunning(true)
    setError(null)
    setResult(null)
    setPercent(0)
    try {
      const parsed = targetMb.trim() ? Number(targetMb) : null
      const req = {
        clipPath,
        startSec: kind === 'compress' ? 0 : startSec,
        endSec: kind === 'compress' ? duration : endSec,
        format: kind === 'compress' ? ('mp4' as const) : format,
        maxHeight: height === 0 ? null : (height as 480 | 720 | 1080),
        gifFps,
        targetMb: parsed && Number.isFinite(parsed) ? parsed : null,
        audio,
        suffix: kind === 'compress' ? 'compressed' : undefined,
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

  const currentMb = fileSize > 0 ? Math.round(fileSize / 1024 / 1024) : 0

  return (
    <div className="rounded-lg border border-line bg-surface p-3" data-testid="export-section">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] font-medium">Export</span>
        <div className="flex overflow-hidden rounded border border-line">
          {(['mp4', 'gif'] as const).map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={format === f}
              disabled={running}
              onClick={() => setFormat(f)}
              className={cn(
                'px-2 py-1 text-[11px] transition-colors',
                format === f ? 'bg-raised text-ink' : 'text-ink-muted hover:text-ink',
              )}
            >
              {f.toUpperCase()}
            </button>
          ))}
        </div>
        <select
          value={height}
          aria-label="Export height"
          disabled={running}
          onChange={(e) => setHeight(Number(e.target.value) as 0 | 480 | 720 | 1080)}
          className="h-7 rounded border border-line bg-raised px-1.5 text-[12px] text-ink outline-none focus:border-accent"
        >
          <option value={0}>Native</option>
          <option value={1080}>1080p</option>
          <option value={720}>720p</option>
          <option value={480}>480p</option>
        </select>
        {format === 'gif' ? (
          <select
            value={gifFps}
            aria-label="Export GIF fps"
            disabled={running}
            onChange={(e) => setGifFps(Number(e.target.value) as 10 | 15 | 20)}
            className="h-7 rounded border border-line bg-raised px-1.5 text-[12px] text-ink outline-none focus:border-accent"
          >
            <option value={10}>10 fps</option>
            <option value={15}>15 fps</option>
            <option value={20}>20 fps</option>
          </select>
        ) : (
          <>
            <label className="flex items-center gap-1 text-[11px] text-ink-muted">
              <input
                type="checkbox"
                checked={audio}
                disabled={running}
                onChange={(e) => setAudio(e.target.checked)}
              />
              Audio
            </label>
            <label className="flex items-center gap-1 text-[11px] text-ink-muted">
              Target size
              <input
                type="number"
                min={1}
                max={500}
                value={targetMb}
                disabled={running}
                placeholder={currentMb ? `≈${currentMb} MB now` : 'MB'}
                aria-label="Export target size in megabytes"
                onChange={(e) => setTargetMb(e.target.value)}
                className="h-7 w-24 rounded border border-line bg-raised px-2 text-[12px] text-ink outline-none focus:border-accent"
              />
              MB
            </label>
          </>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          data-testid="export-button"
          disabled={busy || running || endSec - startSec < 1}
          onClick={() => void run('export')}
        >
          {format === 'gif' ? 'Export GIF' : 'Export MP4'}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          data-testid="compress-button"
          disabled={busy || running || duration < 1}
          title="Re-encode the whole clip to a smaller MP4"
          onClick={() => void run('compress')}
        >
          Compress clip
        </Button>
        {running ? (
          <>
            <span className="tabular text-[11px] text-ink-muted">{percent}%</span>
            <div className="h-1 w-32 overflow-hidden rounded bg-line">
              <div className="h-full bg-accent transition-[width]" style={{ width: `${percent}%` }} />
            </div>
            <Button variant="ghost" size="sm" onClick={() => void api.editorExportCancel()}>
              Cancel
            </Button>
          </>
        ) : null}
        {result ? (
          <span className="flex items-center gap-2 text-[11px] text-ink-muted">
            Saved <span className="truncate">{result.path.split(/[\\/]/).pop()}</span> ({formatBytes(result.bytes)})
            <Button variant="ghost" size="sm" onClick={() => void api.showClipInFolder(result.path)}>
              Show in folder
            </Button>
          </span>
        ) : null}
        {format === 'gif' && !running && !result ? (
          <span className="text-[11px] text-ink-faint">
            GIF size depends on the content — the real size is shown when it finishes.
          </span>
        ) : null}
      </div>
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
   * Wheel scrub: scroll up rewinds, scroll down advances. The wheel fires far
   * faster than a seek can land, so events accumulate into a target that is
   * applied one seek per animation frame -- the same unthrottled-seek lesson
   * that ended the rail's hover scrub.
   */
  const wheelTargetRef = useRef<number | null>(null)
  const wheelRafRef = useRef<number | null>(null)
  const currentRef = useRef(currentSec)
  currentRef.current = currentSec

  useEffect(() => {
    const lane = laneRef.current
    if (!lane) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const step = (e.deltaY || e.deltaX) / 100 // one notch ≈ 1 second
      const base = wheelTargetRef.current ?? currentRef.current
      wheelTargetRef.current = Math.max(0, Math.min(duration, base + step))
      if (wheelRafRef.current === null) {
        wheelRafRef.current = requestAnimationFrame(() => {
          wheelRafRef.current = null
          const target = wheelTargetRef.current
          wheelTargetRef.current = null
          if (target !== null) onSeek(target)
        })
      }
    }
    lane.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      lane.removeEventListener('wheel', onWheel)
      if (wheelRafRef.current !== null) cancelAnimationFrame(wheelRafRef.current)
      wheelRafRef.current = null
      wheelTargetRef.current = null
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
  muted,
  onChange,
  onMuteChange,
  peaks,
  startSec,
  endSec,
  currentSec,
  duration,
  onSeek,
}: {
  value: number
  muted: boolean
  onChange: (v: number) => void
  onMuteChange: (v: boolean) => void
  /** Loudest of the tracks at each point — the shape of the whole mix. */
  peaks?: number[]
  startSec: number
  endSec: number
  currentSec: number
  duration: number
  onSeek: (t: number) => void
}) {
  const shown = muted ? 0 : value

  return (
    <div className="flex items-center gap-2 rounded bg-raised/30 px-2 py-1.5">
      <button
        type="button"
        onClick={() => onMuteChange(!muted)}
        aria-label={muted ? 'Unmute clip' : 'Mute clip'}
        aria-pressed={muted}
        title={muted ? 'Unmute clip' : 'Mute clip'}
        className="shrink-0 text-ink-faint transition-colors hover:text-ink"
      >
        {muted ? <VolumeX className="h-3.5 w-3.5 text-danger" /> : <Volume2 className="h-3.5 w-3.5" />}
      </button>
      <span className="w-16 shrink-0 truncate text-xs text-ink-muted">Clip</span>
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
        max={1}
        step={0.01}
        value={shown}
        aria-label="Clip volume"
        title="Applies to every audio track, on top of each track's own volume."
        onChange={(e) => {
          // Dragging the slider is an instruction to hear something again.
          onMuteChange(false)
          onChange(Number(e.target.value))
        }}
        className="h-1 w-24 shrink-0 cursor-pointer appearance-none rounded-full bg-line-strong accent-accent"
      />
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