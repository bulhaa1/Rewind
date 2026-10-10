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

export function thumbnailPath(file: string): string {
  return path.join(dir(), `${hashName(file)}.jpg`)
}

export function deleteThumbnail(file: string): void {
  try {
    fs.rmSync(thumbnailPath(file), { force: true })
  } catch {
    /* already gone */
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
async function cachedOr(file: string, produce: (out: string) => Promise<void>): Promise<string | null> {
  const existing = inFlight.get(file)
  if (existing) return existing

  const job = (async () => {
    if (!nonEmpty(file)) return null

    const out = thumbnailPath(file)
    try {
      const mtime = fs.statSync(file).mtimeMs
      // Regenerate only when the source is newer than our cached thumbnail.
      if (nonEmpty(out) && fs.statSync(out).mtimeMs >= mtime) {
        return dataUrl(out)
      }
      fs.mkdirSync(dir(), { recursive: true })
      await produce(out)
      return nonEmpty(out) ? dataUrl(out) : null
    } catch (e) {
      log.warn(`Failed to generate thumbnail for ${path.basename(file)}:`, e)
      return null
    }
  })()

  inFlight.set(file, job)
  return job.finally(() => inFlight.delete(file))
}

function dataUrl(p: string): string {
  return `data:image/jpeg;base64,${fs.readFileSync(p).toString('base64')}`
}

/**
 * Clip thumbnail. Tries a seek to 1s first (more representative than frame 0,
 * which is often black on OBS recordings) and falls back to 0s on failure.
 */
export function clipThumbnail(file: string, width = THUMBNAIL.GRID): Promise<string | null> {
  return cachedOr(file, async (out) => {
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
  return cachedOr(file, async (out) => {
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