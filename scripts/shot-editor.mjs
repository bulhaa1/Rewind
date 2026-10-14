/** Captures the editor window for a look-and-fix pass. */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const OUT = path.join(os.tmpdir(), 'rewind-shots')
fs.mkdirSync(OUT, { recursive: true })

const t = await (await fetch('http://127.0.0.1:9222/json')).json()
const editor = t.find((x) => x.type === 'page' && x.webSocketDebuggerUrl && x.url.includes('editor=1'))
if (!editor) {
  console.log('no editor window open')
  process.exit(1)
}
const ws = new WebSocket(editor.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r))
let id = 0
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const mid = ++id
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id === mid) {
        ws.removeEventListener('message', onMsg)
        resolve(m.result)
      }
    }
    ws.addEventListener('message', onMsg)
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
const r = await send('Page.captureScreenshot', { format: 'png' })
const name = process.argv[2] ?? 'editor'
fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'))
console.log(path.join(OUT, `${name}.png`))
ws.close()
