import fs from 'node:fs'
import path from 'node:path'
const OUT = 'C:\\Users\\jude\\AppData\\Local\\Temp\\rewind-shots'
const send = (ws, id, method, params = {}) => new Promise((resolve) => {
  const onMsg = (ev) => { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener('message', onMsg); resolve(m.result) } }
  ws.addEventListener('message', onMsg); ws.send(JSON.stringify({ id, method, params }))
})
const connect = (u) => new Promise(async (r) => { const w = new WebSocket(u); await new Promise(x => w.addEventListener('open', x)); r(w) })
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const t = await (await fetch('http://127.0.0.1:9222/json')).json()
const panel = t.find(x => x.type === 'page' && x.webSocketDebuggerUrl && !x.url.includes('editor') && !x.url.includes('notification'))
const ws = await connect(panel.webSocketDebuggerUrl)

const evalIn = (expression) => send(ws, 9, 'Runtime.evaluate', { expression, returnByValue: true }).then(r => r?.result?.value)

// Go to Settings so the shot shows the overlay covering a real page.
await evalIn("window.location.hash='/settings'")
await sleep(2000)

const fps = await evalIn("window.electronAPI.getFps().then(r=>r.data)")
const target = fps === 30 ? 120 : 30
console.log('fps', fps, '->', target)
await evalIn(`(()=>{window.electronAPI.setFps(${target})})()`)

// Poll fast so we catch the overlay mid-restart and shoot it.
for (let i = 0; i < 40; i++) {
  await sleep(400)
  const has = await evalIn(`!!document.querySelector('[role="alertdialog"]')`)
  if (has) {
    const r = await send(ws, 1, 'Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(OUT, 'restart-overlay.png'), Buffer.from(r.data, 'base64'))
    console.log('captured restart-overlay.png at poll', i)
    break
  }
}
ws.close()
