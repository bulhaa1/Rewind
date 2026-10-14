import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { probeClip, resolveFfmpeg, runFfmpeg, uniquePath } from './ffmpeg.js'
import { scope } from './logger.js'
import { getSetting } from './store.js'
import type { ExportRequest, ExportResult } from '@shared/types.js'

const log = scope('Export')

/**
 * One export at a time.
 *
 * An export re-encodes while OBS may be capturing; two at once would compete for
 * the encoder and neither finishes promptly. A second request is refused, not queued.
 */
let running: { abort: () => void } | null = null

/** Cancels an in-flight export, killing ffmpeg. No partial file survives. */
export function cancelExport(): void {
  running?.abort()
}

const AUDIO_KBPS = 128
/** Below this the video bitrate cannot express anything watchable. */
const MIN_VIDEO_KBPS = 200

/**
 * The GPU H.264 encoders the bundled ffmpeg ships, in preference order, and the
 * one that worked on this machine (probed once, cached for the app's lifetime).
 * The probe is a 0.1 second null encode: a missing driver or a busy GPU session
 * shows up as a non-zero exit, which is exactly the test we want.
 */
const GPU_ENCODERS = ['h264_nvenc', 'h264_amf', 'h264_qsv'] as const
let gpuEncoder: string | null | undefined

/**
 * Probed with execFile, never spawnSync: this runs on the Electron main process,
 * and a synchronous wait would freeze every IPC handler and OBS callback for the
 * probe's whole timeout.
 */
const execFileP = promisify(execFile)

async function probeEncoder(encoder: string): Promise<boolean> {
  try {
    await execFileP(
      resolveFfmpeg(),
      ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=256x256:d=0.1', '-c:v', encoder, '-frames:v', '1', '-f', 'null', 'NUL'],
      { windowsHide: true, timeout: 5000 },
    )
    return true
  } catch {
    return false
  }
}

async function detectGpuEncoder(): Promise<string | null> {
  if (gpuEncoder !== undefined) return gpuEncoder
  gpuEncoder = null
  for (const encoder of GPU_ENCODERS) {
    if (await probeEncoder(encoder)) {
      gpuEncoder = encoder
      break
    }
    log.info(`${encoder} not usable`)
  }
  log.info(`Export encoder: ${gpuEncoder ?? 'libx264 (CPU fallback)'}`)
  return gpuEncoder
}

/**
 * Video bitrate arguments per encoder: the GPU path is a single VBR pass, the CPU
 * fallback is a two-pass ABR. Each vendor takes its own rate-control vocabulary —
 * `-preset pN` is NVENC-only, QSV speaks x264-style preset names, AMF uses
 * `-quality` — and every one of these is an OUTPUT option, so it must stay after
 * the input side of the seek.
 */
function videoArgs(encoder: string | null, kbps: number): string[] {
  if (!encoder) {
    return ['-c:v', 'libx264', '-preset', 'veryfast', '-b:v', `${kbps}k`, '-threads', String(getSetting('exportThreads') || 0)]
  }
  const rate = ['-b:v', `${kbps}k`, '-maxrate', `${Math.round(kbps * 1.25)}k`, '-bufsize', `${kbps * 2}k`]
  if (encoder === 'h264_nvenc') return ['-c:v', encoder, '-preset', 'p4', '-rc', 'vbr', ...rate]
  if (encoder === 'h264_amf') return ['-c:v', encoder, '-quality', 'balanced', '-rc', 'vbr_peak', ...rate]
  return ['-c:v', encoder, '-preset', 'veryfast', ...rate]
}

/**
 * Compresses a clip range into a smaller MP4, written to `Compressed/` under the
 * output root.
 *
 * The range is cut with input-side `-ss`/`-t`: with a re-encode ffmpeg decodes from
 * the keyframe and discards the excess, so the cut is frame-accurate and still fast.
 * The target bitrate is what the readout promised; the GPU encoders land within
 * about ten percent of it in a single pass, the CPU fallback two-passes to it.
 * The output keeps the source's resolution: a share clip is encoded at the pixels
 * it was recorded with, never downscaled.
 */
export async function exportClip(
  req: ExportRequest,
  deps: { onProgress?: (percent: number) => void; outputRoot: string } = { outputRoot: '' },
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
  deps: { onProgress?: (percent: number) => void; outputRoot: string },
  signal: AbortSignal,
): Promise<ExportResult> {
  const info = await probeClip(req.clipPath)
  if (!info || !info.durationSec) throw new Error('Could not read the clip')
  if (info.width < 2 || info.height < 2) throw new Error('Could not read the clip dimensions')

  const start = Math.min(Math.max(0, req.startSec), Math.max(0, info.durationSec - 0.1))
  const duration = Math.min(Math.max(req.endSec - req.startSec, 0.5), info.durationSec - start)

  // A size target below the floor cannot produce anything watchable; refuse before
  // any file is created so nothing partial is left behind.
  const videoKbps = Math.floor((req.targetMb * 8 * 1024) / duration) - AUDIO_KBPS
  if (videoKbps < MIN_VIDEO_KBPS) {
    throw new Error('This range is too long for the chosen size — raise the quality or trim less')
  }

  if (!deps.outputRoot) throw new Error('No output folder configured')
  const dir = path.join(deps.outputRoot, 'Compressed')
  fs.mkdirSync(dir, { recursive: true })
  const stem = path.basename(req.clipPath, path.extname(req.clipPath))
  const out = uniquePath(dir, stem, '.mp4')

  const seek = ['-ss', start.toFixed(3), '-t', duration.toFixed(3), '-i', req.clipPath]
  const progress = ['-progress', 'pipe:1', '-nostats']
  const report = (ofTotal: (pct: number) => number) => {
    if (!deps.onProgress) return undefined
    // Input-side `-ss` resets output timestamps to 0, so `seconds` runs 0..duration.
    return (seconds: number) => {
      const pct = duration > 0 ? (seconds / duration) * 100 : 0
      deps.onProgress!(Math.min(99, Math.max(0, Math.round(ofTotal(pct)))))
    }
  }

  const encoder = await detectGpuEncoder()
  const vArgs = videoArgs(encoder, videoKbps)
  // The CPU fallback's thread budget limits the decoder too: input-side threads.
  const cpuThreads = getSetting('exportThreads') || 0
  const inputThreads = !encoder && cpuThreads > 0 ? ['-threads', String(cpuThreads)] : []

  try {
    if (encoder) {
      // GPU: one pass. VBR at the promised bitrate lands within ~10% of it.
      await runFfmpeg(
        [
          ...seek, ...vArgs, ...progress,
          '-map', '0:v:0', '-map', '0:a:0?', '-c:a', 'aac', '-b:a', `${AUDIO_KBPS}k`,
          '-movflags', '+faststart', '-y', out,
        ],
        signal,
        report((p) => p),
      ).promise
    } else {
      // CPU: two passes at the promised bitrate, so the file lands on the number.
      const passDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rewind-export-'))
      const passlog = path.join(passDir, 'pass')
      try {
        await runFfmpeg(
          [...inputThreads, ...seek, ...vArgs, ...progress, '-an', '-pass', '1', '-passlogfile', passlog, '-f', 'null', 'NUL'],
          signal,
          report((p) => p * 0.4),
        ).promise
        await runFfmpeg(
          [
            ...inputThreads, ...seek, ...vArgs,
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
    log.info(`Exported ${path.basename(out)}: ${(bytes / 1024 / 1024).toFixed(2)} MB (${encoder ?? 'libx264 two-pass'})`)
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
