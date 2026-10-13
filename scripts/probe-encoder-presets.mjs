/**
 * Encoder-preset experiment: sets the NVENC preset through the app's own IPC and
 * confirms the chain rebuilt with it.
 *
 * Usage:  PRESET=p3 node scripts/cdp.mjs scripts/probe-encoder-presets.mjs
 *         (no PRESET prints the current state)
 *
 * Run against the app on --remote-debugging-port=9222. The authoritative check is
 * the OBS-side log line the plugin prints (`preset: ...`); this probe leaves that
 * correlation to the caller and just drives the app and reports what it sees.
 */
export default async function ({ evaluate }) {
  const state = async () =>
    evaluate(`(async () => {
      const api = window.electronAPI
      const [p, active, vendor, encoder] = await Promise.all([
        api.getNvencPreset(),
        api.isReplayBufferActive(),
        api.getActiveEncoderVendor(),
        api.getAvailableEncoderVendors().catch(() => null),
      ])
      return { preset: p.data, bufferActive: active.data?.active, vendor: vendor.data }
    })()`)

  const target = (process.env.PRESET || '').trim()
  const before = await state()
  console.log('before:', JSON.stringify(before))

  if (!target) {
    console.log('no PRESET set; nothing changed')
    return
  }

  const res = await evaluate(`window.electronAPI.setNvencPreset(${JSON.stringify(target)})`)
  console.log(`setNvencPreset(${target}) ->`, JSON.stringify(res))
  if (!res.success) return

  // The chain rebuild stops and restarts the buffer; wait for it to be live again.
  let live = false
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500))
    const s = await state()
    if (s.bufferActive) {
      live = true
      break
    }
  }
  await new Promise((r) => setTimeout(r, 2000))
  const after = await state()
  console.log('after:', JSON.stringify(after), live ? '(buffer restarted)' : '(TIMED OUT waiting for buffer)')
}
