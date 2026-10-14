import fs from 'node:fs'
import path from 'node:path'
import { scope } from './logger.js'
import { ffmpegTo, probeDuration } from './ffmpeg.js'
import { KEYINT_SEC } from '@shared/constants.js'

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
  let trimmedCount = 0
  /** End of the slice the previous segment covered; the next one continues from here. */
  let previousEnd = opts.startedAt
  /** Pre-press footage deliberately dropped at the head of the recording. */
  let headroomLost = 0

  for (let i = 0; i < opts.segments.length; i++) {
    const seg = opts.segments[i]
    const actualSec = await probeDuration(seg.file)

    if (!actualSec || actualSec < 0.5) {
      log.warn(`Segment unreadable, skipping: ${path.basename(seg.file)}`)
      continue
    }

    // Each file spans [savedAt - actual, savedAt]: OBS writes it at savedAt, and
    // it carries a whole segment-window of footage ending there.
    const segStartMs = seg.savedAt - actualSec * 1000

    // Where this segment's footage begins, clamped to the press.
    //
    // The first segment needs its own anchor because OBS's rolling buffer is
    // already recording when the user presses, so this file also contains
    // footage from *before* the press. Starting the cursor at startedAt made the
    // lead come out negative, the Math.max(0, ...) below then read that as "no
    // trim needed", and up to a full segment-window of pre-press footage ended
    // up at the front of the clip. Starting from max(startedAt, segStartMs)
    // drops it, because the first segment's lead is then measured from the
    // press rather than from the start of its file.
    // Input-side `-ss` lands on the keyframe at or BEFORE the point asked for,
    // which is up to one KEYINT_SEC early. Aimed exactly at the press it therefore
    // produced a recording that began before it began: measured 41.73s for a 40.0s
    // recording, the extra 1.73s being the snap-back.
    //
    // Aiming one interval later reverses the error: the cut now lands at or after
    // the press, so a recording can be short but never long. The cost is up to
    // KEYINT_SEC of real footage at the very start, which is the better of the two
    // -- dropping the first couple of seconds is recoverable, opening the recording
    // with footage the user never asked for is not.
    //
    // Only the first segment is compensated. Later seams aim at where the previous
    // part ended, and overshooting there would punch a gap at every one of them,
    // so a long recording would lose two seconds per segment.
    const headroom = i === 0 ? KEYINT_SEC * 1000 : 0
    // The window this segment is responsible for, measured from where the
    // previous one ended. Deliberately NOT advanced by the headroom: doing that
    // moved previousEnd later, which pushed the next segment's cut later too,
    // and a 4-segment recording lost 8s instead of 2s because the headroom
    // compounded once per segment.
    const anchor = i === 0 ? Math.max(opts.startedAt, segStartMs) : previousEnd
    const windowEnd = Math.min(anchor + windowMs, opts.stoppedAt)
    // Where the cut is aimed, which is where the headroom applies: past the
    // press on the first segment so the keyframe snap-back cannot land before it.
    const cursor = Math.min(anchor + headroom, opts.stoppedAt - 200)
    const lead = Math.max(0, (cursor - segStartMs) / 1000)
    const dur = Math.min((windowEnd - cursor) / 1000, Math.max(0, actualSec - lead))

    previousEnd = windowEnd

    if (i === 0) headroomLost = Math.max(0, (cursor - anchor) / 1000)

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
        // Without -map, ffmpeg keeps only the FIRST stream of each type. That
        // silently reduced every trimmed segment to one audio track, so a
        // recording arrived in the editor with the Desktop and Microphone lanes
        // missing. Verified against a 3-stream clip: 1 stream without, 3 with.
        '-map', '0',
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
    // Async on purpose: this can be hundreds of megabytes, and the synchronous
    // form freezes the whole app (no repaint, no IPC, no hotkeys) until it is done.
    await fs.promises.copyFile(parts[0], opts.outputPath)
  } else {
    const listFile = path.join(opts.scratchDir, 'parts.txt')
    // Written without a BOM: the concat demuxer reads this file literally, and a
    // BOM makes it reject the very first line.
    const quoted = parts.map((f) => `file '${f.replace(/'/g, "'\\''")}'`)
    fs.writeFileSync(listFile, quoted.join('\n'), 'utf8')
    await ffmpegTo(
      [
        '-f', 'concat', '-safe', '0', '-i', listFile,
        // Same reason as the trim above: default mapping would take one audio
        // stream out of the joined file however many the parts carry.
        '-map', '0',
        '-c', 'copy',
        '-movflags', '+faststart',
      ],
      opts.outputPath,
    )
  }

  const durationSec = (await probeDuration(opts.outputPath)) ?? 0
  const wanted = (opts.stoppedAt - opts.startedAt) / 1000
  log.info(
    `Joined ${parts.length} segment(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
      `(trimmed ${trimmedCount}); ${durationSec.toFixed(1)}s kept of ${wanted.toFixed(1)}s recorded`,
  )

  if (durationSec < 0.5) throw new Error('The joined file has no readable video')

  /*
   * Warns only about footage genuinely lost, not about the footage deliberately cut.
   *
   * The first cut drops up to KEYINT_SEC so the recording cannot open with frames from
   * before the press, and each input-side seek snaps back to the keyframe in front of
   * the point asked for. Those are the intended shape of the result, so they are
   * subtracted before comparing.
   *
   * The old test was a flat `duration < wanted * 0.8`, which ignored both. It fired on
   * perfectly good short recordings -- a 5.3s one loses 2s of headroom, which is 38%,
   * over the threshold -- so the warning cried wolf on every short take and taught the
   * reader to ignore it. That is worse than not warning at all: the log line meant to
   * catch a minute of a game vanishing was sitting next to routine entries.
   *
   * Measured on current code: a 34s take across 5 segments kept 32.0s, and a 68s take
   * across 10 segments kept 66.0s. Both losses are the 2s headroom, neither grows with
   * the segment count, and neither should warn.
   */
  const intended = headroomLost + KEYINT_SEC
  if (wanted > 10 && durationSec < wanted - intended) {
    const lost = wanted - durationSec - intended
    log.warn(
      `Recording kept ${durationSec.toFixed(1)}s of the ${wanted.toFixed(1)}s recorded; ` +
        `${intended.toFixed(1)}s of that is the cut that keeps pre-press footage out, ` +
        `so roughly ${lost.toFixed(1)}s went missing across ${parts.length} segment(s)`,
    )
  }

  return { file: opts.outputPath, durationSec }
}