import { scope } from './logger.js'
import { Mutex } from './obs-bind.js'
import { createAudioSource, applyGain, destroyAudioSource, setSourceTrack, describeAudioSource } from './obs-core.js'
import type { ObsModule } from './obs-bind.js'
import { getSetting, setSetting } from './store.js'
import {
  APP_AUDIO_WATCH_MS,
  APP_PROBE_TTL_MS,
  AUDIO_SESSION_POLL_MS,
  DEVICE_LIST_TTL_MS,
  SLOT,
  TRACK,
} from '@shared/constants.js'
import type { AudioApp, AudioChannel, AudioDevice, DeviceKind } from '@shared/types.js'

const log = scope('AudioDevices')
const mixLog = scope('AudioMix')
const sessionLog = scope('AudioSessions')

const DEFAULT_SOUND = { volume: 1, muted: false }

/** Windows uses WASAPI; macOS uses CoreAudio. */
const DEVICE_SOURCE: Record<DeviceKind, Record<string, string>> = {
  output: { win32: 'wasapi_output_capture', default: 'coreaudio_output_capture' },
  input: { win32: 'wasapi_input_capture', default: 'coreaudio_input_capture' },
}

/** OBS's per-app capture source: WASAPI process-loopback, matched by window handle. */
const APP_SOURCE_TYPE = 'wasapi_process_output_capture'
const APP_SOURCE_WINDOW_PROP = 'window'
const APP_SOURCE_PRIORITY = 2

/** Never offer our own processes as per-app capture targets. */
const SELF_EXECUTABLES = new Set(['obs64', 'rewind', 'electron'])

const KINDS: DeviceKind[] = ['output', 'input']

const CHANNEL_KIND: Record<AudioChannel, DeviceKind> = {
  desktop: 'output',
  microphone: 'input',
}
const CHANNEL_SETTING: Record<AudioChannel, 'desktopDeviceId' | 'micDeviceId'> = {
  desktop: 'desktopDeviceId',
  microphone: 'micDeviceId',
}

export function channelDevices(): Record<AudioChannel, string> {
  return {
    desktop: getSetting('desktopDeviceId'),
    microphone: getSetting('micDeviceId'),
  }
}

export function channelLevel(channel: AudioChannel): { volume: number; muted: boolean } {
  return channel === 'desktop'
    ? { volume: getSetting('desktopVolume'), muted: getSetting('desktopMuted') }
    : { volume: getSetting('micVolume'), muted: getSetting('micMuted') }
}

// ---------------------------------------------------------------------------
// WASAPI endpoint enumeration
// ---------------------------------------------------------------------------

let deviceCache: AudioDevice[] | null = null
let deviceCacheAt = 0

/** Clears the endpoint cache so the next read re-probes OBS. */
export function invalidateDeviceCache(): void {
  deviceCache = null
}

/**
 * OBS exposes endpoint ids only through live source objects, so enumeration means
 * creating (and immediately destroying) a probe source per device kind.
 */
export function listDevices(obs: ObsModule | null, force = false): AudioDevice[] {
  if (!force && deviceCache && Date.now() - deviceCacheAt < DEVICE_LIST_TTL_MS) return deviceCache

  const raw: { id: string; label: string; kind: DeviceKind }[] = []
  for (const kind of KINDS) {
    for (const p of probeDeviceProps(obs, DEVICE_SOURCE[kind][process.platform] ?? DEVICE_SOURCE[kind].default)) {
      // OBS uses the literal "default" sentinel for the system default endpoint.
      if (p.value === 'default') continue
      raw.push({ id: p.value, label: p.name || p.value, kind })
    }
  }

  const channels = channelDevices()
  const out: AudioDevice[] = raw.map((d) => {
    const channel: AudioChannel = d.kind === 'output' ? 'desktop' : 'microphone'
    const override = channels[channel]
    return {
      id: d.id,
      label: d.label,
      kind: d.kind,
      available: true,
      added: false,
      isSystemDefault: isSystemDefaultEndpoint(d, obs),
      coveredBy: override !== 'default' && override === d.id ? channel : undefined,
      volume: 1,
      muted: false,
    }
  })

  logInventory(out, channels)
  deviceCache = out
  deviceCacheAt = Date.now()
  return out
}

function probeDeviceProps(obs: ObsModule | null, sourceType: string): { value: string; name: string }[] {
  if (!obs) return []
  let probe: any = null
  try {
    probe = obs.InputFactory.create(sourceType, `probe-device_id-${Date.now()}`, {})
    const list = probe?.properties?.get?.('device_id')
    const items = list?.details?.items
    if (!Array.isArray(items)) return []
    return items.map((i: { name: string; value: string | number }) => ({ value: String(i.value), name: i.name }))
  } catch (e) {
    log.warn(`Failed to probe ${sourceType} devices:`, e)
    return []
  } finally {
    try {
      probe?.release?.()
    } catch {
      /* noop */
    }
  }
}

function isSystemDefaultEndpoint(d: { label?: string; kind: DeviceKind }, obs: ObsModule | null): boolean {
  if (!d.label) return false
  try {
    const mixer = require('native-sound-mixer').default
    const flow = d.kind === 'output' ? 0 : 1
    const device = mixer.getDefaultDevice(flow)
    return !!device && (device.name ?? null) === d.label
  } catch {
    return false
  }
}

function logInventory(devices: AudioDevice[], channels: Record<AudioChannel, string>): void {
  const outs = devices.filter((d) => d.kind === 'output')
  const ins = devices.filter((d) => d.kind === 'input')
  log.info(`Endpoint inventory: ${outs.length} output, ${ins.length} input`)
  log.info(`Channel bindings: desktop=${channels.desktop} mic=${channels.microphone}`)
  for (const d of devices) {
    log.info(`  ${d.kind} "${d.label}" ${d.id}${d.isSystemDefault ? ' (system default)' : ''}`)
  }
}

/** True when the stored id still resolves to a live endpoint. */
export function deviceAvailable(obs: ObsModule | null, id: string, kind: DeviceKind): boolean {
  // "default" is a device the OS resolves, so there is no id to look up -- but a
  // machine with no input endpoint at all must not report a microphone as usable.
  if (id === 'default') return kind === 'output' || listDevices(obs, true).some((d) => d.kind === 'input')
  return listDevices(obs, true).some((d) => d.id === id && d.kind === kind)
}

// ---------------------------------------------------------------------------
// Audio session enumeration (per-app audio)
// ---------------------------------------------------------------------------

interface SoundMixerDevice {
  name?: string
  sessions?: { appName?: string; state?: number }[]
}

let mixerModule: any = null
let mixerLoadFailed = false

function getMixer(): any {
  if (mixerModule) return mixerModule
  if (mixerLoadFailed) return null
  try {
    mixerModule = require('native-sound-mixer').default
  } catch (e) {
    mixerLoadFailed = true
    sessionLog.warn('native-sound-mixer failed to load, per-app audio disabled:', e)
  }
  return mixerModule
}

/** Normalizes an app identifier to a bare lowercase exe stem. */
export function normalizeExe(name: string): string {
  return (name.split(/[\\/]/).pop() ?? name).replace(/\.exe$/i, '').toLowerCase()
}

export function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * Lists apps currently producing audio, from the WASAPI default output device's
 * session list. Session state 2 = inactive, which we skip.
 */
export function listAudioApps(): AudioApp[] {
  const mixer = getMixer()
  if (!mixer) return []

  try {
    const device: SoundMixerDevice | null = mixer.getDefaultDevice(0)
    if (!device) return []

    const map = new Map<string, AudioApp>()
    for (const s of device.sessions ?? []) {
      if (!s.appName || s.state === 2) continue
      const exe = normalizeExe(s.appName)
      if (!exe || SELF_EXECUTABLES.has(exe) || map.has(exe)) continue
      map.set(exe, { exe, displayName: titleCase(exe), running: true, capturable: false, volume: 1, muted: false })
    }
    return [...map.values()]
  } catch (e) {
    sessionLog.warn('Audio session enumeration failed:', e)
    return []
  }
}
// ---------------------------------------------------------------------------
// Desktop mix (loopback or per-app)
// ---------------------------------------------------------------------------

/**
 * Desktop audio has two modes:
 *
 * - default: a single loopback source on the system default output endpoint
 * - customized: once any per-app level is set, the loopback is dropped and one
 *   process-loopback source is created per audible app, so each can be faded
 *   independently. Entering custom mode is what the original does too.
 */
export class AudioMix {
  private loopback: any = null
  private appSources = new Map<string, any>()
  private watcherTimer: NodeJS.Timeout | null = null
  private ready = false
  private customActive = false
  private windowProbeCache: Map<string, string> | null = null
  private windowProbeAt = 0

  constructor(private readonly deps: { obs: () => ObsModule | null }) {}

  /** True when the user has customized any per-app level. */
  customized(): boolean {
    return Object.keys(getSetting('appAudioLevels')).length > 0
  }

  setupDesktopMix(): void {
    this.ready = true
    if (this.customized()) this.enterCustomMode()
    else this.createLoopback()
  }

  teardown(): void {
    this.ready = false
    this.stopWatcher()
    this.destroyAllAppSources()
    this.releaseLoopback()
    this.customActive = false
    this.windowProbeCache = null
  }

  private createLoopback(): void {
    if (this.loopback) return
    const obs = this.deps.obs()
    if (!obs) return
    this.loopback = createAudioSource(obs, {
      type: DEVICE_SOURCE.output[process.platform] ?? DEVICE_SOURCE.output.default,
      name: 'desktop-audio',
      settings: { device_id: getSetting('desktopDeviceId') },
      slot: SLOT.DESKTOP,
      track: TRACK.DESKTOP,
      boostable: true,
    })
    if (this.loopback) this.applyMaster()
  }

  applyDesktopDevice(): void {
    if (!this.ready || !this.loopback) return
    const id = getSetting('desktopDeviceId')
    try {
      this.loopback.source.update({ device_id: id })
      mixLog.info(`Desktop audio device set to ${id}`)
    } catch (e) {
      mixLog.error('Failed to switch desktop audio device:', e)
    }
  }

  private releaseLoopback(): void {
    if (!this.loopback) return
    destroyAudioSource(this.deps.obs(), this.loopback)
    this.loopback = null
  }

  private createAppSource(exe: string, windowId: string): void {
    const slot = this.nextFreeSlot()
    if (slot === null) return
    const obs = this.deps.obs()
    if (!obs) return

    const src = createAudioSource(obs, {
      type: APP_SOURCE_TYPE,
      name: `app-audio-${exe}`,
      settings: { [APP_SOURCE_WINDOW_PROP]: windowId, priority: APP_SOURCE_PRIORITY },
      slot,
      track: TRACK.DESKTOP,
    })
    if (!src) return
    this.appSources.set(exe, src)
    this.applyAppFader(exe)
    mixLog.info(`App audio source created: ${exe} (slot ${slot})`)
  }

  private destroyAppSource(exe: string): void {
    const src = this.appSources.get(exe)
    if (!src) return
    destroyAudioSource(this.deps.obs(), src)
    this.appSources.delete(exe)
  }

  private destroyAllAppSources(): void {
    for (const exe of [...this.appSources.keys()]) this.destroyAppSource(exe)
  }

  private nextFreeSlot(): number | null {
    const used = new Set([...this.appSources.values()].map((s) => s.slot))
    for (let s = SLOT.APP_BASE; s < SLOT.APP_MAX; s++) {
      if (!used.has(s)) return s
    }
    return null
  }

  private isProbeStale(): boolean {
    return !this.windowProbeCache || Date.now() - this.windowProbeAt > APP_PROBE_TTL_MS
  }

  /** Maps running exe names to the OBS window handles that can capture them. */
  private probeAppWindows(force = false): Map<string, string> {
    if (!force && !this.isProbeStale()) return this.windowProbeCache ?? new Map()
    const obs = this.deps.obs()
    const out = new Map<string, string>()
    if (obs) {
      let probe: any = null
      try {
        probe = obs.InputFactory.create(APP_SOURCE_TYPE, `probe-window-${Date.now()}`, {})
        const items = probe?.properties?.get?.(APP_SOURCE_WINDOW_PROP)?.details?.items
        if (Array.isArray(items)) {
          for (const i of items) {
            const handle = String(i.value)
            // Window handles are `<title>:<class>:<exe>`; the exe is what the
            // per-app audio source is keyed by, and it is the last field.
            const parts = handle.split(':')
            const exe = normalizeExe(parts[parts.length - 1] ?? '')
            if (exe && !out.has(exe)) out.set(exe, handle)
          }
        }
      } catch (e) {
        mixLog.warn('App window probe failed:', e)
      } finally {
        try {
          probe?.release?.()
        } catch {
          /* noop */
        }
      }
    }
    this.windowProbeCache = out
    this.windowProbeAt = Date.now()
    // The per-app list is only visible here: it comes from a different source than the
    // window picker, so a mismatch between the two is otherwise undiagnosable.
    mixLog.info(`Capturable app windows: ${out.size ? [...out.keys()].join(', ') : 'none'}`)
    return out
  }

  /** Which running apps can actually be captured individually. */
  getApps(): AudioApp[] {
    const all = listDevices(this.deps.obs())
    const levels = getSetting('appAudioLevels')
    const probes = this.ready ? this.probeAppWindows() : new Map<string, string>()
    const map = new Map<string, AudioApp>()

    for (const app of listAudioApps()) {
      const level = (levels[app.exe] ?? DEFAULT_SOUND) as { volume: number; muted: boolean }
      map.set(app.exe, {
        ...app,
        capturable: probes.has(app.exe),
        volume: level.volume,
        muted: level.muted,
      })
    }

    // Persisted entries survive their process so the user's mix isn't lost on restart.
    for (const [exe, level] of Object.entries(levels)) {
      if (map.has(exe)) continue
      map.set(exe, {
        exe,
        displayName: titleCase(exe),
        running: false,
        capturable: false,
        volume: level.volume,
        muted: level.muted,
      })
    }

    return [...map.values()].sort((a, b) =>
      a.running !== b.running ? (a.running ? -1 : 1) : a.displayName.localeCompare(b.displayName),
    )
  }

  private masterLevel() {
    return channelLevel('desktop')
  }

  private appLevel(exe: string) {
    return (getSetting('appAudioLevels')[exe] ?? DEFAULT_SOUND) as { volume: number; muted: boolean }
  }

  /** Per-app fader is the product of the master level and the app's own level. */
  private applyAppFader(exe: string): void {
    const src = this.appSources.get(exe)
    if (!src) return
    const master = this.masterLevel()
    const app = this.appLevel(exe)
    applyGain(src, master.muted || app.muted ? 0 : master.volume * app.volume, exe)
  }

  setAppLevel(exe: string, patch: { volume?: number; muted?: boolean }): void {
    const key = normalizeExe(exe)
    if (!key) throw new Error('Invalid app identifier')

    const all = getSetting('appAudioLevels')
    const merged = { ...(all[key] ?? DEFAULT_SOUND), ...patch }

    // Deleting untouched entries keeps the persisted map minimal and is what makes
    // "customized()" flip back to false after a reset.
    if (merged.volume === DEFAULT_SOUND.volume && merged.muted === DEFAULT_SOUND.muted) {
      delete all[key]
    } else {
      all[key] = merged
    }

    setSetting('appAudioLevels', all)
    this.applyStoreToMix()
  }

  resetMix(): void {
    setSetting('appAudioLevels', {})
    this.applyStoreToMix()
    mixLog.info('Per-app mix reset to default desktop capture')
  }

  private applyStoreToMix(): void {
    if (!this.ready) return
    const custom = this.customized()
    if (custom && !this.customActive) this.enterCustomMode()
    else if (!custom && this.customActive) this.leaveCustomMode()
    else if (this.customActive) {
      this.syncSources(true)
      this.applyMaster()
    } else {
      this.applyMaster()
    }
  }

  applyTracks(): void {
    for (const src of [this.loopback, ...this.appSources.values()]) {
      if (src) setSourceTrack(src, TRACK.DESKTOP)
    }
  }

  /** Diagnostic summary of the currently bound sources. */
  describeSources(): string {
    const parts: string[] = []
    if (this.loopback) parts.push(describeAudioSource(this.loopback))
    for (const [exe, src] of this.appSources) parts.push(`${exe}=${describeAudioSource(src)}`)
    return parts.length ? parts.join(' + ') : 'none'
  }

  applyMaster(): void {
    if (!this.ready) return
    // Custom mode with no app source live has nothing of its own to apply, so the
    // loopback fallback (see `syncSources`) carries the master level instead.
    if (this.customActive && this.appSources.size > 0) {
      for (const exe of this.appSources.keys()) this.applyAppFader(exe)
      return
    }
    if (!this.loopback) return
    const { volume, muted } = this.masterLevel()
    applyGain(this.loopback, muted ? 0 : volume, 'desktop')
  }

  private enterCustomMode(): void {
    mixLog.info('Entering custom per-app audio mix')
    this.releaseLoopback()
    this.customActive = true
    this.syncSources(true)
    this.startWatcher()
  }

  private leaveCustomMode(): void {
    mixLog.info('Leaving custom per-app audio mix')
    this.stopWatcher()
    this.destroyAllAppSources()
    this.customActive = false
    this.createLoopback()
  }

  private startWatcher(): void {
    if (this.watcherTimer) return
    this.watcherTimer = setInterval(() => {
      try {
        this.syncSources(false)
      } catch (e) {
        mixLog.warn('App-audio sync failed:', e)
      }
    }, APP_AUDIO_WATCH_MS)
  }

  private stopWatcher(): void {
    if (this.watcherTimer) clearInterval(this.watcherTimer)
    this.watcherTimer = null
  }

  /** Creates/destroys sources as apps come and go. */
  private syncSources(force: boolean): void {
    if (!this.customActive || !this.ready) return

    const apps = listAudioApps()
    const live = new Set(apps.map((a) => a.exe))

    for (const exe of [...this.appSources.keys()]) {
      if (live.has(exe)) continue
      this.destroyAppSource(exe)
      mixLog.info(`App audio source removed (session gone): ${exe}`)
    }

    const missing = apps.filter((a) => !this.appSources.has(a.exe))

    /*
     * With no app session captured, custom mode would record silence: the loopback
     * was released when custom mode was entered, and a stored per-app level keeps
     * `customized()` true even after that app has been closed. Falling back to the
     * whole desktop keeps system sounds and window-less apps audible; the loopback
     * goes away again as soon as an app source exists.
     */
    if (this.appSources.size === 0 && missing.length === 0) {
      this.createLoopback()
      return
    }
    if (this.appSources.size > 0) this.releaseLoopback()

    if (missing.length === 0) return

    const probes = this.probeAppWindows(force || this.isProbeStale())
    for (const app of missing) {
      // Slots run APP_BASE..APP_MAX exclusive, so the count of usable slots is the
      // difference -- not APP_MAX, which is an index bound.
      if (this.appSources.size >= SLOT.APP_MAX - SLOT.APP_BASE) {
        mixLog.warn(`App audio source cap (${SLOT.APP_MAX - SLOT.APP_BASE}) reached, skipping: ${app.exe}`)
        break
      }
      const windowId = probes.get(app.exe)
      if (windowId) this.createAppSource(app.exe, windowId)
    }
  }
}

// ---------------------------------------------------------------------------
// Extra device channels (up to 8 extra endpoints, optionally on their own tracks)
// ---------------------------------------------------------------------------

export class AudioDeviceChannels {
  private channels = new Map<string, any>()
  private errors = new Map<string, string>()
  private ready = false

  constructor(private readonly deps: { obs: () => ObsModule | null }) {}

  setup(): void {
    this.ready = true
    this.errors.clear()
    const devices = listDevices(this.deps.obs(), true)

    for (const [id, cfg] of Object.entries(getSetting('deviceChannels'))) {
      const known = devices.find((d) => d.id === id)
      if (!known) {
        this.errors.set(id, 'Device not connected')
        log.warn(`Device channel not connected, skipping: "${cfg.label}"`)
        continue
      }
      this.createChannel(id, cfg)
    }
  }

  teardown(): void {
    this.ready = false
    for (const id of [...this.channels.keys()]) this.destroyChannel(id)
    this.errors.clear()
    invalidateDeviceCache()
  }

  /** Endpoint inventory plus the user's added channels, with track assignment resolved. */
  getDevices(): AudioDevice[] {
    const stored = getSetting('deviceChannels')
    const available = this.ready ? listDevices(this.deps.obs()) : []
    const map = new Map<string, AudioDevice>()

    for (const d of available) {
      const cfg = stored[d.id]
      map.set(d.id, {
        ...d,
        added: !!cfg,
        coveredBy: this.coveredBy(d),
        volume: cfg?.volume ?? DEFAULT_SOUND.volume,
        muted: cfg?.muted ?? DEFAULT_SOUND.muted,
        // Split tracks are unconditional, so every added channel reports the
        // track it actually occupies rather than a conditional one.
        track: this.channels.get(d.id)?.track,
        error: this.errors.get(d.id),
      })
    }

    // Configured-but-disconnected devices still render, so the user can see why.
    for (const [id, cfg] of Object.entries(stored)) {
      if (map.has(id)) continue
      map.set(id, {
        id,
        label: cfg.label,
        kind: cfg.kind,
        available: false,
        added: true,
        isSystemDefault: false,
        volume: cfg.volume,
        muted: cfg.muted,
        error: this.errors.get(id) ?? 'Device not connected',
      })
    }

    return [...map.values()].sort((a, b) =>
      a.available !== b.available
        ? a.available
          ? -1
          : 1
        : a.kind !== b.kind
          ? a.kind === 'output'
            ? -1
            : 1
          : a.label.localeCompare(b.label),
    )
  }

  /** True when this endpoint is already the channel's own bound device. */
  private coveredBy(d: { id: string; kind: DeviceKind; label?: string }): AudioChannel | undefined {
    const channel: AudioChannel = d.kind === 'output' ? 'desktop' : 'microphone'
    const bound = channelDevices()[channel]
    if (bound === d.id) return channel
    if (bound === 'default' && isSystemDefaultEndpoint(d, this.deps.obs())) return channel
    return undefined
  }

  addChannel(id: string): void {
    const stored = getSetting('deviceChannels')
    if (stored[id]) return

    const known = listDevices(this.deps.obs(), true).find((d) => d.id === id)
    if (!known) throw new Error('Audio device not found')
    if (Object.keys(stored).length >= SLOT.DEVICE_MAX) {
      throw new Error(`Cannot capture more than ${SLOT.DEVICE_MAX} extra audio devices`)
    }

    /*
     * Built once and used for both the write and `createChannel`. This used to
     * read `stored[id]` after the write, which was the pre-write snapshot, so
     * `createChannel` dereferenced `undefined` and threw on `cfg.kind` -- while
     * the device had already been persisted. The user got a lane in Settings
     * that did nothing until the next launch, which reads as a broken control
     * rather than a failed add.
     */
    const cfg = { kind: known.kind, label: known.label, ...DEFAULT_SOUND }

    if (this.ready) {
      try {
        this.createChannel(id, cfg)
      } catch (e) {
        // Do not persist a channel that could not be created. A row the user
        // can see but cannot use is worse than an outright failure, and it
        // survives until they restart.
        log.error(`Could not create channel for "${known.label}", not saving it:`, e)
        throw e
      }
    }

    setSetting('deviceChannels', { ...stored, [id]: cfg })
    log.info(`Device channel added: "${known.label}"`)
  }

  removeChannel(id: string): void {
    const stored = { ...getSetting('deviceChannels') }
    const cfg = stored[id]
    if (!cfg) return
    delete stored[id]
    setSetting('deviceChannels', stored)
    this.destroyChannel(id)
    this.errors.delete(id)
    log.info(`Device channel removed: "${cfg.label}"`)
  }

  private createChannel(id: string, cfg: { label: string; kind: DeviceKind }): void {
    if (this.channels.has(id)) return

    const obs = this.deps.obs()
    if (!obs) return

    const usedSlots = [...this.channels.values()].map((c) => c.slot)
    const slot = findFreeSlot(usedSlots, SLOT.DEVICE_BASE, SLOT.DEVICE_MAX)
    if (slot === null) {
      const msg = `Channel limit (${SLOT.DEVICE_MAX}) reached`
      this.errors.set(id, msg)
      log.warn(`${msg}, skipping: "${cfg.label}"`)
      return
    }

    const track = deviceTrack(this.channels.size)
    const src = createAudioSource(obs, {
      type: DEVICE_SOURCE[cfg.kind][process.platform] ?? DEVICE_SOURCE[cfg.kind].default,
      name: `device-audio-${id}`,
      settings: { device_id: id },
      slot,
      track,
    })

    if (!src) {
      this.errors.set(id, 'Could not open this device')
      return
    }

    this.channels.set(id, src)
    this.errors.delete(id)
    this.applyLevel(id)
    log.info(`Device channel capturing: "${cfg.label}" (slot ${slot})`)
  }

  private destroyChannel(id: string): void {
    const src = this.channels.get(id)
    if (!src) return
    destroyAudioSource(this.deps.obs(), src)
    this.channels.delete(id)
  }

  applyTracks(): void {
    let i = 0
    for (const src of this.channels.values()) {
      setSourceTrack(src, deviceTrack(i))
      i++
    }
  }

  channelTracks(): { track: number; label: string }[] {
    const stored = getSetting('deviceChannels')
    return [...this.channels.entries()].map(([id, ch]) => ({
      track: ch.track,
      label: stored[id]?.label ?? id,
    }))
  }

  setLevel(id: string, patch: { volume?: number; muted?: boolean }): void {
    const stored = getSetting('deviceChannels')
    const cfg = stored[id]
    if (!cfg) throw new Error('Audio device channel not found')
    setSetting('deviceChannels', { ...stored, [id]: { ...cfg, ...patch } })
    this.applyLevel(id)
  }

  private applyLevel(id: string): void {
    const src = this.channels.get(id)
    if (!src) return
    const cfg = getSetting('deviceChannels')[id]
    if (!cfg) return
    applyGain(src, cfg.muted ? 0 : cfg.volume, cfg.label)
  }
}

/**
 * Every extra device shares TRACK.DEVICE_BASE.
 *
 * This was conditional on `perDeviceAudioTracks`, which gave each device its own
 * track. That setting is gone; sharing one track is what it produced when off,
 * and it is the only layout with evidence behind it. Devices beyond
 * TRACK.MAX collapse onto the last track rather than being dropped.
 */
export function deviceTrack(_index: number): number {
  return TRACK.DEVICE_BASE
}

function findFreeSlot(used: number[], base: number, count: number): number | null {
  const taken = new Set(used)
  for (let s = base; s < base + count; s++) {
    if (!taken.has(s)) return s
  }
  return null
}

export { AUDIO_SESSION_POLL_MS, Mutex }