import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const OUT = path.join(os.tmpdir(), 'rewind-shots')
fs.mkdirSync(OUT, { recursive: true })

const targets = await (await fetch('http://127.0.0.1:9222/json')).json()
const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
if (!pages.length) { console.log('no pages'); process.exit(1) }

async function shot(ws, name) {
  const send = (id, method, params = {}) =>
    new Promise((resolve) => {
      const onMsg = (ev) => {
        const m = JSON.parse(ev.data)
        if (m.id === id) { ws.removeEventListener('message', onMsg); resolve(m.result) }
      }
      ws.addEventListener('message', onMsg)
      ws.send(JSON.stringify({ id, method, params }))
    })

  const r = await send(1, 'Page.captureScreenshot', { format: 'png' })
  const file = path.join(OUT, `${name}.png`)
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
  console.log(file)
}

for (const p of pages) {
  const ws = new WebSocket(p.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r))
  const label = p.url.includes('settings') ? 'settings' : 'panel'
  await shot(ws, label)
  ws.close()
}
