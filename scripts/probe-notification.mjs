/**
 * The notification popup must name the action and its hotkey, and a failure must
 * carry the engine's own reason.
 *
 * The popup is its own BrowserWindow, so this probe reads the real window rather
 * than the main panel. It fires genuine OS-level hotkeys (SendKeys reaches the
 * global uiohook listener) and asserts the rendered text for all four hotkey
 * actions -- save, quick clip, screenshot, record toggle -- on success and on
 * failure.
 *
 * Run against the app on --remote-debugging-port=9222.
 */
import { execFileSync } from 'node:child_process'

const PORT = process.env.CDP_PORT || '9222'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
function check(name, pass, detail = '') {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`)
}

async function pages() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  return list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
}

/** Waits until no notification popup is open, so the next read cannot see a stale one. */
async function waitForNoPopup() {
  for (let i = 0; i < 40; i++) {
    if (!(await pages()).some((t) => (t.url || '').includes('notification='))) return true
    await sleep(250)
  }
  return false
}

/** Attaches to the notification popup window, waiting for it to appear. */
async function attachPopup() {
  for (let i = 0; i < 30; i++) {
    const page = (await pages()).find((t) => (t.url || '').includes('notification='))
    if (!page) {
      await sleep(300)
      continue
    }
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((res, rej) => {
      ws.onopen = res
      ws.onerror = rej
    })
    let id = 0
    const pending = new Map()
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id)
        pending.delete(m.id)
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
      }
    }
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const mid = ++id
        pending.set(mid, { resolve, reject })
        ws.send(JSON.stringify({ id: mid, method, params }))
      })
    await send('Runtime.enable')
    /*
     * The window exists before React has rendered into it, so reading immediately
     * returns an empty body -- which looks exactly like a fix that shows nothing.
     * Poll until the popup actually has text, then read it.
     */
    const readWhenRendered = async () => {
      for (let i = 0; i < 25; i++) {
        const r = await send('Runtime.evaluate', {
          expression: `document.body.innerText.replace(/\\s+/g, ' ').trim()`,
          returnByValue: true,
        })
        const text = r.result.value ?? ''
        if (text) return text
        await sleep(200)
      }
      return ''
    }
    return {
      read: readWhenRendered,
      close: () => ws.close(),
    }
  }
  return null
}

/** Fires a hotkey through the OS, so the global hook sees it. */
function fire(keys) {
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms',
    `[System.Windows.Forms.SendKeys]::SendWait("${keys}")`,
  ].join('; ')
  execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' })
}

/** Fires a hotkey, reads the popup it opens, and leaves the popup to close itself. */
async function popupText(keys) {
  await waitForNoPopup()
  fire(keys)
  const popup = await attachPopup()
  if (!popup) return null
  const text = await popup.read()
  popup.close()
  return text
}

/** Polls a boolean expression from the renderer until it is true. */
async function waitFor(evaluate, expr, label) {
  for (let i = 0; i < 30; i++) {
    if (await evaluate(expr)) return true
    await sleep(500)
  }
  console.log(`(timed out waiting for ${label})`)
  return false
}

export default async function ({ evaluate }) {
  await waitFor(evaluate, `window.electronAPI.getStatus().then(r => r.data?.status === 'ready')`, 'engine ready')

  const outputRoot = await evaluate(`window.electronAPI.getOutputPath().then(r => r.data)`)
  const screenshotDir = await evaluate(`window.electronAPI.getScreenshotPath().then(r => r.data)`)

  // --- failures: stop the buffer, then every hotkey that needs it must say why ---
  console.log('stopping the buffer to force genuine failures...')
  await evaluate(`window.electronAPI.setReplayBufferActive(false).catch(() => 0)`)
  await waitFor(evaluate, `window.electronAPI.isReplayBufferActive().then(r => r.data?.active === false)`, 'buffer off')
  await sleep(1000)

  const saveFail = await popupText('%1')
  console.log('save failure popup:', JSON.stringify(saveFail))
  check('save failure: title names the action and key', /Clip not saved/.test(saveFail ?? '') && /Alt \+ 1/.test(saveFail ?? ''), saveFail ?? 'no popup')
  check('save failure: body carries the engine reason', /Buffer is off/.test(saveFail ?? ''), saveFail ?? 'no popup')

  const quickFail = await popupText('^%1')
  console.log('quick-clip failure popup:', JSON.stringify(quickFail))
  check('quick-clip failure: title names the action and key', /Clip not saved/.test(quickFail ?? '') && /Ctrl \+ Alt \+ 1/.test(quickFail ?? ''), quickFail ?? 'no popup')
  check('quick-clip failure: body carries the engine reason', /Buffer is off/.test(quickFail ?? ''), quickFail ?? 'no popup')

  // After a rebind the failure must still pop, and name the new key: the rebind
  // path installs its own callbacks, so a service that throws without catching
  // would be silent here while the startup path still worked.
  const originalQuick = await evaluate(`window.electronAPI.getHotkeys().then(r => r.data['save-quick-clip'])`)
  const rebound = await evaluate(`window.electronAPI.setHotkey('save-quick-clip', 'Alt+5').then(r => JSON.stringify(r)).catch(e => 'THREW: ' + e.message)`)
  check('quick-clip rebound to Alt+5', String(rebound).includes('"success":true'), rebound)
  const reboundFail = await popupText('%5')
  console.log('rebound quick-clip failure popup:', JSON.stringify(reboundFail))
  check(
    'after a rebind: the failure still pops, with the new key',
    /Clip not saved/.test(reboundFail ?? '') && /Alt \+ 5/.test(reboundFail ?? '') && /Buffer is off/.test(reboundFail ?? ''),
    reboundFail ?? 'no popup',
  )
  await evaluate(`window.electronAPI.setHotkey('save-quick-clip', ${JSON.stringify(originalQuick)}).catch(() => 0)`)
  const restoredQuick = await evaluate(`window.electronAPI.getHotkeys().then(r => r.data['save-quick-clip'])`)
  check('quick-clip binding restored', restoredQuick === originalQuick, `${restoredQuick} vs ${originalQuick}`)

  const recordFail = await popupText('%3')
  console.log('record failure popup:', JSON.stringify(recordFail))
  check('record failure: title names the action and key', /Recording not started/.test(recordFail ?? '') && /Alt \+ 3/.test(recordFail ?? ''), recordFail ?? 'no popup')
  check('record failure: body carries the engine reason', /buffer is not running/i.test(recordFail ?? ''), recordFail ?? 'no popup')

  // --- successes: bring the buffer back and let it settle ---
  console.log('restarting the buffer...')
  await evaluate(`window.electronAPI.setReplayBufferActive(true).catch(() => 0)`)
  await waitFor(evaluate, `window.electronAPI.isReplayBufferActive().then(r => r.data?.active === true)`, 'buffer on')
  await sleep(4000)

  const saveOk = await popupText('%1')
  console.log('save popup:', JSON.stringify(saveOk))
  check('save: title names the action and key', /Clip saved/.test(saveOk ?? '') && /Alt \+ 1/.test(saveOk ?? ''), saveOk ?? 'no popup')
  check('save: body shows where it went', (saveOk ?? '').includes(outputRoot), `outputRoot=${outputRoot}`)

  const shotOk = await popupText('%2')
  console.log('screenshot popup:', JSON.stringify(shotOk))
  check('screenshot: title names the action and key', /Screenshot taken/.test(shotOk ?? '') && /Alt \+ 2/.test(shotOk ?? ''), shotOk ?? 'no popup')
  check('screenshot: body shows where it went', (shotOk ?? '').includes(screenshotDir), `screenshotDir=${screenshotDir}`)

  const recordStart = await popupText('%3')
  console.log('record start popup:', JSON.stringify(recordStart))
  check('record start: title names the action and key', /Recording started/.test(recordStart ?? '') && /Alt \+ 3/.test(recordStart ?? ''), recordStart ?? 'no popup')

  await sleep(6000)
  const recordStop = await popupText('%3')
  console.log('record stop popup:', JSON.stringify(recordStop))
  check('record stop: title names the action and key', /Recording saved/.test(recordStop ?? '') && /Alt \+ 3/.test(recordStop ?? ''), recordStop ?? 'no popup')

  // Put the buffer back the way it was found.
  await evaluate(`window.electronAPI.setReplayBufferActive(true).catch(() => 0)`)

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) process.exitCode = 1
}
