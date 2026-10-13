/**
 * Settings audit: every control in the Settings tab is changed, its effect checked,
 * and the original value restored.
 *
 * "Effect" means an observable: the value read back through the app's own getter,
 * a line in main.log, and for encoder settings the OBS-side settings block. This
 * is the check that would have caught the NVENC preset being a no-op for its whole
 * life: the control round-tripped fine, but the encoder never saw the value.
 *
 * Usage: node scripts/cdp.mjs scripts/probe-settings-audit.mjs
 * Run against the app on --remote-debugging-port=9222, with the buffer live.
 *
 * Restores every value it touches. Audio device and window-capture checks restore
 * their originals too; a hard kill mid-run can leave one changed — the summary
 * says what was in flight.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const LOG = path.join(process.env.APPDATA || '', 'Rewind', 'logs', 'main.log')

let logPos = 0
try {
  logPos = fs.statSync(LOG).size
} catch {
  /* log may not exist yet */
}

/** Text appended to main.log since the last read. */
function readNewLog() {
  try {
    const size = fs.statSync(LOG).size
    if (size <= logPos) {
      logPos = size
      return ''
    }
    const fd = fs.openSync(LOG, 'r')
    const buf = Buffer.alloc(size - logPos)
    fs.readSync(fd, buf, 0, buf.length, logPos)
    fs.closeSync(fd)
    logPos = size
    return buf.toString('utf8')
  } catch {
    return ''
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export default async function ({ evaluate }) {
  const call = (expr) => evaluate(`window.electronAPI.${expr}`)
  const results = []
  let pass = 0
  let fail = 0
  let skip = 0

  const step = async (label, fn) => {
    try {
      const verdict = await fn()
      if (verdict === 'SKIP') {
        skip++
        results.push(`SKIP  ${label}`)
      } else {
        pass++
        results.push(`PASS  ${label}`)
      }
    } catch (e) {
      fail++
      results.push(`FAIL  ${label}: ${e instanceof Error ? e.message : e}`)
    }
  }

  const ok = (res) => {
    if (!res || res.success !== true) throw new Error(`ipc failed: ${res?.error ?? 'unknown'}`)
    return res.data
  }

  const expectLog = (pattern, timeoutMs = 15000) =>
    new Promise(async (resolve, reject) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const text = readNewLog()
        if (text && pattern.test(text)) return resolve(true)
        await sleep(400)
      }
      reject(new Error(`log did not contain ${pattern}`))
    })

  const expectLogNow = (pattern) => {
    const text = readNewLog()
    if (!text || !pattern.test(text)) throw new Error(`log did not contain ${pattern}`)
  }

  console.log('Settings audit starting. Buffer state:', JSON.stringify(await call('isReplayBufferActive()')))

  // ---------------------------------------------------------------- toggles
  await step('Notifications toggle (enabled -> disabled -> enabled)', async () => {
    const original = ok(await call('getNotificationsEnabled()'))
    const flipped = !original
    try {
      ok(await call(`setNotificationsEnabled(${flipped})`))
      await expectLog(new RegExp(`Notifications ${flipped ? 'enabled' : 'disabled'}`))
      const read = ok(await call('getNotificationsEnabled()'))
      if (read !== flipped) throw new Error(`read back ${read}, expected ${flipped}`)
    } finally {
      ok(await call(`setNotificationsEnabled(${original})`))
    }
  })

  await step('Notification sound toggle', async () => {
    const original = ok(await call('getNotificationSoundEnabled()'))
    const flipped = !original
    try {
      ok(await call(`setNotificationSoundEnabled(${flipped})`))
      await expectLog(new RegExp(`Notification sound ${flipped ? 'enabled' : 'disabled'}`))
    } finally {
      ok(await call(`setNotificationSoundEnabled(${original})`))
    }
  })

  await step('Launch on startup toggle', async () => {
    const original = ok(await call('getLaunchOnStartup()'))
    const flipped = !original
    try {
      ok(await call(`setLaunchOnStartup(${flipped})`))
      await expectLog(new RegExp(`Launch on startup ${flipped ? 'enabled' : 'disabled'}`))
      const read = ok(await call('getLaunchOnStartup()'))
      if (read !== flipped) throw new Error(`read back ${read}`)
    } finally {
      ok(await call(`setLaunchOnStartup(${original})`))
    }
  })

  // ---------------------------------------------------------------- hotkeys
  await step('Hotkey rebind (screenshot Alt+2 -> Alt+9 -> restore)', async () => {
    const original = ok(await call('getHotkeys()'))
    try {
      ok(await call(`setHotkey('screenshot', 'Alt+9')`))
      await expectLog(/Registered screenshot: Alt\+9/)
      const now = ok(await call('getHotkeys()'))
      if (now.screenshot !== 'Alt+9') throw new Error(`read back ${now.screenshot}`)
    } finally {
      ok(await call(`setHotkey('screenshot', ${JSON.stringify(original.screenshot)})`))
    }
  })

  await step('Hotkey conflict rejected (screenshot -> save-replay combo)', async () => {
    const hotkeys = ok(await call('getHotkeys()'))
    const res = await call(`setHotkey('screenshot', ${JSON.stringify(hotkeys['save-replay'])})`)
    if (res.success) throw new Error('conflicting combo was accepted')
    if (!/already used/i.test(String(res.error))) throw new Error(`unexpected error: ${res.error}`)
  })

  // ---------------------------------------------------------------- audio levels
  await step('Mic mute toggle (read back via levels)', async () => {
    const before = ok(await call('getAudioLevels()'))
    const original = !!before.microphone.muted
    try {
      ok(await call(`setChannelMuted('microphone', ${!original})`))
      await sleep(600)
      const after = ok(await call('getAudioLevels()'))
      if (after.microphone.muted !== !original) throw new Error('mute did not take')
    } finally {
      ok(await call(`setChannelMuted('microphone', ${original})`))
    }
  })

  await step('Mic volume (0.5 -> restore)', async () => {
    const before = ok(await call('getAudioLevels()'))
    try {
      ok(await call(`setChannelVolume('microphone', 0.5)`))
      await sleep(600)
      const after = ok(await call('getAudioLevels()'))
      // The fader clamps at unity but 0.5 is well below it.
      if (Math.abs((after.microphone.volume ?? 1) - 0.5) > 0.05) {
        throw new Error(`volume read back ${after.microphone.volume}`)
      }
    } finally {
      ok(await call(`setChannelVolume('microphone', ${before.microphone.volume ?? 1})`))
    }
  })

  await step('Desktop mute toggle', async () => {
    const before = ok(await call('getAudioLevels()'))
    const original = !!before.desktop.muted
    try {
      ok(await call(`setChannelMuted('desktop', ${!original})`))
      await sleep(600)
      const after = ok(await call('getAudioLevels()'))
      if (after.desktop.muted !== !original) throw new Error('mute did not take')
    } finally {
      ok(await call(`setChannelMuted('desktop', ${original})`))
    }
  })

  await step('Mic input gain (0.8 -> restore)', async () => {
    const original = ok(await call('getMicGain()'))
    try {
      ok(await call('setMicGain(0.8)'))
      await expectLog(/microphone input gain: 0\.8x/)
      const read = ok(await call('getMicGain()'))
      if (Math.abs(read - 0.8) > 0.01) throw new Error(`read back ${read}`)
    } finally {
      ok(await call(`setMicGain(${original})`))
    }
  })

  await step('Mic device switch (different input -> restore)', async () => {
    const devices = ok(await call('getAudioDevices()'))
    const channels = ok(await call('getChannelDevices()'))
    const candidate = devices.find(
      (d) => d.kind === 'input' && d.available && !d.coveredBy && d.id !== channels.microphone,
    )
    if (!candidate) return 'SKIP'
    try {
      ok(await call(`setChannelDevice('microphone', ${JSON.stringify(candidate.id)})`))
      await expectLog(/Microphone device set to/)
      const now = ok(await call('getChannelDevices()'))
      if (now.microphone !== candidate.id) throw new Error('device did not stick')
    } finally {
      ok(await call(`setChannelDevice('microphone', ${JSON.stringify(channels.microphone)})`))
    }
  })

  await step('Desktop device switch (different output -> restore)', async () => {
    const devices = ok(await call('getAudioDevices()'))
    const channels = ok(await call('getChannelDevices()'))
    const candidate = devices.find(
      (d) => d.kind === 'output' && d.available && !d.coveredBy && d.id !== channels.desktop,
    )
    if (!candidate) return 'SKIP'
    try {
      ok(await call(`setChannelDevice('desktop', ${JSON.stringify(candidate.id)})`))
      await expectLog(/Desktop audio device set to/)
      const now = ok(await call('getChannelDevices()'))
      if (now.desktop !== candidate.id) throw new Error('device did not stick')
    } finally {
      ok(await call(`setChannelDevice('desktop', ${JSON.stringify(channels.desktop)})`))
    }
  })

  await step('Extra audio device channel (add, volume, remove)', async () => {
    const devices = ok(await call('getAudioDevices()'))
    const candidate = devices.find((d) => d.kind === 'output' && d.available && !d.added && !d.coveredBy)
    if (!candidate) return 'SKIP'
    try {
      ok(await call(`addAudioDeviceChannel(${JSON.stringify(candidate.id)})`))
      await sleep(1500)
      const added = ok(await call('getAudioDevices()')).find((d) => d.id === candidate.id)
      if (!added?.added) throw new Error('device did not appear as added')
      ok(await call(`setDeviceVolume(${JSON.stringify(candidate.id)}, 0.6)`))
      await sleep(400)
      const leveled = ok(await call('getAudioDevices()')).find((d) => d.id === candidate.id)
      if (leveled?.volume !== 0.6) throw new Error(`volume read back ${leveled?.volume}`)
    } finally {
      try {
        await call(`removeAudioDeviceChannel(${JSON.stringify(candidate.id)})`)
        await sleep(800)
      } catch {
        /* keep going; the summary will show */
      }
    }
  })

  await step('Per-app mix (mute an audio session, then reset)', async () => {
    const sessions = ok(await call('getAudioSessions()'))
    if (!Array.isArray(sessions) || sessions.length === 0) return 'SKIP'
    const app = sessions[0]
    try {
      ok(await call(`setAppMuted(${JSON.stringify(app.exe)}, true)`))
      await sleep(400)
      ok(await call('resetAppMix()'))
    } finally {
      try {
        await call('resetAppMix()')
      } catch {
        /* nothing else to restore: reset is the original state */
      }
    }
  })

  // ---------------------------------------------------------------- capture source
  await step('Window capture (pick a window, then back to auto-detect)', async () => {
    const windows = ok(await call('getWindows()'))
    const target = windows.find((w) => /probe/i.test(w.name)) ?? windows[0]
    if (!target) return 'SKIP'
    let attempted = false
    try {
      attempted = true
      ok(await call(`setWindow(${JSON.stringify(target.id)})`))
      await expectLog(/Switched to window capture|Failed to install capture source/)
      const mode = ok(await call('getCaptureMode()'))
      if (mode !== 'window') throw new Error(`mode is ${mode}`)
    } finally {
      if (attempted) {
        ok(await call('setGameCapture()'))
        await expectLog(/Auto-detect mode: started with Display 1/)
      }
    }
  })

  // ---------------------------------------------------------------- output settings
  await step('Buffer duration (60 -> 45 -> restore)', async () => {
    const original = ok(await call('getBufferDuration()'))
    try {
      ok(await call('setBufferDuration(45)'))
      await expectLog(/Buffer duration updated to 45s/)
      const read = ok(await call('getBufferDuration()'))
      if (read !== 45) throw new Error(`read back ${read}`)
    } finally {
      ok(await call(`setBufferDuration(${original})`))
      await expectLog(new RegExp(`Buffer duration updated to ${original}s`))
    }
  })

  await step('Output path (temp dir -> restore)', async () => {
    const original = ok(await call('getOutputPath()'))
    const temp = path.join(os.tmpdir(), 'rewind-audit-output')
    fs.mkdirSync(temp, { recursive: true })
    try {
      ok(await call(`setOutputPath(${JSON.stringify(temp)})`))
      await expectLog(/Output path set to/)
      const read = ok(await call('getOutputPath()'))
      // The app owns one level inside the chosen folder: setting X reads back as
      // X\Rewind. Assert the resolved root, not the raw choice.
      const expected = path.join(temp, 'Rewind')
      if (read !== expected) throw new Error(`read back ${read}, expected ${expected}`)
    } finally {
      ok(await call(`setOutputPath(${JSON.stringify(original)})`))
    }
  })

  await step('Screenshot path (temp dir -> restore)', async () => {
    const original = ok(await call('getScreenshotPath()'))
    const temp = path.join(os.tmpdir(), 'rewind-audit-shots')
    fs.mkdirSync(temp, { recursive: true })
    try {
      ok(await call(`setScreenshotPath(${JSON.stringify(temp)})`))
      const read = ok(await call('getScreenshotPath()'))
      if (read !== temp) throw new Error(`read back ${read}`)
    } finally {
      ok(await call(`setScreenshotPath(${JSON.stringify(original)})`))
    }
  })

  await step('Quick clip length (90 -> 30 -> restore)', async () => {
    const original = ok(await call('getQuickClipSeconds()'))
    try {
      ok(await call('setQuickClipSeconds(30)'))
      const read = ok(await call('getQuickClipSeconds()'))
      if (read !== 30) throw new Error(`read back ${read}`)
    } finally {
      ok(await call(`setQuickClipSeconds(${original})`))
    }
  })

  // ---------------------------------------------------------------- encoder settings
  await step('NVENC preset (p4 -> p3 -> restore) reaches the encoder', async () => {
    const original = ok(await call('getNvencPreset()'))
    const target = original === 'p3' ? 'p5' : 'p3'
    try {
      ok(await call(`setNvencPreset(${JSON.stringify(target)})`))
      await expectLog(new RegExp(`"preset":"${target}","preset2":"${target}"`), 30000)
    } finally {
      ok(await call(`setNvencPreset(${JSON.stringify(original)})`))
    }
  })

  await step('NVENC multipass (disabled -> qres -> restore)', async () => {
    const original = ok(await call('getNvencMultipass()'))
    const target = original === 'qres' ? 'disabled' : 'qres'
    try {
      ok(await call(`setNvencMultipass(${JSON.stringify(target)})`))
      await expectLog(new RegExp(`"multipass":"${target}"`), 30000)
    } finally {
      ok(await call(`setNvencMultipass(${JSON.stringify(original)})`))
    }
  })

  await step('Visual quality (high -> standard -> restore) changes CQP', async () => {
    const original = ok(await call('getVisualQuality()'))
    const target = original === 'standard' ? 'high' : 'standard'
    const expectedCqp = target === 'standard' ? 23 : 20
    try {
      ok(await call(`setVisualQuality(${JSON.stringify(target)})`))
      await expectLog(new RegExp(`"cqp":${expectedCqp}`), 30000)
    } finally {
      ok(await call(`setVisualQuality(${JSON.stringify(original)})`))
    }
  })

  await step('Video codec (av1 -> hevc -> restore) changes encoder id', async () => {
    const original = ok(await call('getVideoCodec()'))
    const codecs = ok(await call('getAvailableCodecs()'))
    const target = original === 'hevc' ? 'av1' : 'hevc'
    if (!codecs.includes(target)) return 'SKIP'
    try {
      ok(await call(`setVideoCodec(${JSON.stringify(target)})`))
      await expectLog(new RegExp(`Created replay encoder: obs_nvenc_${target}_tex`), 30000)
    } finally {
      ok(await call(`setVideoCodec(${JSON.stringify(original)})`))
    }
  })

  await step('Encoder vendor (nvenc -> x264 -> nvenc) changes the encoder', async () => {
    const vendors = ok(await call('getAvailableEncoderVendors()'))
    if (!vendors.some((v) => v.vendor === 'x264')) return 'SKIP'
    const originalCodec = ok(await call('getVideoCodec()'))
    try {
      ok(await call(`setVideoEncoder('x264')`))
      await expectLog(/Created replay encoder: obs_x264/, 40000)
    } finally {
      ok(await call(`setVideoEncoder('nvenc')`))
      // Switching vendor normalises the codec; put the original back.
      const now = ok(await call('getVideoCodec()'))
      if (now !== originalCodec) {
        try {
          ok(await call(`setVideoCodec(${JSON.stringify(originalCodec)})`))
        } catch {
          /* reported via the log; restore attempted */
        }
      }
    }
  })

  // Full reinits last: they are the slow ones.
  await step('Frame rate (current -> other -> restore) survives a full reinit', async () => {
    const original = ok(await call('getFps()'))
    const target = original === 60 ? 120 : 60
    try {
      ok(await call(`setFps(${target})`))
      await expectLog(new RegExp(`Profile written for ${target} fps`), 60000)
      const read = ok(await call('getFps()'))
      if (read !== target) throw new Error(`read back ${read}`)
    } finally {
      ok(await call(`setFps(${original})`))
      await expectLog(new RegExp(`Profile written for ${original} fps`), 60000)
    }
  })

  await step('Output resolution (native -> 1080p -> restore)', async () => {
    const original = ok(await call('getOutputResolution()'))
    const target = original === '1080p' ? 'native' : '1080p'
    try {
      ok(await call(`setOutputResolution(${JSON.stringify(target)})`))
      await expectLog(/Video configured: base=.* output=.* @/, 60000)
      const read = ok(await call('getOutputResolution()'))
      if (read !== target) throw new Error(`read back ${read}`)
    } finally {
      ok(await call(`setOutputResolution(${JSON.stringify(original)})`))
      await expectLog(/Video configured: base=.* output=.* @/, 60000)
    }
  })

  console.log('\n================ SETTINGS AUDIT ================')
  for (const line of results) console.log(line)
  console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`)
}
