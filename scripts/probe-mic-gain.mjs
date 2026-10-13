/**
 * The microphone input gain round-trip.
 *
 * Gain shipped in 1.0.1 as a working-looking slider that threw on every drag:
 * `set-mic-gain` was declared in `shared/ipc.ts`, exposed on the preload
 * bridge, typed in the renderer API and called from Settings -- with no handler
 * registered in the main process. The `isMicGain` validator was written and
 * never used.
 *
 * Three assertions. The third matters as much as the first: a setter that
 * silently clamps an out-of-range value instead of rejecting it would let the UI
 * display a gain the pipeline never applied.
 *
 * Run against the app on --remote-debugging-port=9222. Restores the previous
 * gain on the way out.
 */

const results = []
function check(name, pass, detail = '') {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`)
}

export default async function ({ evaluate }) {
  /*
   * A channel with no handler rejects rather than resolving, so every call is
   * wrapped. Without this the probe dies on the first `set` and the remaining
   * checks never report -- and a probe that aborts is a probe whose output says
   * nothing about which assertions would have passed.
   */
  const safe = async (expr) => {
    try {
      return await evaluate(`(async () => { try { return JSON.stringify(await (${expr})) } catch (e) { return 'REJECTED: ' + e.message } })()`)
    } catch (e) {
      return 'REJECTED: ' + e.message
    }
  }

  const original = await evaluate(`window.electronAPI.getMicGain().then(r => r.data)`)
  check('getMicGain returns the current value', typeof original === 'number', String(original))

  // 1. Round-trip: set, then read back.
  const set = await safe(`window.electronAPI.setMicGain(1.5)`)
  let setOk = false
  try {
    setOk = JSON.parse(set).success === true
  } catch {
    setOk = false
  }
  check('setMicGain(1.5) succeeds', setOk, set)

  const after = await evaluate(`window.electronAPI.getMicGain().then(r => r.data)`)
  check('getMicGain reads back 1.5', after === 1.5, String(after))

  // 2. Out of range must be rejected, not clamped.
  const tooHigh = await safe(`window.electronAPI.setMicGain(99)`)
  let rejected = false
  try {
    rejected = JSON.parse(tooHigh).success === false
  } catch {
    rejected = false
  }
  check('setMicGain(99) is rejected', rejected, tooHigh)
  check(
    'rejection is a handled failure, not an unhandled-channel throw',
    !String(tooHigh).startsWith('REJECTED:'),
    String(tooHigh),
  )

  const stillSet = await evaluate(`window.electronAPI.getMicGain().then(r => r.data)`)
  check('rejected write left the value alone', stillSet === 1.5, String(stillSet))

  // Restore, so running this probe does not change the user's microphone gain.
  if (typeof original === 'number') {
    await safe(`window.electronAPI.setMicGain(${original})`)
  }

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
}