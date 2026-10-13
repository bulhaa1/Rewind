/**
 * Microphone meter probe.
 *
 * Checks the mic strip is on the main page, that OBS's meter feeds it while the
 * panel is visible, and that the feed stops once the panel is hidden to the tray
 * -- the meter is attached only while there is something to draw.
 *
 * What this cannot check on a machine whose inputs carry no signal: that the
 * levels *track* the microphone. Asserting "updates arrive" is the honest ceiling
 * here; the values themselves are silence-floor numbers. Every input endpoint on
 * this machine reads digital silence, which ISSUES.md already records for the
 * microphone gain verification.
 *
 * Run against the app on --remote-debugging-port=9222:
 *   node scripts/cdp.mjs scripts/probe-mic-meter.mjs
 */
export default async function ({ evaluate }) {
  const results = []
  const check = (name, pass, detail = '') => {
    results.push({ name, pass })
    console.log(`${pass ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`)
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  check('mic strip is on the main page', (await evaluate(`!!document.querySelector('[data-testid="mic-strip"]')`)) === true)

  // Count what the renderer receives and remember the loudest peak seen.
  await evaluate(`(() => {
    window.__mic = { count: 0, max: 0, bad: 0 }
    window.__micOff = window.electronAPI.on('mic-level', (l) => {
      window.__mic.count++
      const p = Number(l && l.peak)
      if (!Number.isFinite(p) || p < 0 || p > 10) window.__mic.bad++
      window.__mic.max = Math.max(window.__mic.max, p || 0)
    })
    return true
  })()`)

  console.log(`visibility: ${JSON.stringify(await evaluate(`({ hidden: document.hidden, state: document.visibilityState })`))}`)

  await sleep(6000)
  const during = await evaluate(`window.__mic`)
  check('levels arrive while the panel is visible', during.count > 0, `${during.count} updates in 6 s`)
  check('every level is a finite amplitude', during.bad === 0, `${during.bad} malformed`)

  // The strip's two controls go through the same IPC pairs Settings uses. The
  // original values are restored so running this probe never changes a user's
  // microphone.
  const before2 = await evaluate(`window.electronAPI.getAudioLevels().then(r => r.data.microphone)`)
  await evaluate(`window.electronAPI.setChannelVolume('microphone', 0.5).then(r => r.success)`)
  const set = await evaluate(`window.electronAPI.getAudioLevels().then(r => r.data.microphone.volume)`)
  check('volume write reaches the stored fader', set === 0.5, String(set))
  await evaluate(`window.electronAPI.setChannelMuted('microphone', true).then(r => r.success)`)
  const muted = await evaluate(`window.electronAPI.getAudioLevels().then(r => r.data.microphone.muted)`)
  check('mute write reaches the stored fader', muted === true, String(muted))
  await evaluate(`window.electronAPI.setChannelMuted('microphone', ${Boolean(before2.muted)})`)
  await evaluate(`window.electronAPI.setChannelVolume('microphone', ${Number(before2.volume)})`)

  await evaluate(`window.__micOff && window.__micOff()`)

  /*
   * Hide the panel the way a user does. The close is issued last and not awaited:
   * hiding the window takes the page's execution context with it, so anything
   * after this point would hang. That the meter then stops is asserted from the
   * main side -- main.log records `Microphone meter detached` -- because the
   * renderer that would count the events is the thing being hidden.
   */
  await evaluate(`setTimeout(() => window.close(), 100); true`)

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
}
