import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { app } from 'electron'
import { scope } from './logger.js'
import { ffmpegTo } from './ffmpeg.js'
import { THUMBNAIL, SCREENSHOT_FILENAME_ATTEMPTS, screenshotFileName } from '@shared/constants.js'

const log = scope('Thumbnail')

let thumbDir: string | null = null
const inFlight = new Map<string, Promise<string | null>>()

function dir(): string {
  if (!thumbDir) thumbDir = path.join(app.getPath('userData'), 'thumbnails')
  return thumbDir
}

function hashName(file: string): string {
  return crypto.createHash('sha1').update(file).digest('hex')
}

export function thumbnailPath(file: string, width: number = THUMBNAIL.GRID): string {
  return path.join(dir(), `${hashName(file)}-${width}.jpg`)
}

/** Removes every cached size for a file: a caller only knows the file, not the widths used. */
export function deleteThumbnail(file: string): void {
  const prefix = `${hashName(file)}-`
  let entries: string[]
  try {
    entries = fs.readdirSync(dir())
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue
    try {
      fs.rmSync(path.join(dir(), entry), { force: true })
    } catch {
      /* already gone */
    }
  }
}

function nonEmpty(p: string): boolean {
  try {
    return fs.statSync(p).size > 0
  } catch {
    return false
  }
}

/** Reads a cached thumbnail as a data URL, or null if it can't be produced. */
async function cachedOr(file: string, width: number, produce: (out: string) => Promise<void>): Promise<string | null> {
  // Keyed by size as well as path: the same clip at two widths is two cached files,
  // and neither should block the other.
  const key = `${file}|${width}`
  const existing = inFlight.get(key)
  if (existing) return existing

  const job = (async () => {
    if (!nonEmpty(file)) return null

    const out = thumbnailPath(file, width)
    try {
      const mtime = fs.statSync(file).mtimeMs
      // Regenerate only when the source is newer than our cached thumbnail.
      if (nonEmpty(out) && fs.statSync(out).mtimeMs >= mtime) {
        return dataUrl(out)
      }
      fs.mkdirSync(dir(), { recursive: true })
      await produce(out)
      // A delete can land while a frame is being grabbed. Leaving the file behind
      // would resurrect a cache entry for a clip that is gone.
      if (!fs.existsSync(file)) {
        try {
          fs.rmSync(out, { force: true })
        } catch {
          /* best effort */
        }
        return null
      }
      return nonEmpty(out) ? dataUrl(out) : null
    } catch (e) {
      log.warn(`Failed to generate thumbnail for ${path.basename(file)}:`, e)
      return null
    }
  })()

  inFlight.set(key, job)
  return job.finally(() => inFlight.delete(key))
}

function dataUrl(p: string): string {
  return `data:image/jpeg;base64,${fs.readFileSync(p).toString('base64')}`
}

/**
 * Clip thumbnail. Tries a seek to 1s first (more representative than frame 0,
 * which is often black on OBS recordings) and falls back to 0s on failure.
 */
export function clipThumbnail(file: string, width = THUMBNAIL.GRID): Promise<string | null> {
  return cachedOr(file, width, async (out) => {
    try {
      await ffmpegTo(
        ['-hide_banner', '-ss', String(THUMBNAIL.SEEK), '-i', file, '-frames:v', '1', '-q:v', String(THUMBNAIL.JPEG_QUALITY), '-vf', `scale=${width}:-2`],
        out,
      )
      if (nonEmpty(out)) return
    } catch (e) {
      log.warn(`Frame grab at ${THUMBNAIL.SEEK}s failed, retrying at 0s:`, e)
    }
    await ffmpegTo(
      ['-hide_banner', '-i', file, '-frames:v', '1', '-q:v', String(THUMBNAIL.JPEG_QUALITY), '-vf', `scale=${width}:-2`],
      out,
    )
  })
}

/** Screenshot thumbnail: single frame from the head, no seek. */
export function screenshotThumbnail(file: string, width = THUMBNAIL.GRID): Promise<string | null> {
  return cachedOr(file, width, async (out) => {
    await ffmpegTo(
      ['-hide_banner', '-i', file, '-frames:v', '1', '-q:v', String(THUMBNAIL.JPEG_QUALITY), '-vf', `scale=${width}:-2`],
      out,
    )
  })
}

// ---------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------
export { SCREENSHOT_FILENAME_ATTEMPTS, screenshotFileName }