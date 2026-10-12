/**
 * Rebinding a hotkey must install that action's own callback.
 *
 * `setHotkey` (`src/main/ipc.ts:1132`) picked one with a binary ternary:
 *
 *   action === 'save-replay' ? s.saveClipHotkey : () => void s.takeScreenshotHotkey()
 *
 * Only `save-replay` got its own callback. Both `screenshot` and
 * `toggle-replay` received the screenshot callback, so rebinding "Start / Stop
 * Recording" took a screenshot instead. The startup path
 * (`index.ts:215-219`) always mapped all three correctly, which is why the bug
 * only appeared after a rebind and never in testing of a fresh install.
 *
 * The decisive check is a dispatch test, not a binding test. This probe
 * rebinds Start / Stop Recording, fires a real OS-level key event (uiohook
 * listens globally, so a synthesised press through the OS reaches it), and
 * asserts that the recording state changed and that no screenshot appeared.
 *
 * Run against the app on --remote-debugging-port=9222. Restores the original
 * hotkeys on the way out.
 */

import { execFileSync } from 'node:child_process'

const results = []
function check(name, pass, detail = '') {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`)
}

const SPARE = 'Alt+4'

/**
 * Synthesises a real key press so the global uiohook hook sees it.
 *
 * `Alt+4` rather than a function key. Control-tested against the default
 * `Alt+2` screenshot binding before relying on it: SendKeys delivered `%2` to the
 * global hook reliably, while `{F9}` and `^{F9}` did not, so a digit combo in the
 * same shape as the working default is the only trustworthy choice here.
 */
function fireHotkey() {
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '[System.Windows.Forms.SendKeys]::SendWait("%4")',
  ].join('; ')
  execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' })
}

export default async function ({ evaluate }) {
  const original = JSON.parse(await evaluate(`window.electronAPI.getHotkeys().then(r => JSON.stringify(r.data))`))
  console.log('original hotkeys:', JSON.stringify(original))

  const res = await evaluate(
    `window.electronAPI.setHotkey('toggle-replay', '${SPARE}').then(r => JSON.stringify(r)).catch(e => 'THREW: ' + e.message)`,
  )
  let bound = false
  try {
    bound = JSON.parse(res).success === true
  } catch {
    bound = false
  }
  check(`rebind toggle-replay to ${SPARE}`, bound, res)

  const after = JSON.parse(await evaluate(`window.electronAPI.getHotkeys().then(r => JSON.stringify(r.data))`))
  check('the rebind took effect', after['toggle-replay'] === SPARE, JSON.stringify(after))

  const before = await evaluate(
    `Promise.all([window.electronAPI.isReplayBufferActive(), window.electronAPI.getScreenshots()])` +
      `.then(([r, s]) => JSON.stringify({ active: r.data?.active, shots: s.data.length }))`,
  )
  const b = JSON.parse(before)
  console.log('before:', before)

  fireHotkey()

  /*
   * Poll rather than sleep a fixed interval. Toggling the buffer tears the OBS
   * chain down and back up, and how long that takes depends on the encoder and
   * the machine; a fixed 2.5s wait read the state before it had changed and
   * reported a working hotkey as broken.
   */
  let now
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    now = JSON.parse(
      await evaluate(
        `Promise.all([window.electronAPI.isReplayBufferActive(), window.electronAPI.getScreenshots()])` +
          `.then(([r, s]) => JSON.stringify({ active: r.data?.active, shots: s.data.length }))`,
      ),
    )
    if (typeof now.active === 'boolean' && now.active !== b.active) {
      console.log(`state changed after ${i + 1}s`)
      break
    }
  }
  console.log('after: ', JSON.stringify(now))

  // A missing field would make `undefined !== <anything>` trivially true, so the
  // observable has to be present on both sides or this check proves nothing.
  check(
    'buffer state was readable on both sides',
    typeof b.active === 'boolean' && typeof now.active === 'boolean',
    `before=${JSON.stringify(b.active)} after=${JSON.stringify(now.active)}`,
  )

  check(
    'the rebound hotkey toggled the replay buffer',
    now.active !== b.active,
    `buffer active ${b.active} -> ${now.active}`,
  )
  /*
   * The other half of the same defect. Before the fix this is the assertion
   * that actually fails: `toggle-replay` and `screenshot` shared one callback,
   * so pressing Start / Stop Recording wrote a screenshot instead. Both halves
   * are asserted because a fix that only stops the screenshot would still leave
   * recording broken.
   */
  check(
    'the rebound hotkey did NOT take a screenshot',
    now.shots === b.shots,
    `screenshots ${b.shots} -> ${now.shots}`,
  )

  // Put the recording back the way it was found.
  if (typeof now.active === 'boolean' && now.active !== b.active) {
    await evaluate(`window.electronAPI.setReplayBufferActive(${b.active}).catch(() => 0)`)
    await new Promise((r) => setTimeout(r, 1500))
  }

  // Restore the original hotkeys.
  for (const [action, accel] of Object.entries(original)) {
    if (accel) await evaluate(`window.electronAPI.setHotkey('${action}', '${accel}').catch(() => 0)`)
  }
  const restored = JSON.parse(await evaluate(`window.electronAPI.getHotkeys().then(r => JSON.stringify(r.data))`))
  check('hotkeys restored', JSON.stringify(restored) === JSON.stringify(original), JSON.stringify(restored))

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
}