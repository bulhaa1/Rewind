import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { probeClip, runFfmpeg, uniquePath } from './ffmpeg.js'
import { scope } from './logger.js'
import type { ExportRequest, ExportResult } from '@shared/types.js'

const log = scope('Export')

/**
 * One export at a time.
 *
 * An export re-encodes while OBS may be capturing; two at once would compete for
 * the CPU and neither finishes promptly. A second request is refused, not queued.
 */
let running: { abort: () => void } | null = null

/** Cancels an in-flight export, killing ffmpeg. No partial file survives. */
export function cancelExport(): void {
  running?.abort()
}

const AUDIO_KBPS = 128
/** Below this the two-pass video bitrate cannot express anything watchable. */
const MIN_VIDEO_KBPS = 200

/** Adds a scale filter when the source is taller than the requested height. */
function scaleArgs(maxHeight: number | null, sourceHeight: number): string[] {
  if (!maxHeight || maxHeight >= sourceHeight) return []
  return ['-vf', `scale=-2:${maxHeight}:flags=lanczos`]
}

/**
 * Exports a clip range as a small shareable MP4 or a GIF.
 *
 * The range is cut with input-side `-ss`/`-t`: with a re-encode ffmpeg decodes from
 * the keyframe and discards the excess, so the cut is frame-accurate and still fast.
 * A target size is honoured by a two-pass ABR encode, which lands within a few
 * percent of the ask; without one the encode runs at CRF 23.
 */
export async function exportClip(
  req: ExportRequest,
  deps: { onProgress?: (percent: number) => void } = {},
): Promise<ExportResult> {
  // Claimed before the first await: two rapid requests must not both pass the guard.
  if (running) throw new Error('An export is already running')
  const claim = new AbortController()
  running = { abort: () => claim.abort() }

  try {
    return await runExport(req, deps, claim.signal)
  } finally {
    running = null
  }
}

async function runExport(
  req: ExportRequest,
  deps: { onProgress?: (percent: number) => void },
  signal: AbortSignal,
): Promise<ExportResult> {
  const info = await probeClip(req.clipPath)
  if (!info || !info.durationSec) throw new Error('Could not read the clip')
  if (info.width < 2 || info.height < 2) throw new Error('Could not read the clip dimensions')

  const start = Math.min(Math.max(0, req.startSec), Math.max(0, info.durationSec - 0.1))
  const duration = Math.min(Math.max(req.endSec - req.startSec, 0.5), info.durationSec - start)

  // A size target below the floor cannot produce anything watchable; refuse before
  // any file is created so nothing partial is left behind.
  if (req.format === 'mp4' && req.targetMb) {
    const videoKbps = Math.floor((req.targetMb * 8 * 1024) / duration) - AUDIO_KBPS
    if (videoKbps < MIN_VIDEO_KBPS) {
      throw new Error('Target size is too small for this duration — trim less or raise the size')
    }
  }

  const ext = req.format === 'gif' ? '.gif' : '.mp4'
  const dir = path.dirname(req.clipPath)
  const stem = path.basename(req.clipPath, path.extname(req.clipPath))
  // Filename characters only: this string reaches openSync via uniquePath.
  const suffix = req.suffix?.replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 24)
  const out = uniquePath(dir, suffix ? `${stem} (${suffix})` : stem, ext)

  const seek = ['-ss', start.toFixed(3), '-t', duration.toFixed(3), '-i', req.clipPath]
  const scale = scaleArgs(req.maxHeight, info.height)
  const progress = ['-progress', 'pipe:1', '-nostats']
  const report = (ofTotal: (pct: number) => number) => {
    if (!deps.onProgress) return undefined
    // Input-side `-ss` resets output timestamps to 0, so `seconds` runs 0..duration.
    return (seconds: number) => {
      const pct = duration > 0 ? (seconds / duration) * 100 : 0
      deps.onProgress!(Math.min(99, Math.max(0, Math.round(ofTotal(pct)))))
    }
  }

  try {
    if (req.format === 'gif') {
      // One pass: the palette is generated from this clip's own frames, which is
      // what keeps screen content from turning to mush. No audio: GIF has none.
      const fps = Math.min(Math.max(req.gifFps ?? 15, 5), 30)
      const filter =
        `fps=${fps},scale=-2:${req.maxHeight ?? info.height}:flags=lanczos,` +
        `split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3`
      await runFfmpeg(
        [...seek, ...progress, '-filter_complex', filter, '-an', '-loop', '0', '-y', out],
        signal,
        report((p) => p),
      ).promise
    } else {
      // MP4 is always a two-pass ABR encode at the bitrate the size readout
      // promised, so the file lands on the number the user was shown.
      let videoKbps = Math.floor((req.targetMb! * 8 * 1024) / duration) - AUDIO_KBPS
      if (videoKbps < MIN_VIDEO_KBPS) {
        throw new Error('This range is too long for the chosen size — raise it or trim less')
      }
      const passDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rewind-export-'))
      const passlog = path.join(passDir, 'pass')
      try {
        const videoArgs = [...seek, ...scale, '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', `${videoKbps}k`]
        await runFfmpeg(
          [...videoArgs, ...progress, '-an', '-pass', '1', '-passlogfile', passlog, '-f', 'null', 'NUL'],
          signal,
          report((p) => p * 0.4),
        ).promise
        await runFfmpeg(
          [
            ...videoArgs,
            '-map', '0:v:0', '-map', '0:a:0?', '-c:a', 'aac', '-b:a', `${AUDIO_KBPS}k`,
            ...progress, '-pass', '2', '-passlogfile', passlog, '-movflags', '+faststart', '-y', out,
          ],
          signal,
          report((p) => 40 + p * 0.6),
        ).promise
      } finally {
        try {
          fs.rmSync(passDir, { recursive: true, force: true })
        } catch {
          /* best effort */
        }
      }
    }

    const bytes = fs.statSync(out).size
    const result = await probeClip(out)
    log.info(`Exported ${path.basename(out)}: ${(bytes / 1024 / 1024).toFixed(2)} MB`)
    return {
      path: out,
      bytes,
      width: result?.width ?? info.width,
      height: result?.height ?? info.height,
      durationSec: result?.durationSec ?? duration,
      audioStreams: result?.audioStreams ?? 0,
    }
  } catch (e) {
    // uniquePath pre-creates the file and a killed encode leaves it partial, so a
    // failed or cancelled export takes its output with it.
    try {
      fs.rmSync(out, { force: true })
    } catch {
      /* best effort */
    }
    throw e
  }
}

