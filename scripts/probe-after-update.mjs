/**
 * The build after the 1.0.1 -> 1.1.0 update: version, engine and settings.
 *
 * Run against the updated app on --remote-debugging-port=9224 (CDP_PORT).
 * Compares against the settings probe-update-101.mjs recorded before the update.
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

export default async function ({ evaluate }) {
  for (let i = 0; i < 40; i++) {
    const st = await evaluate(`window.electronAPI.getStatus().then(r => r.data?.status)`).catch(() => null)
    if (st === 'ready') break
    await sleep(1000)
  }

  const version = await evaluate(`window.electronAPI.getAppVersion().then(r => r.data)`)
  check('running 1.1.0', version === '1.1.0', String(version))

  const settings = JSON.parse(
    await evaluate(
      `Promise.all([window.electronAPI.getOutputPath(), window.electronAPI.getScreenshotPath(), window.electronAPI.getHotkeys()])` +
        `.then(([o, s, h]) => JSON.stringify({ outputPath: o.data, screenshotPath: s.data, hotkeys: h.data }))`,
    ),
  )
  console.log('settings after:', JSON.stringify(settings))

  const before = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'rewind-update-before.json'), 'utf8'))
  check('the save location survived the update', settings.outputPath === before.outputPath, `${settings.outputPath} vs ${before.outputPath}`)
  check('the screenshot location survived', settings.screenshotPath === before.screenshotPath, `${settings.screenshotPath} vs ${before.screenshotPath}`)
  // Every binding the old build had must keep its value. The new build adds
  // bindings the old one did not have (quick clip, record toggle), which fill in
  // with defaults -- a strict object comparison would flag that as a regression.
  const kept = Object.entries(before.hotkeys).filter(([action, key]) => settings.hotkeys[action] === key)
  check(
    'every existing hotkey survived',
    kept.length === Object.keys(before.hotkeys).length,
    `${JSON.stringify(settings.hotkeys)} vs before ${JSON.stringify(before.hotkeys)}`,
  )

  const st = await evaluate(`window.electronAPI.getStatus().then(r => r.data)`)
  check('the engine is ready after the update', st?.status === 'ready', JSON.stringify(st))

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) process.exitCode = 1
}
