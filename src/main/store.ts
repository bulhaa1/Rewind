import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { DEFAULT_SETTINGS } from '@shared/constants.js'
import type { PersistedSettings } from '@shared/types.js'
import { scope } from './logger.js'

const log = scope('Store')

/**
 * Small JSON-file store. Writes are atomic (temp file + rename) and a corrupt file
 * is preserved as `*.corrupt-<ts>.json` rather than silently discarded.
 */
class JsonStore<T extends object> {
  constructor(
    private readonly filePath: string,
    private readonly defaults: T,
  ) {}

  /** Last good copy. Also means one parse per run instead of one per read. */
  private cached: T | null = null
  /** Set when the file exists but could not be read; writes stand down until it can. */
  private unreadable = false

  private read(): T {
    if (this.cached) return this.cached
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        this.unreadable = false
        return (this.cached = parsed as T)
      }
      this.backupCorrupt()
    } catch (e) {
      // A missing file is a first run. Unparseable text is corruption. Anything else
      // - a lock, a sharing violation, a permission error - is neither, and treating
      // it as corruption is how a whole file of settings, or the clip metadata, got
      // replaced by defaults on the next write.
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return (this.cached = { ...this.defaults })
      if (e instanceof SyntaxError) {
        this.backupCorrupt()
        return (this.cached = { ...this.defaults })
      }
      log.error(`Could not read ${path.basename(this.filePath)}; keeping what we had:`, e)
      this.unreadable = true
      return this.cached ?? { ...this.defaults }
    }
    return (this.cached = { ...this.defaults })
  }

  private backupCorrupt(): void {
    try {
      if (!fs.existsSync(this.filePath)) return
      const backup = this.filePath.replace(/\.json$/, `.corrupt-${Date.now()}.json`)
      fs.copyFileSync(this.filePath, backup)
      log.warn(`${path.basename(this.filePath)} was not valid JSON; reset to defaults, original kept as ${path.basename(backup)}`)
    } catch {
      log.warn(`${path.basename(this.filePath)} was unreadable; resetting to defaults`)
    }
  }

  private write(next: T): void {
    if (this.unreadable) {
      // Throw rather than return: a refused write must not look like a saved setting.
      // IPC handlers turn this into a failed invoke, so the panel shows an error
      // instead of confirming a change that will be gone at the next launch.
      throw new Error(`${path.basename(this.filePath)} could not be read; refusing to overwrite it`)
    }
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      const tmp = `${this.filePath}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(next, null, '\t'), 'utf8')
      fs.renameSync(tmp, this.filePath)
      this.cached = next
    } catch (e) {
      log.error(`Failed to persist ${path.basename(this.filePath)}:`, e)
    }
  }

  get<K extends keyof T>(key: K): T[K] {
    const data = this.read()
    return (data[key] ?? this.defaults[key]) as T[K]
  }

  set<K extends keyof T>(key: K, value: T[K]): void {
    const data = this.read()
    data[key] = value
    this.write(data)
  }

  all(): T {
    return { ...this.defaults, ...this.read() }
  }

  replace(data: T): void {
    this.write(data)
  }
}

function storeFile<T extends object>(name: string, defaults: T): JsonStore<T> {
  return new JsonStore<T>(path.join(app.getPath('userData'), `${name}.json`), defaults)
}

export const settings: JsonStore<PersistedSettings> = storeFile('settings', DEFAULT_SETTINGS)

/** Typed read/write over the settings store. */
export function getSetting<K extends keyof PersistedSettings>(key: K): PersistedSettings[K] {
  return settings.get(key)
}

export function setSetting<K extends keyof PersistedSettings>(key: K, value: PersistedSettings[K]): void {
  settings.set(key, value)
}

/** Clip metadata: path -> { recordedAt, source, audioTracks, duration, probedSize, edited, editedAt }. */
export interface ClipMeta {
  recordedAt: number
  source?: string
  audioTracks?: string[]
  duration?: number
  probedSize?: number
  edited?: boolean
  editedAt?: number
}
export const clipMeta = storeFile('clip-meta', { clips: {} as Record<string, ClipMeta> })

/** Screenshot metadata: path -> { capturedAt, source }. */
export const screenshotMeta = storeFile('screenshot-meta', { screenshots: {} as Record<string, { capturedAt: number; source?: string }> })