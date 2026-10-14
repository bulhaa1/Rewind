import { useEffect, useRef } from 'react'
import { clipUrl } from './api'
import type { ClipAudioTrack } from '@shared/types.js'

interface PreviewAudioArgs {
  /** False while the editor is still loading; the video element does not exist yet. */
  ready: boolean
  /** True when the preview cannot render; the video element is gone, so tear down. */
  broken: boolean
  videoRef: React.MutableRefObject<HTMLVideoElement | null>
  /** The exposed audio lanes; only lanes with a preview file can be monitored. */
  tracks: ClipAudioTrack[]
  volumes: Record<number, number>
  masterVolume: number
}

interface AudioGraph {
  ctx: AudioContext
  master: GainNode
  lanes: { el: HTMLAudioElement; gain: GainNode; stream: number }[]
  video: HTMLVideoElement
}

/**
 * Live audio monitoring for the editor preview.
 *
 * The volume sliders only took effect when the clip was re-encoded on save; the
 * preview played the file's own mix and heard none of it. This builds a Web Audio
 * graph instead: one muted-video + one `<audio>` element per track, each through
 * its own gain node into a master gain. A slider change writes the gain directly,
 * so what the user drags is what they hear, with nothing re-encoded.
 *
 * Sync with the picture is event-driven (play, pause, seeked) plus a drift check
 * on the video's own timeupdate, because three independently decoded elements
 * wander apart over a long clip. Resyncs only when they are >150 ms apart, so
 * they are rare rather than constant micro-jumps.
 *
 * Any failure (no track previews, AudioContext refused) leaves the video element
 * unmuted and behaves exactly like the old preview: sound still works, the
 * sliders just do not monitor. No error surface, by design.
 */
export function usePreviewAudio({
  ready,
  broken,
  videoRef,
  tracks,
  volumes,
  masterVolume,
}: PreviewAudioArgs): void {
  const graphRef = useRef<AudioGraph | null>(null)

  // Build the graph once per clip, when the track previews are known.
  useEffect(() => {
    const video = videoRef.current
    if (!ready || broken || !video || video.dataset.monitorWired === '1') return
    const lanes = tracks.filter((t) => t.previewPath)
    // Partial coverage would play a wrong mix (a lane missing is silent), so it
    // is all tracks monitored or the plain video sound.
    if (lanes.length === 0 || lanes.length !== tracks.length) return

    let graph: AudioGraph | null = null
    try {
      const ctx = new AudioContext()
      const master = ctx.createGain()
      master.connect(ctx.destination)
      graph = { ctx, master, lanes: [], video }
      for (const t of lanes) {
        const el = new Audio(clipUrl(t.previewPath!))
        el.preload = 'auto'
        el.dataset.testid = 'preview-audio'
        const src = ctx.createMediaElementSource(el)
        const gain = ctx.createGain()
        src.connect(gain)
        gain.connect(master)
        graph.lanes.push({ el, gain, stream: t.stream })
      }
      // A graph rebuilt after a slider change must not start at the defaults.
      graph.master.gain.value = masterVolume
      for (const lane of graph.lanes) lane.gain.gain.value = volumes[lane.stream] ?? 1
    } catch {
      // No graph: the video keeps its own audio.
      return
    }

    graphRef.current = graph
    video.dataset.monitorWired = '1'
    video.muted = true
    // Probe/debug handle; mirrors the window.__exportProgress pattern.
    ;(window as unknown as { __previewAudio?: AudioGraph }).__previewAudio = graph

    const syncTo = (t: number) => {
      for (const lane of graphRef.current?.lanes ?? []) {
        if (Math.abs(lane.el.currentTime - t) > 0.05) lane.el.currentTime = t
      }
    }
    const onPlay = () => {
      const g = graphRef.current
      if (!g) return
      void g.ctx.resume().catch(() => {})
      syncTo(video.currentTime)
      for (const lane of g.lanes) void lane.el.play().catch(() => {})
    }
    const onPause = () => {
      for (const lane of graphRef.current?.lanes ?? []) lane.el.pause()
    }
    const onSeeked = () => syncTo(video.currentTime)
    // A seek the video element made itself (the trim loop restarts from startSec)
    // also arrives here, so the lanes follow the picture in every case.
    const onSeeking = () => syncTo(video.currentTime)
    const onTimeUpdate = () => {
      const g = graphRef.current
      if (!g) return
      for (const lane of g.lanes) {
        if (Math.abs(lane.el.currentTime - video.currentTime) > 0.15) {
          syncTo(video.currentTime)
          return
        }
      }
    }

    video.addEventListener('play', onPlay)
    video.addEventListener('pause', onPause)
    video.addEventListener('seeked', onSeeked)
    video.addEventListener('seeking', onSeeking)
    video.addEventListener('timeupdate', onTimeUpdate)

    return () => {
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('seeked', onSeeked)
      video.removeEventListener('seeking', onSeeking)
      video.removeEventListener('timeupdate', onTimeUpdate)
      delete video.dataset.monitorWired
      video.muted = false
      for (const lane of graphRef.current?.lanes ?? []) {
        lane.el.pause()
        lane.el.src = ''
      }
      void graphRef.current?.ctx.close().catch(() => {})
      graphRef.current = null
      ;(window as unknown as { __previewAudio?: AudioGraph }).__previewAudio = undefined
    }
    // Rebuild when the editor becomes ready or breaks, or the set of track
    // previews changes (a different clip). Slider state is deliberately not a
    // dependency: gains are applied at build time and by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, broken, tracks.map((t) => `${t.stream}:${t.previewPath}`).join('|')])

  // Gains follow the sliders. Written directly, so a drag is heard as it moves.
  useEffect(() => {
    const graph = graphRef.current
    if (!graph) return
    graph.master.gain.value = masterVolume
    for (const lane of graph.lanes) lane.gain.gain.value = volumes[lane.stream] ?? 1
  }, [volumes, masterVolume])
}

