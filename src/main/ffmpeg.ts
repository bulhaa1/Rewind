import { spawn, execFile } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { app } from 'electron'
import { scope } from './logger.js'
import { screenshotFileName } from '@shared/constants.js'

const log = scope('Ffmpeg')

/**
 * Screenshot budget. ddagrab usually returns in well under a second, but it must
 * wait for the GPU while OBS may be restarting a capture source, so the ceiling is
 * generous enough not to fire spuriously.
 */
const SCREENSHOT_TIMEOUT_MS = 20_000

let ffmpegPath: string | null = null
let ffprobePath: string | null = null

/** Packaged builds ship static binaries in resources; dev falls back to the npm packages. */
export function resolveFfmpeg(): string {
  if (ffmpegPath) return ffmpegPath
  const resolved = app.isPackaged
    ? path.join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe')
    : (require('ffmpeg-static') as unknown as string)
  ffmpegPath = resolved
  return resolved
}

export function resolveFfprobe(): string {
  if (ffprobePath) return ffprobePath
  const resolved = app.isPackaged
    ? path.join(process.resourcesPath, 'ffprobe', 'ffprobe.exe')
    : (require('ffprobe-static') as { path: string }).path
  ffprobePath = resolved
  return resolved
}
export class CancelledError extends Error {
  constructor() {
    super('Cancelled')
    this.name = 'CancelledError'
  }
}

export function isCancelled(e: unknown): boolean {
  return e instanceof CancelledError || (typeof e === 'object' && e !== null && (e as Error).name === 'AbortError')
}

export interface RunHandle {
  promise: Promise<void>
  abort: () => void
}

/**
 * Runs ffmpeg with raw argv. Resolves on exit code 0, rejects otherwise.
 * `signal` aborts by SIGKILL, which is the only reliable kill for ffmpeg on Windows.
 */
export function runFfmpeg(args: string[], signal?: AbortSignal): RunHandle {
  let child: ReturnType<typeof spawn> | null = null
  let done = false

  const promise = new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CancelledError())
      return
    }

    let stderr = ''
    child = spawn(resolveFfmpeg(), args, { windowsHide: true })

    const onAbort = () => {
      try {
        child?.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      if (!done) {
        done = true
        reject(new CancelledError())
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    child.stderr?.on('data', (d) => {
      stderr += String(d)
    })
    child.on('error', (e) => {
      signal?.removeEventListener('abort', onAbort)
      if (done) return
      done = true
      reject(e)
    })
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (done) return
      done = true
      if (code === 0) resolve()
      else reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`))
    })
  })

  return {
    promise,
    abort: () => {
      try {
        child?.kill('SIGKILL')
      } catch {
        /* noop */
      }
    },
  }
}

/** Convenience wrapper: run ffmpeg writing to `out`, deleting a partial output on failure. */
export function ffmpegTo(args: string[], out: string, signal?: AbortSignal): Promise<void> {
  return runFfmpeg([...args, '-y', out], signal).promise.catch((e) => {
    try {
      fs.rmSync(out, { force: true })
    } catch {
      /* noop */
    }
    throw e
  })
}

export interface ProbeStream {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  r_frame_rate?: string
  pix_fmt?: string
  /**
   * Container stream tags. ffprobe emits these without being asked, but nothing
   * typed them, so a caller that needs the handler name had no way to read it.
   */
  tags?: Record<string, string>
}

/**
 * Result of measuring one stream's loudness.
 *
 * A failure and a measurement are kept apart on purpose. They look alike at the
 * call site -- both mean "no number" -- but they mean opposite things: one is a
 * broken audio file, the other is a working file with a silent track. Collapsing
 * them lets a failed measurement be reported as a silent stream, which is the one
 * reading that must never be trusted.
 */
export type StreamVolume =
  | { ok: true; meanDb: number | null; maxDb: number | null }
  | { ok: false; error: string }

export interface ProbeResult {
  streams: ProbeStream[]
  format?: { duration?: string; size?: string; bit_rate?: string }
}

/** ffprobe wrapper. Resolves null (never throws) when the file is unreadable. */
export function probe(file: string): Promise<ProbeResult | null> {
  return new Promise((resolve) => {
    execFile(
      resolveFfprobe(),
      ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          log.warn(`ffprobe failed for ${path.basename(file)}:`, err.message)
          resolve(null)
          return
        }
        try {
          resolve(JSON.parse(stdout) as ProbeResult)
        } catch {
          resolve(null)
        }
      },
    )
  })
}

/**
 * Loudness of one audio stream, selected by its position among the audio streams.
 *
 * `volumedetect` prints its result to **stderr**, so capturing stdout alone reports
 * silence for a file that is not silent at all. Both streams are read for that reason.
 *
 * Digital silence is reported by ffmpeg as `-inf`, which is not a number, so it comes
 * back as a null `meanDb` rather than being coerced into a plausible-looking figure.
 * ffmpeg exiting non-zero is a *failure* and comes back as `ok: false`, never as a
 * null measurement -- see {@link StreamVolume}.
 */
export function measureStreamVolume(file: string, audioIndex: number): Promise<StreamVolume> {
  return new Promise((resolve) => {
    execFile(
      resolveFfmpeg(),
      ['-hide_banner', '-nostats', '-i', file, '-map', `0:a:${audioIndex}`, '-af', 'volumedetect', '-f', 'null', 'NUL'],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const text = `${stdout ?? ''}\n${stderr ?? ''}`
        const read = (field: string): number | null => {
          const m = new RegExp(`${field}:\\s+(-?[\\d.]+|-inf)\\s+dB`).exec(text)
          if (!m || m[1] === '-inf') return null
          const n = Number(m[1])
          return Number.isFinite(n) ? n : null
        }
        const meanDb = read('mean_volume')
        const maxDb = read('max_volume')

        // No reading at all is a failure even when ffmpeg exited cleanly: volumedetect
        // always prints both lines for a decodable stream, so their absence means the
        // audio was never decoded rather than that it was quiet.
        if (err || (meanDb === null && maxDb === null)) {
          const error = err ? err.message : 'volumedetect printed no volume reading'
          log.warn(`Could not measure audio stream ${audioIndex} of ${path.basename(file)}: ${error}`)
          resolve({ ok: false, error })
          return
        }
        resolve({ ok: true, meanDb, maxDb })
      },
    )
  })
}

/** Duration in whole seconds, or 0 when unknown. */
export async function probeDuration(file: string): Promise<number> {
  const info = await probe(file)
  const d = Number(info?.format?.duration)
  return d ? Math.round(d) : 0
}

/**
 * What a tail trim actually produced, measured rather than requested.
 *
 * `seconds` is probed from the output file, never echoed back from the request.
 * It cannot always be honoured twice over: a request longer than the clip simply
 * keeps everything, and an input-side `-ss` lands on the keyframe at or before the
 * cut so the result can come back a little under. Either way the caller needs the
 * number it got, not the number it asked for -- reporting the request is how a
 * 60s request came to be announced as "Saved last 60s" over a 25s file.
 */
export interface TailResult {
  /** The file in force afterwards. Differs from the input only if the trim failed. */
  file: string
  /** Seconds kept, probed from the output. */
  seconds: number
  /** True when the request exceeded the clip, so nothing was trimmed away. */
  wholeClip: boolean
}

/**
 * Keeps only the last `seconds` of a clip, in place.
 *
 * `-ss` goes BEFORE `-i` deliberately. An input-side seek lands on a keyframe and
 * keeps the stream intact; the output-side form produces files ffprobe reports as
 * valid and no player will open ("unspecified pixel format"). The same argument
 * order applies to `-map`, which must also precede `-i` for this to hold.
 *
 * `-map 0` is not optional. Without it ffmpeg keeps only the FIRST stream of each
 * type, which silently reduces a three-track clip to a single audio track -- that
 * is what made recordings reach the editor with the Desktop and Microphone lanes
 * missing.
 *
 * Asking for more than the clip holds keeps the whole clip rather than failing,
 * which is also what someone who has just lengthened the buffer expects.
 */
export async function keepTail(file: string, seconds: number): Promise<TailResult> {
  const total = await probeDuration(file)
  if (!total) return { file, seconds: 0, wholeClip: true }
  if (seconds >= total) return { file, seconds: total, wholeClip: true }

  const lead = Math.max(0, total - seconds)
  const dir = path.dirname(file)
  const stem = path.basename(file, path.extname(file))
  const out = uniquePath(dir, `${stem}-tail`, path.extname(file))

  try {
    await ffmpegTo(
      [
        '-ss', lead.toFixed(3),
        '-i', file,
        '-map', '0',
        '-c', 'copy',
        '-movflags', '+faststart',
      ],
      out,
    )
  } catch (e) {
    // The clip is already saved and playable. Losing the trim is a far smaller
    // failure than losing the clip, so report it and keep the original.
    log.warn(`Tail trim failed, keeping the full clip: ${(e as Error).message}`)
    return { file, seconds: total, wholeClip: true }
  }

  const kept = await probeDuration(out)
  if (!kept) {
    log.warn('Tail trim produced nothing readable, keeping the full clip')
    try {
      fs.unlinkSync(out)
    } catch {
      /* best effort */
    }
    return { file, seconds: total, wholeClip: true }
  }

  // Back to the original name. The trimmed file was written as `-tail` only so the
  // input and the output could not collide, and that suffix is an implementation
  // detail that has no business showing up in a filename the user sees in their
  // library.
  try {
    fs.unlinkSync(file)
    fs.renameSync(out, file)
  } catch (e) {
    // The trimmed copy still stands on its own; only the name came out wrong.
    log.warn('Kept the trimmed file under its temporary name:', e)
    return { file: out, seconds: kept, wholeClip: false }
  }
  log.info(`Kept last ${kept}s of a ${total}s clip`)
  return { file, seconds: kept, wholeClip: false }
}

export interface ClipProbe {
  durationSec: number
  bitrateKbps: number
  codec: string
  width: number
  height: number
  fps: number
}

/** Full clip metadata used for the "Clip saved: ..." diagnostics line and editor UI. */
export async function probeClip(file: string): Promise<ClipProbe | null> {
  const info = await probe(file)
  if (!info) return null

  const v = info.streams.find((s) => s.codec_type === 'video')
  let fps = 0
  const rf = v?.r_frame_rate
  if (rf?.includes('/')) {
    const [n, d] = rf.split('/').map(Number)
    fps = d ? Math.round(((n ?? 0) / d) * 100) / 100 : 0
  }

  return {
    durationSec: info.format?.duration ? Math.round(Number(info.format.duration) * 100) / 100 : 0,
    bitrateKbps: info.format?.bit_rate ? Math.round(Number(info.format.bit_rate) / 1000) : 0,
    codec: v?.codec_name ?? 'unknown',
    width: v?.width ?? 0,
    height: v?.height ?? 0,
    fps,
  }
}

/**
 * Screenshot grab.
 *
 * gdigrab runs first, contrary to the original's ddagrab-first approach: Desktop
 * Duplication permits only a few concurrent sessions and Rewind already holds one
 * through OBS's display capture, so ddagrab can stall. gdigrab uses GDI and is
 * unaffected. ddagrab remains as a fallback.
 *
 * `-y` is mandatory on every attempt. `uniquePath` pre-creates the output file to
 * reserve the name, so without it ffmpeg blocks forever on an overwrite prompt that
 * has no one to answer it.
 *
 * `output_idx` is a display-adapter index, not a monitor index.
 */
export async function captureScreenshot(displayIndex: number, dir: string): Promise<string> {
  fs.mkdirSync(dir, { recursive: true })

  const attempts: { label: string; args: string[] }[] = [
    {
      label: 'gdigrab',
      args: [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'gdigrab', '-framerate', '5', '-i', 'desktop',
        '-frames:v', '1',
      ],
    },
    {
      label: 'ddagrab',
      args: [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-init_hw_device', 'd3d11va',
        '-filter_complex', `ddagrab=output_idx=${displayIndex}:draw_mouse=0,hwdownload,format=bgra`,
        '-frames:v', '1',
      ],
    },
  ]

  const errors: string[] = []

  for (const attempt of attempts) {
    const out = uniquePath(dir, screenshotFileName(), '.png')
    try {
      await runFfmpeg([...attempt.args, out], withTimeout(SCREENSHOT_TIMEOUT_MS)).promise
      if (fs.statSync(out).size === 0) throw new Error('produced no image data')
      return out
    } catch (e) {
      try {
        fs.rmSync(out, { force: true })
      } catch {
        /* noop */
      }
      const message = e instanceof Error ? e.message : String(e)
      errors.push(`${attempt.label}: ${message}`)
      log.warn(`Screenshot via ${attempt.label} failed (${message}); trying fallback`)
    }
  }

  throw new Error(`Could not capture screenshot (${errors.join('; ')})`)
}

function withTimeout(ms: number): AbortSignal {
  const c = new AbortController()
  setTimeout(() => c.abort(), ms)
  return c.signal
}

/** Returns `dir/name.ext`, appending `-2`, `-3`, ... until an unused name is found. */
export function uniquePath(dir: string, base: string, ext: string): string {
  for (let i = 1; i <= 100; i++) {
    const candidate = path.join(dir, i === 1 ? `${base}${ext}` : `${base}-${i}${ext}`)
    try {
      const fd = fs.openSync(candidate, 'wx')
      fs.closeSync(fd)
      return candidate
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
  }
  throw new Error('Could not find a free filename')
}