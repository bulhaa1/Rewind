import { BrowserWindow, dialog, screen, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { scope } from './logger.js'
import { resolveIconPath } from './icons.js'
import {
  ffmpegTo,
  isCancelled,
  probe,
  probeDuration,
  runFfmpeg,
  resolveFfmpeg,
  uniquePath,
} from './ffmpeg.js'
import { isInside, nonEmptyString, shortString } from './util.js'
import { log as mainLog } from './logger.js'

const log = scope('ClipEditor')
const winLog = scope('EditorWindow')

const PREVIEW_DIR = path.join(require('os').tmpdir(), 'rewind-editor-preview')
const FFMPEG_MAP = ['-map', '0:v:0', '-map', '0:a?']

/** Active ffmpeg children, killed if the editor window dies mid-operation. */
const runningFfmpeg = new Set<any>()

/** Preview temps to clean when the editor closes. */
let previewFiles: string[] = []

function trackPreviewFiles(files: string[]): void {
  for (const f of files) {
    if (!previewFiles.includes(f)) previewFiles.push(f)
  }
}

function killRunningFfmpeg(): void {
  for (const child of runningFfmpeg) {
    try {
      child.kill('SIGKILL')
    } catch (e) {
      log.warn('Failed to kill ffmpeg subprocess:', e)
    }
  }
  runningFfmpeg.clear()
}

function cleanupPreviewFiles(): void {
  for (const f of previewFiles) {
    try {
      fs.unlinkSync(f)
    } catch {
      /* already gone */
    }
  }
  previewFiles = []
}

export function cleanupEditor(): void {
  killRunningFfmpeg()
  cleanupPreviewFiles()
}

// ---------------------------------------------------------------------------
// Clip info
// ---------------------------------------------------------------------------

export interface AudioTrackInfo {
  stream: number
  label: string
  previewPath: string | null
}

export interface ClipInfoResult {
  duration: number
  previewPath: string
  audioTracks: AudioTrackInfo[]
  /**
   * Size of the source clip in bytes.
   *
   * Only used to estimate what trimming saves. The estimate is arithmetic on
   * duration, not a measurement, because a stream copy trims by time and the
   * bitrate is not uniform across a clip. Presented as approximate for that
   * reason.
   */
  fileSize: number
}

interface ProbeAudioInfo {
  streamCount: number
  split: boolean
  labels: string[]
}

/**
 * Decides how to address the clip's audio streams, and names them.
 *
 * More than one stream in the file means the recording split its tracks, whatever
 * the app's settings say now — a clip carries its own layout for life, and gating on
 * the live label count silently collapsed every multi-track clip into one mix the
 * moment the setting was turned off. Stream 0 is the mix the recorder always writes,
 * so it is dropped when the tracks are split. Labels come from the recording; a clip
 * with no recorded labels still splits, with generic names.
 */
export function analyzeAudio(info: ProbeAudioInfo): { split: boolean; streams: number[]; labels: string[] } {
  if (info.streamCount === 0) return { split: false, streams: [], labels: [] }
  if (!info.split) return { split: false, streams: [0], labels: ['Audio'] }
  const streams = Array.from({ length: info.streamCount - 1 }, (_, i) => i + 1)
  return { split: true, streams, labels: streams.map((s) => info.labels[s] ?? `Track ${s}`) }
}

/**
 * Remux MKV to MP4 for preview: OBS can record MKV, but Chromium's demuxer is
 * unreliable with it, and a stream copy is cheap.
 */
/**
 * Remux MKV to MP4 for preview: OBS can record MKV, but Chromium's demuxer is
 * unreliable with it, and a stream copy is cheap.
 *
 * Same argument-order correction as extractTrackPreview: `-i` first, then the
 * output options. FFMPEG_MAP's input-side form only works when nothing else
 * competes with it, and `-c copy` in front of `-i` is exactly that competition.
 */
async function remuxForPreview(file: string): Promise<string> {
  fs.mkdirSync(PREVIEW_DIR, { recursive: true })
  const base = path.basename(file, path.extname(file))
  const out = uniquePath(PREVIEW_DIR, `${base}.${Date.now()}.preview`, '.mp4')

  await ffmpegTo(['-i', file, ...FFMPEG_MAP, '-c', 'copy', '-movflags', '+faststart'], out)
  return out
}

/** Extracts one audio stream to m4a so the renderer can decode a waveform. */
/**
 * Extracts one audio stream to m4a so the renderer can decode a waveform.
 *
 * Deliberately does NOT spread FFMPEG_MAP here. FFMPEG_MAP carries its `-map`
 * directives ahead of `-i`, which is the input-side form ffmpeg accepts when the
 * whole file is being remuxed. Adding a second `-map` after it, as this used to,
 * gave ffmpeg conflicting stream selections with output options placed before
 * the input; it exited -22 with "Invalid argument" and every audio lane past the
 * mix silently lost its waveform. `-i` has to come before any output option, so
 * this builds its argv in that order and maps exactly the one stream it wants.
 */
async function extractTrackPreview(file: string, stream: number, label: string, stamp: string): Promise<string> {
  fs.mkdirSync(PREVIEW_DIR, { recursive: true })
  const base = path.basename(file, path.extname(file))
  const out = path.join(PREVIEW_DIR, `${base}.${stamp}.track${stream}.m4a`)

  await ffmpegTo(['-i', file, '-map', `0:a:${stream}`, '-c', 'copy'], out)
  void label
  return out
}

export async function getClipInfo(file: string, recordedLabels: string[]): Promise<ClipInfoResult> {
  const info = await probe(file)
  const streamCount = info?.streams.filter((s) => s.codec_type === 'audio').length ?? 0
  const duration = await probeDuration(file)

  // Best-effort: a missing size only costs the savings estimate, and failing the
  // whole clip load over it would be a bad trade.
  let fileSize = 0
  try {
    fileSize = fs.statSync(file).size
  } catch (e) {
    log.warn(`Could not read the size of ${path.basename(file)}:`, e)
  }

  let previewPath = file
  const temps: string[] = []

  if (path.extname(file).toLowerCase() === '.mkv') {
    log.info(`Remuxing MKV for preview: ${path.basename(file)}`)
    previewPath = await remuxForPreview(file)
    temps.push(previewPath)
  }

  const analysis = analyzeAudio({ streamCount, split: streamCount > 1, labels: recordedLabels })
  const stamp = String(Date.now())

  const audioTracks: AudioTrackInfo[] = analysis.streams.map((s, i) => ({
    stream: s,
    label: analysis.labels[i],
    previewPath: analysis.split
      ? path.join(PREVIEW_DIR, `${path.basename(file, path.extname(file))}.${stamp}.track${s}.m4a`)
      : null,
  }))

  if (analysis.split) {
    for (const t of audioTracks) {
      if (!t.previewPath) continue
      try {
        const produced = await extractTrackPreview(file, t.stream, t.label, stamp)
        if (produced !== t.previewPath) {
          temps.push(produced)
          t.previewPath = produced
        }
      } catch (e) {
        if (isCancelled(e)) throw e
        log.warn(`Failed to extract audio track ${t.stream}:`, e)
      }
    }
  }

  trackPreviewFiles(temps.filter(Boolean))

  return { duration, previewPath, audioTracks, fileSize }
}

/**
 * Decodes one audio track to mono f32 PCM and reduces it to a peak envelope.
 * The renderer draws this directly, so no audio decoding happens in the browser.
 */
export async function getTrackPeaks(file: string, stream: number, bucketCount = 2000): Promise<number[]> {
  const chunks: Buffer[] = []

  await new Promise<void>((resolve, reject) => {
    const chunksStream = new (require('stream').PassThrough)()
    chunksStream.on('data', (c: Buffer) => chunks.push(c))
    chunksStream.on('end', resolve)
    chunksStream.on('error', reject)

    const child = runFfmpeg([
      ...FFMPEG_MAP, '-map', `0:a:${stream}`, '-ac', '1', '-ar', '2000',
      '-f', 'f32le', '-i', file,
    ])

    const proc = require('child_process').spawn(
      resolveFfmpeg(),
      ['-hide_banner', '-v', 'quiet', '-i', file, '-map', `0:a:${stream}`, '-ac', '1', '-ar', '2000', '-f', 'f32le', '-'],
      { windowsHide: true },
    )
    runningFfmpeg.add(proc)

    proc.stdout?.pipe(chunksStream)
    proc.on('error', (e: Error) => {
      runningFfmpeg.delete(proc)
      reject(e)
    })
    proc.on('close', (code: number) => {
      runningFfmpeg.delete(proc)
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exited with code ${code}`))
    })

    void child
  })

  const buf = Buffer.concat(chunks)
  const samples = Math.floor(buf.length / 4)
  if (samples === 0) return []

  const step = Math.max(1, Math.ceil(samples / bucketCount))
  const peaks: number[] = []

  for (let i = 0; i < samples; i += step) {
    let peak = 0
    const end = Math.min(i + step, samples)
    for (let j = i; j < end; j++) {
      const v = Math.abs(buf.readFloatLE(j * 4))
      if (v > peak) peak = v
    }
    peaks.push(Math.round(Math.min(peak, 1) * 1000) / 1000)
  }

  return peaks
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

/** Pick a non-colliding `name-edit.mp4` (or `-edit-2`, ...) beside the source. */
function copyTargetPath(dir: string, base: string, ext: string): string {
  const first = path.join(dir, `${base}-edit${ext}`)
  if (!fs.existsSync(first)) return first
  for (let i = 2; i < 1000; i++) {
    const candidate = path.join(dir, `${base}-edit-${i}${ext}`)
    if (!fs.existsSync(candidate)) return candidate
  }
  throw new Error(`Could not find available copy path for "${base}${ext}" (1000 collisions)`)
}

/** Stream-copy trim: no re-encode, so it's fast and lossless. */
async function trimCopy(source: string, out: string, startSec: number, endSec: number): Promise<void> {
  await ffmpegTo(
    ['-ss', String(startSec), '-t', String(endSec - startSec), '-i', source, ...FFMPEG_MAP, '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart'],
    out,
  )
}

const RENAME_BACKOFF_MS = [100, 250, 500, 1000, 2000]

/** Renames with retries, since a just-closed muxer can still hold a transient handle. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  let lastError: Error | null = null
  for (let attempt = 0; attempt <= RENAME_BACKOFF_MS.length; attempt++) {
    try {
      fs.renameSync(from, to)
      if (attempt > 0) log.info(`Rename succeeded after ${attempt} retries: ${to}`)
      return
    } catch (e) {
      lastError = e as Error
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw e
      if (attempt === RENAME_BACKOFF_MS.length) break
      await new Promise((r) => setTimeout(r, RENAME_BACKOFF_MS[attempt]))
    }
  }
  throw lastError ?? new Error('Rename failed')
}

/**
 * Re-encodes audio when per-track volumes were adjusted, keeping video as a copy.
 *
 * When tracks are split, each is normalized then mixed; otherwise only track 0's
 * volume is scaled and the rest pass through untouched.
 */
async function trimWithAudioMix(
  source: string,
  out: string,
  startSec: number,
  endSec: number,
  probeInfo: ProbeAudioInfo,
  volumes: { stream: number; volume: number }[],
): Promise<void> {
  const volFor = (s: number) => volumes.find((v) => v.stream === s)?.volume ?? 1
  const analysis = analyzeAudio(probeInfo)
  const filters: string[] = []
  const maps: string[] = ['-map', '0:v:0']
  const codecs: string[] = ['-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k']

  if (probeInfo.split) {
    for (const s of analysis.streams) filters.push(`[0:a:${s}]volume=${volFor(s)},asplit=2[t${s}][m${s}]`)
    filters.push(`${analysis.streams.map((s) => `[m${s}]`).join('')}amix=inputs=${analysis.streams.length}:normalize=0[mix]`)
    maps.push('-map', '[mix]', ...analysis.streams.flatMap((s) => ['-map', `[t${s}]`]))
  } else {
    filters.push(`[0:a:0]volume=${volFor(0)}[a0]`)
    maps.push('-map', '[a0]')
    for (let s = 1; s < probeInfo.streamCount; s++) {
      maps.push('-map', `0:a:${s}`)
      codecs.push(`-c:a:${s}`, 'copy')
    }
  }

  const args = [
    '-ss', String(startSec), '-noaccurate_seek', '-i', source,
    ...maps,
    ...codecs,
    '-t', String(endSec - startSec),
    ...(filters.length ? ['-filter_complex', filters.join(';')] : []),
    '-avoid_negative_ts', 'make_zero',
    '-movflags', '+faststart',
  ]

  await ffmpegTo(args, out)
}

export interface SaveClipRequest {
  clipPath: string
  startSec: number
  endSec: number
  mode: 'overwrite' | 'copy'
  trackVolumes?: { stream: number; volume: number }[]
}

export interface SaveClipDeps {
  getMainWindow: () => BrowserWindow | null
  onCopied: (path: string, originalRecordedAt: number, source?: string | null) => void
  onReplaced: (path: string, editedAt: number) => void
  getClipMeta: (p: string) => { recordedAt?: number; source?: string; audioTracks?: string[] } | null
  getAudioTrackLabels: () => string[]
}

export async function saveClip(req: SaveClipRequest, deps: SaveClipDeps): Promise<string> {
  if (!fs.existsSync(req.clipPath)) throw new Error('Source clip not found')
  if (req.endSec - req.startSec < 1) throw new Error('Trim range too short')

  const dir = path.dirname(req.clipPath)
  const ext = path.extname(req.clipPath)
  const base = path.basename(req.clipPath, ext)
  const temp = path.join(dir, `${base}.trim-${Date.now()}${ext}`)

  const meta = deps.getClipMeta(req.clipPath)
  const recordedAt = meta?.recordedAt ?? Date.now()

  const volumes = req.trackVolumes ?? []
  const needsAudioWork = volumes.some((v) => v.volume !== 1)

  try {
    if (needsAudioWork) {
      const info = await probe(req.clipPath)
      const probeInfo: ProbeAudioInfo = {
        streamCount: info?.streams.filter((s) => s.codec_type === 'audio').length ?? 0,
        // Same rule the lanes were drawn with: a split must be honoured on save even
        // when the clip has no recorded labels, or the volumes the user just dragged
        // on lanes 2 and 3 would be silently dropped.
        split: false,
        labels: deps.getAudioTrackLabels(),
      }
      probeInfo.split = probeInfo.streamCount > 1
      await trimWithAudioMix(req.clipPath, temp, req.startSec, req.endSec, probeInfo, volumes)
    } else {
      await trimCopy(req.clipPath, temp, req.startSec, req.endSec)
    }
  } catch (e) {
    if (fs.existsSync(temp)) {
      try {
        fs.unlinkSync(temp)
      } catch {
        /* noop */
      }
    }
    throw e
  }

  if (req.mode === 'copy') {
    const target = copyTargetPath(dir, base, ext)
    await renameWithRetry(temp, target)
    log.info(`Saved trimmed copy: ${target}`)
    deps.onCopied(target, recordedAt, meta?.source)
    return target
  }

  try {
    await renameWithRetry(temp, req.clipPath)
  } catch (e) {
    if (fs.existsSync(temp)) {
      try {
        fs.unlinkSync(temp)
      } catch {
        /* noop */
      }
    }
    throw new Error(`Failed to replace original clip: ${(e as Error).message}`)
  }

  deps.onReplaced(req.clipPath, Date.now())
  return req.clipPath
}

// ---------------------------------------------------------------------------
// Editor window
// ---------------------------------------------------------------------------

let editorWindow: BrowserWindow | null = null
let openRequest: { clipPath: string } | null = null

const EDITOR_WIDTH = 900
const EDITOR_HEIGHT = 840
const EDITOR_MIN_WIDTH = 720
const EDITOR_MIN_HEIGHT = 600

/**
 * Opens the editor in a second window pointing at the same renderer entry.
 *
 * The editor is a view mode selected by query param, not a router path, so the main
 * bundle serves both.
 */
export function openEditorWindow(clipPath: string, preloadPath: string, rendererDir: string): void {
  const indexHtml = path.join(rendererDir, 'index.html')
  const devUrl = process.env.REWIND_DEV_SERVER
  const urlFor = (p: string) => {
    const query = `?editor=1&clipPath=${encodeURIComponent(p)}`
    return devUrl ? `${devUrl}${query}` : `file://${indexHtml}${query}`
  }

  if (editorWindow && !editorWindow.isDestroyed()) {
    /*
     * Reuse the window, but point it at the clip that was actually asked for.
     *
     * This used to just focus and return, which meant editing clip B while clip A
     * was open silently showed clip A -- and nothing on screen said so. That is a
     * data-integrity bug, not a cosmetic one: you can trim and save over the wrong
     * clip believing you opened the right one.
     *
     * Reloading with the new query reuses the same load path as a first open, so
     * the renderer's startup stays the single way a clip gets loaded.
     */
    log.info('Editor window already open; reloading for the requested clip')
    openRequest = { clipPath }
    // Abort any decode still running for the previous clip before its output is
    // orphaned by the reload.
    killRunningFfmpeg()
    void editorWindow.loadURL(urlFor(clipPath)).catch((e) => {
      log.error('Failed to reload the editor for the requested clip:', e)
    })
    editorWindow.focus()
    return
  }

  const display = screen.getPrimaryDisplay()
  const { width: areaW, height: areaH } = display.workAreaSize
  const height = Math.min(EDITOR_HEIGHT, areaH)
  const x = Math.round((areaW - EDITOR_WIDTH) / 2)
  const y = Math.round((areaH - height) / 2)

  editorWindow = new BrowserWindow({
    width: EDITOR_WIDTH,
    height,
    minWidth: EDITOR_MIN_WIDTH,
    minHeight: EDITOR_MIN_HEIGHT,
    x,
    y,
    show: false,
    frame: true,
    resizable: true,
    title: 'Rewind: Edit Clip',
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
    icon: resolveIconPath(),
  })

  openRequest = { clipPath }
  editorWindow.setMenuBarVisibility(false)
  editorWindow.once('ready-to-show', () => {
    editorWindow?.show()
    editorWindow?.focus()
  })

  editorWindow.loadURL(urlFor(clipPath))
  if (devUrl) editorWindow.webContents.openDevTools()

  editorWindow.on('closed', () => {
    cleanupEditor()
    openRequest = null
    editorWindow = null
    log.info('Editor window closed')
  })

  log.info(`Editor window opened for: ${clipPath}`)
}

/** The clip path the open editor window was launched with. */
export function currentEditorClip(): { clipPath: string } | null {
  return openRequest
}

export function closeEditorWindow(): void {
  if (editorWindow && !editorWindow.isDestroyed()) editorWindow.close()
}

export { isInside, nonEmptyString, shortString, dialog, shell, mainLog }