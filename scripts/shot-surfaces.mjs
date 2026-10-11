import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
const OUT = path.join(os.tmpdir(), 'rewind-shots')
fs.mkdirSync(OUT, { recursive: true })

const send = (ws, id, method, params = {}) => new Promise((resolve) => {
  const onMsg = (ev) => { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener('message', onMsg); resolve(m.result) } }
  ws.addEventListener('message', onMsg)
  ws.send(JSON.stringify({ id, method, params }))
})
const connect = (url) => new Promise(async (r) => { const ws = new WebSocket(url); await new Promise(x => ws.addEventListener('open', x)); r(ws) })
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const targets = await (await fetch('http://127.0.0.1:9222/json')).json()
const panel = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl && !t.url.includes('editor') && !t.url.includes('notification'))
const ws = await connect(panel.webSocketDebuggerUrl)

const shot = async (name) => {
  const r = await send(ws, 1, 'Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'))
  console.log(name + '.png')
}

await shot('polish-01-panel')
await send(ws, 2, 'Runtime.evaluate', { expression: "window.location.hash='/settings'" })
await sleep(2500)
await shot('polish-02-settings-top')
await send(ws, 3, 'Runtime.evaluate', { expression: "document.querySelector('.scroll-stable')?.scrollTo(0, 700)" })
await sleep(900)
await shot('polish-03-settings-mid')
await send(ws, 4, 'Runtime.evaluate', { expression: "document.querySelector('.scroll-stable')?.scrollTo(0, 99999)" })
await sleep(900)
await shot('polish-04-settings-bottom')
ws.close()
