/**
 * Microphone level meter.
 *
 * The panel's mic strip shows a live input level. The value comes from OBS's own
 * volume meter attached to the microphone source the capture graph already
 * created -- the same mechanism OBS's mixer uses, so what the strip shows is what
 * the recording hears.
 *
 * obs-studio-node's `IVolmeter` has no per-instance callback: levels arrive
 * through one process-wide `RegisterVolmeterCallback`, which delivers every
 * attached meter in one batch. Measured on this build: one batch every ~50 ms
 * (20 a second), so the strip needs no interpolation of its own.
 *
 * The worker thread behind the callback is shared with `RegisterSourceCallback`
 * (game-hook detection), so this module never starts or stops the worker itself.
 * `syncMicMeter` attaches or detaches; the worker's own lifetime is a separate
 * concern.
 */
import { scope } from './logger.js'
import type { ObsModule } from './obs-bind.js'

const log = scope('MicMeter')

/** `EFaderType.Cubic`. The binding's enum is type-only, so the value is inline. */
const FADER_CUBIC = 0

/** Linear amplitude, 0..1 (above 1 on clipping). */
export interface MicLevels {
  peak: number
  inputPeak: number
}

let volmeter: any = null
let attached: any = null
let attachedName = ''
let callbackRegistered = false
let sink: ((levels: MicLevels) => void) | null = null

/** Where sampled levels go. Set once, at startup. */
export function setMicLevelSink(cb: ((levels: MicLevels) => void) | null): void {
  sink = cb
}

/** Whether the meter currently has a live attachment. Diagnostics only. */
export function isMicMeterAttached(): boolean {
  return attached !== null
}

/**
 * Attaches the meter to `input` when `wanted`, detaches otherwise.
 *
 * Idempotent, and safe to call after every pipeline rebuild: a rebuild creates a
 * new microphone source object, and a meter left attached to the old one reports
 * silence forever.
 */
export function syncMicMeter(obs: ObsModule | null, input: any, name: string, wanted: boolean): void {
  if (!obs || !wanted || !input) {
    detachMicMeter()
    return
  }

  if (!volmeter) {
    try {
      volmeter = obs.VolmeterFactory.create(FADER_CUBIC)
      // The binding delivers a batch every ~50 ms regardless; this is the meter's
      // own sampling interval, kept below that so no update is missed.
      volmeter.updateInterval = 25
    } catch (e) {
      log.warn('Could not create the microphone meter:', e)
      volmeter = null
      return
    }
  }

  if (!callbackRegistered) {
    try {
      obs.NodeObs.RegisterVolmeterCallback((data: unknown) => {
        if (!sink || !Array.isArray(data)) return
        const mine = (data as any[]).find((entry) => entry?.sourceName === attachedName)
        if (!mine) return
        sink({
          peak: Math.max(0, ...(Array.isArray(mine.peak) ? mine.peak : [0])),
          inputPeak: Math.max(0, ...(Array.isArray(mine.inputPeak) ? mine.inputPeak : [0])),
        })
      })
      callbackRegistered = true
    } catch (e) {
      log.warn('Microphone meter callback unavailable:', e)
      return
    }
  }

  if (attached !== input) {
    try {
      volmeter.attach(input)
      attached = input
      attachedName = name
      log.info(`Microphone meter attached to ${name}`)
    } catch (e) {
      log.warn('Could not attach the microphone meter:', e)
    }
  }
}

/** Detaches without destroying the meter, so showing the panel again is cheap. */
export function detachMicMeter(): void {
  if (!volmeter || !attached) return
  try {
    volmeter.detach()
  } catch {
    /* the source may already be gone with a rebuild */
  }
  attached = null
  attachedName = ''
  log.info('Microphone meter detached')
}

/** Releases the meter and the process-wide callback. Called at shutdown. */
export function shutdownMicMeter(obs: ObsModule | null): void {
  detachMicMeter()
  if (volmeter) {
    try {
      volmeter.destroy()
    } catch {
      /* best effort */
    }
    volmeter = null
  }
  if (callbackRegistered && obs) {
    try {
      obs.NodeObs.RemoveVolmeterCallback()
    } catch {
      /* best effort */
    }
    callbackRegistered = false
  }
  sink = null
}
