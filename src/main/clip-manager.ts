import fs from 'node:fs'
import path from 'node:path'
import { scope } from './logger.js'
import { isInside, isReservedDeviceName, nonEmptyString } from './util.js'
import { probeClip, probeDuration, probe, type ClipProbe } from './ffmpeg.js'
import { clipMeta, type ClipMeta } from './store.js'
import { setClipMeta } from './clip-meta.js'
import { RECORDING_PREFIX, REPLAY_PREFIX, parseRecordingStamp, THUMBNAIL } from '@shared/constants.js'
import { recordBitrateSample } from '@shared/buffer-memory.js'
import { getSetting, setSetting } from './store.js'
import { VBR_KBPS_BY_QUALITY, type VisualQuality } from '@shared/constants.js'
import type { ClipInfo, DeleteScope } from '@shared/types.js'

const log = scope('ClipManager')

const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.mov', '.avi', '.webm']

export function isVideoFile(p: string): boolean {
  return VIDEO_EXTENSIONS.includes(path.extname(p).toLowerCase())
}

/**
 * A file the editor's "Save as Copy" produced: `<name>-edit.mp4`, or
 * `<name>-edit-2.mp4` and onward when that name is taken.
 */
const EDIT_SUFFIX = /-edit(-\d+)?$/

/**
 * A trim in progress: the editor writes `<name>.trim-<timestamp>.mp4` beside the
 * source clip and renames it over the original when ffmpeg finishes
 * (`editor.ts:381`). It exists for the length of one encode, so the library must
 * never surface it.
 *
 * The `.trim-` infix matters more than it looks. These files carry the `Replay`
 * prefix, so the "written by Rewind, adopt by name" rule below would otherwise
 * wave every one of them straight into the library while it is still growing.
 */
const TRIM_TEMP_INFIX = /\.trim-\d+\./

export function isEditorCopy(fileName: string): boolean {
  const i = fileName.lastIndexOf('.')
  const stem = i > 0 ? fileName.slice(0, i) : fileName
  return EDIT_SUFFIX.test(stem)
}

export function isTrimTemporary(fileName: string): boolean {
  return TRIM_TEMP_INFIX.test(fileName)
}

/**
 * Turns a raw capture-source label into a folder name.
 *
 * Strips the `[exe.exe]: ` prefix and any `(process: exe)` suffix, then removes
 * characters Windows forbids in a path segment. Without that last step a title
 * like `Rewind | OpenChamber` produces an uncreatable directory and the clip is
 * stranded in the base folder.
 */
export function toSubfolderName(sourceName: string): string {
  let s = sourceName.trim()
  s = s.replace(/^\[[^\]]+\]\s*:?\s*/, '').trim()
  const proc = s.match(/\(process[:\s]+([^)]+)\)/i)
  if (proc) s = proc[1].replace(/\.exe$/i, '').trim()

  // Control chars first (they'd otherwise survive the visible-char filter), then
  // the Windows-illegal set.
  const collapsed = s
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
    .replace(/[. ]+$/, '')
    .trim()

  if (!collapsed || isReservedDeviceName(collapsed)) return 'Unknown'
  return collapsed
}

/**
 * Moves the saved replay into a per-source subfolder.
 *
 * Rename is attempted first; a cross-volume or locked file falls back to
 * copy+unlink so the clip is never lost.
 */
export function moveIntoSourceFolder(file: string, sourceName: string, outputRoot: string): string {
  if (!file || !fs.existsSync(file)) return file

  const folder = path.join(outputRoot, toSubfolderName(sourceName))

  try {
    if (!fs.existsSync(folder)) {
      fs.mkdirSync(folder, { recursive: true })
      log.info(`Created source subfolder: ${folder}`)
    }
  } catch (e) {
    log.warn(`Cannot create subfolder ${folder}, keeping clip in base directory:`, e)
    return file
  }

  const target = path.join(folder, path.basename(file))
  if (target === file) return file

  try {
    fs.renameSync(file, target)
    log.info(`Moved replay to: ${target}`)
    return target
  } catch {
    try {
      fs.copyFileSync(file, target)
      fs.unlinkSync(file)
      log.info(`Copied replay to: ${target}`)
      return target
    } catch (e) {
      log.warn('Could not move replay to subfolder:', e)
      return file
    }
  }
}

/**
 * Windows silently refuses to create directories ending in a dot or space, so the
 * original can leave such folders behind when a source label trims oddly. Repair them
 * on scan rather than making those clips invisible forever.
 */
/**
 * Registers a recording the replay buffer finished on teardown.
 *
 * Stopping the buffer while a continuous recording is running finishes that
 * recording rather than discarding it. The stitching happens in `replay-buffer`
 * because it needs the output still alive; this puts the finished file where a
 * user can find it, records what it is, and tells the renderer so the library
 * updates without waiting for a rescan.
 *
 * This lives here rather than inline because two call sites need it: the
 * panel's Stop button and the Start/Stop hotkey both end the buffer, and only
 * one of them used to do this. A recording left unregistered is not lost, but
 * it sits in the library root with no source and a timestamp guessed from its
 * filename.
 *
 * `audioTracks` is passed in rather than read here: it describes the app's
 * current audio layout, and this module has no handle on the OBS pipeline.
 */
export function registerFinishedRecording(
  finished: string,
  sourceName: string,
  outputRoot: string,
  audioTracks: string[] | undefined,
): string {
  const moved = moveIntoSourceFolder(finished, sourceName, outputRoot)
  setClipMeta(moved, {
    recordedAt: Date.now(),
    source: sourceName,
    ...(audioTracks ? { audioTracks } : {}),
  })
  return moved
}

export function repairTrailingDotFolders(root: string): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !/[. ]$/.test(entry.name)) continue

    const from = path.join(root, entry.name)
    const to = path.join(root, toSubfolderName(entry.name))

    try {
      if (!fs.existsSync(to)) {
        fs.renameSync(from, to)
      } else {
        for (const child of fs.readdirSync(from)) {
          fs.renameSync(path.join(from, child), path.join(to, child))
        }
        fs.rmdirSync(from)
      }
      log.info(`Repaired subfolder with trailing dot/space: "${entry.name}" -> "${path.basename(to)}"`)
    } catch (e) {
      log.warn(`Failed to repair subfolder "${entry.name}":`, e)
    }
  }
}

/** Files the library should surface: real recordings and editor copies, not temporaries. */
function shouldInclude(fullPath: string, fileName: string, metaKeys: Set<string>, uploadKeys: Set<string>): boolean {
  if (!fileName.endsWith('.mp4') && !fileName.endsWith('.mkv')) return false
  // A trim in progress is a half-written file that is about to be renamed over
  // its source. Listing it would show a clip that is about to stop existing.
  if (isTrimTemporary(fileName)) return false
  // Editor copies ARE library items. They used to be excluded here, which made
  // "Save as Copy" write a file the user could never open again.
  // Files Rewind wrote itself are recognised by name, so they survive even if the
  // metadata sidecar is lost or the user moves the file. Gating them on metadata
  // alone meant a continuous recording could silently vanish from the library.
  if (fileName.startsWith(REPLAY_PREFIX) || fileName.startsWith(RECORDING_PREFIX)) return true
  if (isEditorCopy(fileName)) return true
  return metaKeys.has(fullPath) || uploadKeys.has(fullPath)
}

/**
 * Builds the clip library by walking the output tree.
 *
 * Metadata is layered over filesystem facts: filename timestamp first, then the
 * persisted clip-meta record, then an ffprobe when duration is missing or the file
 * changed since it was last measured.
 */
export async function scanClips(outputRoot: string): Promise<ClipInfo[]> {
  if (!fs.existsSync(outputRoot)) return []
  repairTrailingDotFolders(outputRoot)

  const meta = clipMeta.get('clips') ?? {}
  const metaKeys = new Set(Object.keys(meta))
  const uploadKeys = new Set<string>()

  const found: { fullPath: string; filename: string; sourceName?: string }[] = []

  const walk = async (dir: string, sourceName?: string) => {
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full, entry.name)
      } else if (entry.isFile() && shouldInclude(full, entry.name, metaKeys, uploadKeys)) {
        found.push({ fullPath: full, filename: entry.name, sourceName })
      }
    }
  }
  await walk(outputRoot)

  const out: ClipInfo[] = []
  const metaUpdates: Record<string, (typeof meta)[string]> = {}

  for (const item of found) {
    let st: fs.Stats
    try {
      st = await fs.promises.stat(item.fullPath)
    } catch {
      continue
    }

    const record = meta[item.fullPath]
    const recordedAt =
      record?.recordedAt ?? parseRecordingStamp(item.filename) ?? Math.round(st.mtimeMs / 1000) * 1000

    // Re-probe when we have never measured, or when the file changed underneath us.
    const stale = record?.duration === undefined || record?.probedSize !== st.size
    let duration = record?.duration ?? 0
    if (stale) {
      duration = await probeDuration(item.fullPath)
      metaUpdates[item.fullPath] = { recordedAt, duration, probedSize: st.size }
    }

    out.push({
      id: item.fullPath,
      path: item.fullPath,
      filename: item.filename,
      recordedAt,
      edited: record?.edited,
      editedAt: record?.editedAt,
      duration,
      fileSize: st.size,
      sourceName: item.sourceName ?? record?.source ?? null,
      localExists: true,
      audioTracks: record?.audioTracks ?? ['Mix'],
    })
  }

  if (Object.keys(metaUpdates).length > 0) {
    /*
     * Merged per path against a fresh read, not the scan's own snapshot.
     *
     * This scan reads the store once, up front, and probing takes seconds. A clip
     * saved in that window was stamped with fields this snapshot never saw —
     * `source` and `audioTracks` above all — and writing either the whole map or the
     * per-clip record wholesale threw them away. That cost every clip its recorded
     * track layout about a second after it was written.
     */
    const current = clipMeta.get('clips') ?? {}
    const merged: Record<string, ClipMeta> = { ...current }
    for (const [p, rec] of Object.entries(metaUpdates)) merged[p] = { ...current[p], ...rec }
    clipMeta.set('clips', merged)
  }

  return out.sort((a, b) => b.recordedAt - a.recordedAt)
}

/**
 * Probes a saved clip and logs the full description.
 * Returns the probe so the caller can stamp the measured duration without a
 * second ffprobe pass.
 *
 * `quality` is the diagnostic target string ("CQP 20") that goes in the log.
 * `qualityTier` is the actual tier ('high') and is what the bitrate observation
 * is filed under; it is separate because the two are not interchangeable and
 * conflating them silently files every observation under nothing.
 */
export async function describeSavedClip(
  file: string,
  vendor: string,
  encoder: string,
  quality: string,
  sourceType: string,
  qualityTier?: string,
): Promise<ClipProbe | null> {
  const sizeMB = (() => {
    try {
      return Math.round((fs.statSync(file).size / (1024 * 1024)) * 100) / 100
    } catch {
      return undefined
    }
  })()

  try {
    const info = await probeClip(file)
    if (!info) {
      log.info(`Clip saved: ${path.basename(file)} size=${sizeMB ?? '?'}MB vendor=${vendor} encoder=${encoder} quality=${quality} (metadata probe failed)`)
      return null
    }
    log.info(
      `Clip saved: ${path.basename(file)} size=${sizeMB ?? '?'}MB duration=${info.durationSec}s ` +
      `bitrate=${info.bitrateKbps}kbps codec=${info.codec} res=${info.width}x${info.height}@${info.fps}fps ` +
      `vendor=${vendor} encoder=${encoder} quality=${quality} source=${sourceType}`,
    )
    recordAchievedBitrate(qualityTier ?? quality, info.bitrateKbps)
    return info
  } catch (e) {
    log.warn(`Failed to probe saved clip ${path.basename(file)}:`, e)
    return null
  }
}

/**
 * Fold a saved clip's achieved bitrate into the per-quality running average.
 *
 * The settings screen's buffer-memory readout needs a bitrate, and the only one
 * that describes this machine's encoder is one it has actually produced.
 * `VBR_KBPS_BY_QUALITY` is an x264 target table, while every hardware encoder
 * here runs CQP/ICQ and emits whatever the content demands, so learning it from
 * real clips is the difference between a readout worth trusting and one that is
 * wrong by roughly 8x.
 *
 * Best effort by design: this runs after the clip is already saved and logged,
 * so a store failure here must never surface as a failed save.
 */
function recordAchievedBitrate(quality: string, totalFileKbps: number): void {
  if (!(quality in VBR_KBPS_BY_QUALITY)) return
  const tier = quality as VisualQuality
  try {
    const observed = getSetting('observedVideoKbpsByQuality')
    const previous = Array.isArray(observed?.[tier]) ? (observed[tier] as number[]) : []
    const next = recordBitrateSample(previous, totalFileKbps)
    // A rejected probe returns the history unchanged; writing it anyway would be
    // indistinguishable from a real measurement.
    if (next.length === previous.length && next.every((v, i) => v === previous[i])) return
    setSetting('observedVideoKbpsByQuality', { ...observed, [tier]: next })
  } catch (e) {
    log.warn('Failed to record achieved bitrate:', e)
  }
}

export async function stampDuration(file: string, knownDuration?: number): Promise<number | undefined> {
  const duration = knownDuration && knownDuration > 0 ? Math.round(knownDuration) : await probeDuration(file)
  if (duration <= 0) {
    log.warn(`Duration probe produced nothing usable for ${file}; leaving it unstamped`)
    return undefined
  }
  return duration
}

export class RenameRejected extends Error {}

const MAX_NAME_LENGTH = 100

/** Validates a user-supplied clip name against Windows' filename rules. */
export function validateClipName(raw: string): { ok: true; name: string } | { ok: false; reason: string } {
  const name = raw.trim()
  if (!name) return { ok: false, reason: 'Name cannot be empty' }
  if (isReservedDeviceName(name)) return { ok: false, reason: `"${name}" is a name Windows reserves for a device` }
  if (name.endsWith('.')) return { ok: false, reason: 'Name cannot end with a dot' }
  if (/[<>:"/\\|?*]/.test(name)) return { ok: false, reason: 'Name cannot contain < > : " / \\ | ? *' }
  if (name.length > MAX_NAME_LENGTH) return { ok: false, reason: `Name must be ${MAX_NAME_LENGTH} characters or fewer` }
  return { ok: true, name }
}

/** Modification time in ms, or now if the file can't be stat'ed. */
function statMtimeMs(p: string): number {
  try {
    return Math.round(fs.statSync(p).mtimeMs)
  } catch {
    return Date.now()
  }
}

/**
 * Renames a clip and carries its metadata and cached thumbnail across,
 * so the library entry stays attached to the file.
 */
export function renameClip(file: string, rawName: string, carryThumbnail: (from: string, to: string) => void): string {
  const validated = validateClipName(rawName)
  if (!validated.ok) throw new RenameRejected(validated.reason)
  if (!fs.existsSync(file)) throw new RenameRejected('Clip not found')

  const target = path.join(path.dirname(file), `${validated.name}${path.extname(file)}`)
  if (target === file) return file
  if (target.toLowerCase() !== file.toLowerCase() && fs.existsSync(target)) {
    throw new RenameRejected('A clip with that name already exists')
  }

  fs.renameSync(file, target)

  // Carry auxiliary records across so the library doesn't lose the entry.
  //
  // An entry is always written for the target, even when the source had none: the
  // scanner only adopts non-`Replay` filenames it has metadata for, so a renamed
  // clip without a record would silently vanish from the list.
  const meta = clipMeta.get('clips') ?? {}
  const carried = meta[file] ?? { recordedAt: statMtimeMs(file) }
  const next = { ...meta, [target]: carried }
  delete next[file]
  clipMeta.set('clips', next)
  try {
    carryThumbnail(file, target)
  } catch (e) {
    log.error(`Renamed ${path.basename(file)} but failed to carry its thumbnail across:`, e)
  }

  log.info(`Renamed clip: ${path.basename(file)} -> ${path.basename(target)}`)
  return target
}

/** Deletes a clip within the requested scope. Cloud scope is a no-op (no backend). */
export function deleteClip(file: string, scope: DeleteScope, onThumbnailDeleted: (f: string) => void): void {
  if (scope !== 'local') return

  if (fs.existsSync(file)) {
    try {
      fs.unlinkSync(file)
      log.info(`Deleted local clip: ${file}`)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
  } else {
    log.info(`Local clip was already gone, clearing its leftovers: ${file}`)
  }

  try {
    const meta = clipMeta.get('clips') ?? {}
    delete meta[file]
    clipMeta.set('clips', meta)
  } catch (e) {
    log.warn(`Deleted ${path.basename(file)} but failed to drop its metadata:`, e)
  }

  onThumbnailDeleted(file)
}

/**
 * Rejects paths outside the configured output directory before touching the disk.
 *
 * Always returns an object (never a bare string) so callers can discriminate on
 * `'error' in result` without tripping over the `in` operator on a primitive.
 */
export function resolveClipPath(
  candidate: unknown,
  outputRoot: string,
  label: string,
): { path: string; error?: undefined } | { error: string; path?: undefined } {
  if (!nonEmptyString(candidate)) return { error: 'Invalid file path' }
  if (!isInside(candidate, outputRoot)) {
    log.warn(`Rejected ${label} outside ${path.basename(outputRoot)}:`, candidate)
    return { error: 'Invalid file path' }
  }
  if (!isVideoFile(candidate)) {
    log.warn(`Rejected ${label} of disallowed file type:`, candidate)
    return { error: 'Only video files are supported' }
  }
  return { path: candidate }
}

export { probe, THUMBNAIL }