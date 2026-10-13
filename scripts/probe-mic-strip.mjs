/**
 * Microphone strip probe.
 *
 * The strip is a control, not an instrument: device name, fader and mute toggle,
 * with no level meter. This checks it is on the main page, that both controls
 * reach the stored fader, and that the meter's event channel is gone. The original
 * values are restored, so running this probe never changes a user's microphone.
 *
 * Run against the app on --remote-debugging-port=9222:
 *   node scripts/cdp.mjs scripts/probe-mic-strip.mjs
 */
export default async function ({ evaluate }) {
  const results = []
  const check = (name, pass, detail = '') => {
    results.push({ name, pass })
    console.log(`${pass ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`)
  }

  check('mic strip is on the main page', (await evaluate(`!!document.querySelector('[data-testid="mic-strip"]')`)) === true)

  // The preload throws on an unknown channel, so this is the meter's absence
  // proved rather than assumed.
  const channelGone = await evaluate(`(() => {
    try { window.electronAPI.on('mic-level', () => {}) ; return false }
    catch { return true }
  })()`)
  check('meter channel is gone', channelGone === true)

  const before = await evaluate(`window.electronAPI.getAudioLevels().then(r => r.data.microphone)`)
  await evaluate(`window.electronAPI.setChannelVolume('microphone', 0.5).then(r => r.success)`)
  const volume = await evaluate(`window.electronAPI.getAudioLevels().then(r => r.data.microphone.volume)`)
  check('volume write reaches the stored fader', volume === 0.5, String(volume))

  await evaluate(`window.electronAPI.setChannelMuted('microphone', true).then(r => r.success)`)
  const muted = await evaluate(`window.electronAPI.getAudioLevels().then(r => r.data.microphone.muted)`)
  check('mute write reaches the stored fader', muted === true, String(muted))

  await evaluate(`window.electronAPI.setChannelMuted('microphone', ${Boolean(before.muted)})`)
  await evaluate(`window.electronAPI.setChannelVolume('microphone', ${Number(before.volume)})`)

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
}
