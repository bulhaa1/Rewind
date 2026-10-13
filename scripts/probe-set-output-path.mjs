/**
 * Picking a save location must create the app's own `Rewind` folder there and
 * report the effective path, not the raw pick.
 *
 * `rewindRoot` (`obs-core.ts`) already puts clips under `<chosen>\Rewind`, so the
 * picker's raw value was never where files land: the row showed `Z:\Captures`
 * while Explorer grew a `Rewind` folder beside it, and the folder appeared only
 * when something first wrote into it.
 *
 * Run against the app on --remote-debugging-port=9222. Restores the original save
 * location on the way out.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const results = []
function check(name, pass, detail = '') {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`)
}

export default async function ({ evaluate }) {
  const original = await evaluate(`window.electronAPI.getOutputPath().then(r => r.data)`)
  console.log(`original effective path: ${original}`)

  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'rewind-dest-'))
  console.log(`picking a fresh folder: ${target}`)

  const res = JSON.parse(
    await evaluate(`window.electronAPI.setOutputPath(${JSON.stringify(target)}).then(r => JSON.stringify(r)).catch(e => JSON.stringify({ threw: e.message }))`),
  )
  console.log('setOutputPath ->', JSON.stringify(res))

  check('the pick succeeded', res.success === true, JSON.stringify(res))
  const effective = res.data
  const rewindDir = path.join(target, 'Rewind')
  check('the effective path is inside the picked folder', typeof effective === 'string' && effective.toLowerCase() === rewindDir.toLowerCase(), `got ${effective}`)
  check('the Rewind folder exists on disk right away', fs.existsSync(rewindDir), `${rewindDir} exists=${fs.existsSync(rewindDir)}`)

  // Put the original location back before cleaning up.
  if (original) {
    const restored = JSON.parse(
      await evaluate(`window.electronAPI.setOutputPath(${JSON.stringify(original)}).then(r => JSON.stringify(r)).catch(e => JSON.stringify({ threw: e.message }))`),
    )
    check('the original location was restored', restored.success === true, JSON.stringify(restored))
    const back = await evaluate(`window.electronAPI.getOutputPath().then(r => r.data)`)
    check('the effective path is unchanged after restore', back === original, `${back} vs ${original}`)
  }

  try {
    fs.rmSync(target, { recursive: true, force: true })
  } catch {
    /* best effort */
  }

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) process.exitCode = 1
}
