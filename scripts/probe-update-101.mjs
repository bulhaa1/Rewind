/**
 * The 1.0.1 -> 1.1.0 update path, driven through the real UI of the installed
 * 1.0.1 build.
 *
 * Run against the installed 1.0.1 on --remote-debugging-port=9224 (CDP_PORT).
 * It opens the update control, clicks Check for updates, asserts 1.1.0 is
 * offered, clicks Download, waits for ready, records the settings so the build
 * after the update can be compared, then clicks Restart and install.
 *
 * The NSIS wizard that follows is not drivable over CDP; the shell drives it,
 * and probe-after-update.mjs checks the result.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
function check(name, pass, detail = '') {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`)
}

async function updateState(evaluate) {
  try {
    return JSON.parse(await evaluate(`window.electronAPI.getUpdateState().then(r => JSON.stringify(r.data))`))
  } catch {
    return null
  }
}

export default async function ({ evaluate }) {
  const before = await evaluate(`window.electronAPI.getAppVersion().then(r => r.data)`)
  check('the installed build is 1.0.1', before === '1.0.1', String(before))

  const settings = JSON.parse(
    await evaluate(
      `Promise.all([window.electronAPI.getOutputPath(), window.electronAPI.getScreenshotPath(), window.electronAPI.getHotkeys()])` +
        `.then(([o, s, h]) => JSON.stringify({ outputPath: o.data, screenshotPath: s.data, hotkeys: h.data }))`,
    ),
  )
  console.log('settings before:', JSON.stringify(settings))
  fs.writeFileSync(path.join(os.tmpdir(), 'rewind-update-before.json'), JSON.stringify(settings, null, 2))

  // Open the update control (the trigger carries the label).
  const opened = await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /update/i.test(x.getAttribute('aria-label') || ''))
    if (!b) return false
    b.click()
    return true
  })()`)
  check('the update control exists and opened', opened === true)
  await sleep(400)

  // Click Check for updates.
  const checked = await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /check for updates/i.test(x.textContent || ''))
    if (!b) return false
    b.click()
    return true
  })()`)
  check('clicked Check for updates', checked === true)

  let st = null
  for (let i = 0; i < 60; i++) {
    await sleep(1000)
    st = await updateState(evaluate)
    if (st && st.status !== 'checking' && st.status !== 'idle') break
  }
  console.log('after check:', JSON.stringify(st))
  check('1.1.0 is offered to 1.0.1', st?.status === 'available' && String(st?.version) === '1.1.0', JSON.stringify(st))

  // Click Download.
  const downloading = await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /download/i.test(x.textContent || ''))
    if (!b) return false
    b.click()
    return true
  })()`)
  check('clicked Download', downloading === true)

  for (let i = 0; i < 900; i++) {
    await sleep(2000)
    st = await updateState(evaluate)
    if (st && (st.status === 'ready' || st.status === 'error')) break
  }
  console.log('after download:', JSON.stringify(st))
  check('the update downloaded and is ready', st?.status === 'ready', JSON.stringify(st))

  // Click Restart and install. Fire-and-forget: the app quits under this call,
  // and awaiting it would hang the probe on a socket that never answers.
  void evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /restart and install/i.test(x.textContent || ''))
    if (!b) return false
    b.click()
    return true
  })()`).catch(() => {})
  await sleep(4000)
  console.log('Restart and install clicked; the installer should be up.')

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) process.exitCode = 1
}
