import fs from 'node:fs'
import path from 'node:path'
import { scope } from './logger.js'
import { ffmpegTo, probeDuration } from './ffmpeg.js'

const log = scope('Stitch')

export interface Segment {
  file: string
  /** Wall-clock ms when the flush was requested; the file's content ends here. */
  savedAt: number
}

export interface StitchOptions {
  segments: Segment[]
  /** Wall-clock ms when recording began. */
  startedAt: number
  /** Wall-clock ms when the user pressed stop. */
  stoppedAt: number
  /** Seconds each segment covers, which is also the cadence they were taken on. */
  windowSeconds: number
  outputPath: string
  scratchDir: string
}

/**
 * Joins recording segments into one playable file, without re-encoding.
 *
 * Three approaches were tried and the failures are worth keeping in mind:
 *
 *  - Trimming each part with an *output-side* seek (`-i file -ss N`) and joining
 *    with the concat demuxer produced files ffprobe described happily and no player
 *    would open — "unspecified pixel format". The seek discards the header that
 *    describes the pixel format.
 *  - Re-encoding everything through the concat filter always worked but took 27
 *    seconds to join a two-and-a-half minute recording, which is the thing that
 *    made Stop feel broken.
 *  - Trimming with an *input-side* seek (`-ss N -i file`) is safe, because it lands
 *    on a keyframe and keeps the stream intact. This is that one.
 *
 * So each segment gets one cheap head trim at its front boundary and the parts are
 * then joined as a pure remux. A join is bounded by a couple of keyframes either
 * side of the cut, so a few hundred milliseconds of footage can sit either side of
 * a seam — which is a far better trade than a corrupt file or a half-minute wait.
 */
export async function stitchSegments(opts: StitchOptions): Promise<{ file: string; durationSec: number }> {
  if (!opts.segments.length) throw new Error('Recording produced no footage')

  const windowMs = opts.windowSeconds * 1000
  const parts: string[] = []
  let cursor = opts.startedAt
  let trimmedCount = 0

  for (let i = 0; i < opts.segments.length; i++) {
    const seg = opts.segments[i]
    const windowEnd = Math.min(cursor + windowMs, opts.stoppedAt)
    const actualSec = await probeDuration(seg.file)

    if (!actualSec || actualSec < 0.5) {
      log.warn(`Segment unreadable, skipping: ${path.basename(seg.file)}`)
      cursor = windowEnd
      continue
    }

    // The file spans [savedAt - actual, savedAt]. Cut the slice this segment owns,
    // which is its window minus whatever the previous one already covered.
    const segStartMs = seg.savedAt - actualSec * 1000
    const lead = Math.max(0, (cursor - segStartMs) / 1000)
    const dur = Math.min((windowEnd - cursor) / 1000, Math.max(0, actualSec - lead))

    cursor = windowEnd

    if (dur <= 0.2) continue
    if (lead <= 0.05 && dur >= actualSec - 0.2) {
      parts.push(seg.file)
      continue
    }

    const part = path.join(opts.scratchDir, `part-${String(i).padStart(4, '0')}.mp4`)
    await ffmpegTo(
      [
        '-ss', lead.toFixed(3),
        '-i', seg.file,
        '-t', dur.toFixed(3),
        '-c', 'copy',
        '-avoid_negative_ts', 'make_zero',
        '-movflags', '+faststart',
      ],
      part,
    )

    const got = await probeDuration(part)
    if (got && got > 0.2) {
      parts.push(part)
      trimmedCount++
      log.info(`Segment ${i}: dropped ${lead.toFixed(1)}s of overlap, kept ${got.toFixed(1)}s`)
    } else {
      // A trim that produced nothing would silently shorten the recording.
      log.warn(`Segment ${i} trimmed to nothing; keeping the whole segment`)
      parts.push(seg.file)
    }
  }

  if (!parts.length) throw new Error('Recording was too short to produce any footage')

  const t0 = Date.now()

  if (parts.length === 1) {
    fs.copyFileSync(parts[0], opts.outputPath)
  } else {
    const listFile = path.join(opts.scratchDir, 'parts.txt')
    // Written without a BOM: the concat demuxer reads this file literally, and a
    // BOM makes it reject the very first line.
    const quoted = parts.map((f) => `file '${f.replace(/'/g, "'\\''")}'`)
    fs.writeFileSync(listFile, quoted.join('\n'), 'utf8')
    await ffmpegTo(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart'], opts.outputPath)
  }

  const durationSec = (await probeDuration(opts.outputPath)) ?? 0
  const wanted = (opts.stoppedAt - opts.startedAt) / 1000
  log.info(
    `Joined ${parts.length} segment(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
      `(trimmed ${trimmedCount}); ${durationSec.toFixed(1)}s kept of ${wanted.toFixed(1)}s recorded`,
  )

  if (durationSec < 0.5) throw new Error('The joined file has no readable video')

  // Badly wrong means the seams lost real footage, which is worth surfacing rather
  // than shipping a recording that silently skipped a minute of a game.
  if (wanted > 5 && durationSec < wanted * 0.8) {
    log.warn(`Recording kept ${durationSec.toFixed(1)}s of the ${wanted.toFixed(1)}s recorded`)
  }

  return { file: opts.outputPath, durationSec }
}