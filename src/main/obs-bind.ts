/**
 * Thin, typed wrapper over `@streamlabs/obs-studio-node` 0.25.x.
 *
 * The 0.25 API is factory/singleton based (not the 0.2x `OBSStudio.Initialize()` style),
 * so everything the app touches is funnelled through here. Keeping it in one module
 * means a future OBS engine swap has a single seam to target.
 */
import path from 'node:path'
import { app } from 'electron'
import { scope } from './logger.js'

const log = scope('OBS')

export type EInputSlot =
  | 0 // SCENE
  | 1 // DESKTOP
  | 2 // MICROPHONE
  | 3 // APP_BASE
  | 20 // DEVICE_BASE

/** Anything the OBS module exposes; we only reach for these members. */
export interface ObsModule {
  NodeObs: {
    IPC: { host: (name: string) => void; disconnect: () => void; setServerPath?: (p: string) => void }
    SetWorkingDirectory: (dir: string) => void
    OBS_API_initAPI: (locale: string, dataPath: string, version: string) => number
    OBS_settings_getSettings: (section: string) => { data?: unknown } | null
    OBS_settings_saveSettings: (section: string, data: unknown) => void
    OBS_service_resetVideoContext: () => void
    OBS_service_resetAudioContext: () => void
    OBS_service_removeCallback: () => void
    InitShutdownSequence: () => void
    RegisterSourceCallback: (cb: (sources: { name: string; width: number; height: number }[]) => void) => void
    RemoveSourceCallback: () => void
  }
  Global: {
    setOutputSource: (slot: number, source: unknown) => void
    getOutputSource: (slot: number) => { name?: string } | null
  }
  InputFactory: { create: (type: string, name: string, settings: Record<string, unknown>) => any }
  VideoEncoderFactory: { create: (id: string, name: string, settings: Record<string, unknown>) => any; types(): string[] }
  AudioTrackFactory: {
    create: (bitrate: number, name: string) => any
    getAtIndex: (index: number) => any
    setAtIndex: (track: any, index: number) => void
  }
  AdvancedStreamingFactory: { create: () => any }
  AdvancedRecordingFactory: { create: () => any }
  AdvancedReplayBufferFactory: { create: () => any }
  ServiceFactory: { create: (type: string, name: string, settings: Record<string, unknown>) => any }
  SceneFactory: { create: (name: string) => any }
  FaderFactory: { create: (mul: number) => any }
}

let mod: ObsModule | null = null
let loadError: Error | null = null

/** Packaged builds load from resources; dev resolves the npm package. */
function resolveModulePath(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'obs-studio-node')
  try {
    return path.dirname(require.resolve('@streamlabs/obs-studio-node'))
  } catch {
    log.warn('Could not resolve obs-studio-node via require, falling back to manual path')
    return path.join(app.getAppPath(), 'node_modules', '@streamlabs', 'obs-studio-node')
  }
}

export function loadObs(): { mod: ObsModule | null; error: Error | null } {
  if (mod || loadError) return { mod, error: loadError }
  try {
    mod = require(resolveModulePath()) as ObsModule
    return { mod, error: null }
  } catch (e) {
    loadError = e as Error
    log.error('Failed to load obs-studio-node:', e)
    return { mod: null, error: loadError }
  }
}
// ---------------------------------------------------------------------------
// Settings get/set over OBS's key/value section format
// ---------------------------------------------------------------------------

type SettingParam = { name: string; currentValue?: string; value?: string }
type SettingEntry = { parameters?: SettingParam[] }

/**
 * Writes one value into an OBS config section.
 *
 * OBS returns config sections in two shapes. Structured ones come back as an array
 * of entries, each holding a `parameters` list; flat ones — the `Video` section
 * among them — come back as a plain object keyed by setting name. Handling only the
 * first shape meant every `Video` write was dropped on the floor, and callers were
 * not checking the return value, so the frame rate silently kept whatever value OBS
 * already had and a 120 fps request quietly recorded at the old rate.
 *
 * @returns whether the value was found and written.
 */
export function setSettingValue(section: unknown, name: string, value: string): boolean {
  if (Array.isArray(section)) {
    for (const entry of section as SettingEntry[]) {
      if (!Array.isArray(entry?.parameters)) continue
      for (const p of entry.parameters) {
        if (p.name === name) {
          p.currentValue = value
          p.value = value
          return true
        }
      }
    }
    return false
  }

  if (section && typeof section === 'object') {
    const flat = section as Record<string, unknown>
    if (name in flat) {
      flat[name] = value
      return true
    }
    return false
  }

  return false
}

/**
 * Reads an OBS config section.
 *
 * Returned exactly as OBS gave it — an array for structured sections, an object for
 * flat ones — so it can be handed straight back to `saveSettingSection` without
 * being reshaped and losing fields.
 */
export function getSettingSection(name: string): unknown {
  const { mod: m } = loadObs()
  if (!m) return {}
  const res = m.NodeObs.OBS_settings_getSettings(name)
  const data = (res as { data?: unknown } | null)?.data
  return data ?? {}
}

export function saveSettingSection(name: string, data: unknown): void {
  const { mod: m } = loadObs()
  m?.NodeObs.OBS_settings_saveSettings(name, data)
}

/** Minimal serial mutex. Source switches and buffer restarts must not interleave. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn)
    this.tail = result.catch(() => undefined)
    return result
  }
}

/** Promise with externally-callable resolve/reject plus a timeout. */
export function deferred<T = void>(ms?: number, message?: string) {
  let settled = false
  let resolve!: (v: T) => void
  let reject!: (e: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })

  const timer = ms !== undefined ? setTimeout(() => {
    if (settled) return
    settled = true
    reject(new Error(message ?? `Timeout after ${ms}ms`))
  }, ms) : undefined

  return {
    promise,
    get settled() {
      return settled
    },
    resolve: (v: T) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(v)
    },
    reject: (e: Error) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      reject(e)
    },
  }
}

/** Races `p` against a timeout, cleaning up the timer either way. */
export async function withTimeout<T>(p: Promise<T>, ms: number, message?: string): Promise<T> {
  const d = deferred<T>(ms, message)
  try {
    return await Promise.race([p, d.promise])
  } finally {
    d.resolve(undefined as T)
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))