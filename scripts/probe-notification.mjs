/**
 * The notification popup must show what actually happened.
 *
 * Two defects, both in the renderer:
 *
 *  - The main process puts a diagnostic in the popup URL as `&message=...`
 *    (`notification.ts:132`) and passes real text -- "Recording not ready",
 *    "Failed to save clip", "Recording stopped responding". `usePopupWindow`
 *    read only `notification` and discarded `message`.
 *  - The subtitle was hardcoded to "Saved to your replays folder" for every kind
 *    except `screenshot` (`NotificationOverlay.tsx:73`), so an error popup read
 *    **"Something went wrong / Saved to your replays folder."**
 *
 * The popup is its own BrowserWindow, so this probe reads the real window
 * rather than the main panel. It triggers a genuine error -- stop the buffer,
 * then save, which is exactly the "Recording not ready" path -- and asserts on
 * the rendered text.
 *
 * Run against the app on --remote-debugging-port=9222.
 */

const PORT = process.env.CDP_PORT || '9222'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
function check(name, pass, detail = '') {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`)
}

/** Attaches to the notification popup window, waiting for it to appear. */
async function attachPopup() {
  for (let i = 0; i < 30; i++) {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const page = list.find((t) => t.type === 'page' && (t.url || '').includes('notification='))
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
      send,
      read: readWhenRendered,
      close: () => ws.close(),
    }
  }
  return null
}

export default async function ({ evaluate }) {
  /*
   * Produce a real error the way a user would: stop the buffer, then press the
   * save hotkey. `saveReplay()` from the renderer is NOT that path -- it returns
   * a failure result without ever calling `showNotification`, so using it here
   * produced no popup at all. The "Recording not ready" notification lives in
   * `saveFromHotkey`, which is what a hotkey press reaches.
   *
   * The hotkey is already bound to Alt+1, and Task 5 proved synthesised key
   * presses reach the global hook.
   */
  console.log('stopping the buffer, then firing the save hotkey to force a genuine error...')
  await evaluate(`window.electronAPI.setReplayBufferActive(false).catch(() => 0)`)
  await sleep(3000)

  const { execFileSync } = await import('node:child_process')
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("%1")',
    ],
    { stdio: 'ignore' },
  )

  const popup = await attachPopup()
  if (!popup) {
    check('an error popup appeared', false, 'no notification window was opened')
    console.log('\n0/1 checks passed')
    return
  }

  const text = await popup.read()
  console.log('popup text:', JSON.stringify(text))

  check(
    'the popup does not claim a save for an error',
    !/Saved to your replays folder/i.test(text),
    text.slice(0, 120),
  )
  check(
    'the popup shows the real diagnostic',
    /not ready|failed|responding|error/i.test(text),
    text.slice(0, 160),
  )
  check(
    'the message reached the renderer, not just the URL',
    /Recording not ready|Failed to save clip|stopped responding/i.test(text),
    text.slice(0, 160),
  )

  popup.close()

  // Put the buffer back.
  await evaluate(`window.electronAPI.setReplayBufferActive(true).catch(() => 0)`)

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
}