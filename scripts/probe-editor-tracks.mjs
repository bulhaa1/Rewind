/**
 * The audio-lane regression test: a clip's lanes must describe the clip, not the
 * app's current settings.
 *
 * Records a clip with separate tracks on, opens it, reads the lanes, turns the
 * setting off, reopens the *same* clip and reads the lanes again. The two reads
 * must match. Before the fix they could not: the lane count came from the live
 * label list, so turning the setting off collapsed a three-stream clip to one lane.
 *
 * Run against the app on --remote-debugging-port=9222. Leaves one extra clip behind.
 */

const PORT = process.env.CDP_PORT || '9222'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
function check(name, pass, detail = '') {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`)
}

/** The lane labels the editor actually drew, read off the DOM. */
const LANES = `
  [...document.querySelectorAll('input[type=range]')]
    .map(i => i.getAttribute('aria-label'))
    .filter(a => a && a.endsWith(' volume'))
`

/** A second CDP connection, because the editor is its own window. */
async function attachEditor(label) {
  for (let i = 0; i < 40; i++) {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const page = list.find((t) => t.type === 'page' && (t.url || '').includes('editor=1'))
    if (page) {
      const ws = new WebSocket(page.webSocketDebuggerUrl)
      await new Promise((res, rej) => {
        ws.onopen = res
        ws.onerror = rej
      })
      let id = 0
      const pending = new Map()
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data)
        if (msg.id && pending.has(msg.id)) {
          const { resolve, reject } = pending.get(msg.id)
          pending.delete(msg.id)
          msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
        }
      }
      const send = (method, params = {}) =>
        new Promise((resolve, reject) => {
          const mid = ++id
          pending.set(mid, { resolve, reject })
          ws.send(JSON.stringify({ id: mid, method, params }))
        })
      const evaluate = async (expression) => {
        const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed')
        return r.result.value
      }
      await send('Runtime.enable')
      await send('Page.enable')
      // Peaks load asynchronously after the lanes; wait for a settled label list.
      for (let k = 0; k < 30; k++) {
        const text = await evaluate(`document.body.innerText`)
        if (text && !/Loading/i.test(text)) break
        await sleep(500)
      }
      await sleep(1500)
      const lanes = await evaluate(LANES)
      const shot = await send('Page.captureScreenshot', { format: 'png' }).catch(() => null)
      if (shot?.data) {
        const fs = await import('node:fs')
        const os = await import('node:os')
        const path = await import('node:path')
        const out = path.join(os.tmpdir(), `rewind-lanes-${label}.png`)
        fs.writeFileSync(out, Buffer.from(shot.data, 'base64'))
        console.log(`  screenshot: ${out}`)
      }
      return { evaluate, send, close: () => ws.close(), lanes }
    }
    await sleep(500)
  }
  throw new Error(`No editor window appeared for "${label}"`)
}

export default async function ({ evaluate }) {
  const call = (expr) => evaluate(expr)

  const initial = await call(`window.electronAPI.getSeparateAudioTracks().then(r => r.data)`)
  console.log(`separateAudioTracks on entry: ${initial}`)

  // 1. On, and let the rebuilt chain accumulate enough to save.
  const on = await call(`window.electronAPI.setSeparateAudioTracks(true).then(r => r.success)`)
  check('separate tracks turned on', on === true)
  await sleep(15_000)

  const before = await call(`window.electronAPI.getSavedClips().then(r => r.data.map(c => c.path))`)
  const saved = await call(`window.electronAPI.saveReplay().then(r => JSON.stringify(r))`)
  console.log('saveReplay ->', saved)
  await sleep(8000)

  const after = await call(`window.electronAPI.getSavedClips().then(r => r.data.map(c => c.path))`)
  const fresh = after.filter((p) => !before.includes(p))
  check('a new clip was recorded', fresh.length > 0, `${after.length - before.length} new`)
  if (!fresh.length) {
    console.log('\nno clip to open; cannot continue')
    return
  }
  const clip = fresh[0]
  console.log('clip:', clip)

  const infoOn = await call(
    `window.electronAPI.editorGetClipInfo(${JSON.stringify(clip)}).then(r => JSON.stringify(r.data?.audioTracks))`,
  )
  console.log('getClipInfo with the setting on:', infoOn)

  // 2. Lanes as drawn, with the setting still on.
  await call(`window.electronAPI.openClipEditor(${JSON.stringify(clip)}).then(r => r.success)`)
  const first = await attachEditor('on')
  const lanesOn = first.lanes
  console.log('lanes (setting on):', JSON.stringify(lanesOn))
  check('multiple lanes while the setting is on', lanesOn.length > 1, lanesOn.join(' | '))
  check(
    'lanes carry the recorded names',
    lanesOn.some((l) => /Desktop|Microphone/i.test(l)),
    lanesOn.join(' | '),
  )
  await first.evaluate(`window.close()`)
  await sleep(2500)
  first.close()

  // 3. The setting goes off. Nothing about the clip changes; only the app does.
  const off = await call(`window.electronAPI.setSeparateAudioTracks(false).then(r => r.success)`)
  check('separate tracks turned off', off === true)
  await sleep(3000)

  const infoOff = await call(
    `window.electronAPI.editorGetClipInfo(${JSON.stringify(clip)}).then(r => JSON.stringify(r.data?.audioTracks))`,
  )
  console.log('getClipInfo with the setting off:', infoOff)

  // 4. Reopen the same clip. This is the regression: the lanes must not move.
  await call(`window.electronAPI.openClipEditor(${JSON.stringify(clip)}).then(r => r.success)`)
  const second = await attachEditor('off')
  const lanesOff = second.lanes
  console.log('lanes (setting off):', JSON.stringify(lanesOff))
  check('lanes unchanged after reopening with the setting off', JSON.stringify(lanesOn) === JSON.stringify(lanesOff), `${JSON.stringify(lanesOn)} vs ${JSON.stringify(lanesOff)}`)
  await second.evaluate(`window.close()`)
  await sleep(1500)
  second.close()

  // 5. A clip that was never split still gets exactly one lane, still named Audio.
  const single = await call(
    `window.electronAPI.getSavedClips().then(r => {
       const c = r.data.filter(c => !c.path.includes('-edit')).pop()
       return window.electronAPI.editorGetClipInfo(c.path).then(i => JSON.stringify({path: c.path, tracks: i.data.audioTracks}))
     })`,
  )
  console.log('single-stream clip:', single)
  const singleTracks = JSON.parse(single).tracks
  check(
    'a one-stream clip is still one lane named Audio',
    singleTracks.length === 1 && singleTracks[0].label === 'Audio',
    JSON.stringify(singleTracks),
  )

  // 6. A trim with no volume change is still a stream copy, tracks and all.
  const trimmed = await call(
    `window.electronAPI.editorSaveClip({clipPath: ${JSON.stringify(clip)}, startSec: 0, endSec: 3, mode: 'copy'})
       .then(r => JSON.stringify(r))`,
  )
  console.log('trim-only copy:', trimmed)
  check('trim-only copy saved', trimmed.includes('success":true'), trimmed)

  // 7. Leave the app as it was found.
  await call(`window.electronAPI.setSeparateAudioTracks(${initial}).then(r => r.success)`)

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) process.exitCode = 1
}