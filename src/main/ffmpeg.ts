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
}

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

/** Duration in whole seconds, or 0 when unknown. */
export async function probeDuration(file: string): Promise<number> {
  const info = await probe(file)
  const d = Number(info?.format?.duration)
  return d ? Math.round(d) : 0
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
 * Duplication permits only a few concurrent sessions and Reflect already holds one
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