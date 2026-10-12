/**
 * Replay-buffer memory estimation.
 *
 * The replay buffer holds *encoded* packets in OBS's heap, so what it costs is a
 * function of bitrate and duration rather than resolution or scene complexity.
 * That makes an estimate cheap and reasonably accurate -- provided the bitrate is
 * a real one.
 *
 * Pure and in `shared/` on purpose: nothing here may touch OBS or Electron, so
 * the numbers can be checked against recorded clips without launching anything.
 */

import {
  AUDIO_BITRATE_ESTIMATE_KBPS,
  BITRATE_OBSERVATION_HISTORY,
  VBR_KBPS_BY_QUALITY,
} from './constants.js'

export interface BufferMemoryInput {
  videoKbps: number
  durationSeconds: number
}

/**
 * Megabytes of RAM the replay buffer is expected to hold.
 *
 * Bitrate is kilobits *per second* over megabits, so the /1000 is not a unit
 * conversion anyone should skip: leaving it out inflates the answer 1000-fold.
 */
export function estimateBufferMemoryMb({ videoKbps, durationSeconds }: BufferMemoryInput): number {
  if (!(videoKbps > 0) || !(durationSeconds > 0)) return 0
  const totalKbps = videoKbps + AUDIO_BITRATE_ESTIMATE_KBPS
  return (totalKbps * 1000 * durationSeconds) / 8 / 1024 / 1024
}

export type BitrateSource = 'measured' | 'table'

export interface ResolvedBitrate {
  videoKbps: number
  source: BitrateSource
}

/**
 * Pick the bitrate the estimate should use for a quality tier.
 *
 * A measurement always wins. `VBR_KBPS_BY_QUALITY` is an x264 target table --
 * constants.ts says so -- and every hardware encoder in this app is configured
 * with CQP or ICQ instead, which makes the bitrate an outcome rather than an
 * input. On this machine, 'high' is targeted at 12000 kbps and typically
 * delivered near 1700, so trusting the table would report a 60 s buffer as
 * ~90 MB when it is really ~13 MB.
 *
 * The table is still the fallback: it is the only thing available before any
 * clip has been recorded, and it errs high, which is the safer direction for a
 * memory warning.
 */
export function resolveVideoKbps(
  quality: keyof typeof VBR_KBPS_BY_QUALITY,
  observedKbps: number[] | undefined,
): ResolvedBitrate {
  const median = medianKbps(observedKbps)
  if (median > 0) {
    return { videoKbps: median, source: 'measured' }
  }
  return { videoKbps: VBR_KBPS_BY_QUALITY[quality], source: 'table' }
}

/**
 * Median of the remembered samples, or 0 when there are none usable.
 *
 * A median rather than a mean because CQP output swings by nearly two orders of
 * magnitude with content alone -- clips measured on this machine at *identical*
 * settings range from 303 kbps to 28681 kbps. The mean of such a set is set by
 * whichever extreme was recorded most recently; the median describes the machine.
 *
 * Even-length sets average the two middle values, which is what makes the figure
 * move smoothly as samples arrive instead of jumping one value at a time.
 */
export function medianKbps(samples: number[] | undefined): number {
  if (!Array.isArray(samples)) return 0
  const usable = samples.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b)
  if (usable.length === 0) return 0
  const mid = usable.length >> 1
  return usable.length % 2 === 1 ? usable[mid] : (usable[mid - 1] + usable[mid]) / 2
}

/**
 * File one clip's achieved bitrate against its quality tier, keeping the last
 * BITRATE_OBSERVATION_HISTORY samples.
 *
 * `totalFileKbps` is the container's bitrate, which covers video, audio and mux
 * overhead together, so the audio share is removed to leave a video figure that
 * can be compared against the encoder's own settings.
 *
 * A total at or below what the audio alone costs is ignored rather than stored:
 * that describes a failed probe, and recording it would put a 0 into the median.
 */
export function recordBitrateSample(
  previous: number[] | undefined,
  totalFileKbps: number,
): number[] {
  const history = Array.isArray(previous) ? previous.filter((n) => Number.isFinite(n) && n > 0) : []
  const videoKbps = totalFileKbps - AUDIO_BITRATE_ESTIMATE_KBPS
  if (!(videoKbps > 0)) return history
  const next = [...history, videoKbps]
  return next.length > BITRATE_OBSERVATION_HISTORY ? next.slice(next.length - BITRATE_OBSERVATION_HISTORY) : next
}