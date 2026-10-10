import fs from 'node:fs'
import path from 'node:path'
const OUT = 'C:\\Users\\jude\\AppData\\Local\\Temp\\reflect-shots'
fs.mkdirSync(OUT, { recursive: true })
const send = (ws, id, method, params = {}) => new Promise((resolve) => {
  const onMsg = (ev) => { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener('message', onMsg); resolve(m.result) } }
  ws.addEventListener('message', onMsg); ws.send(JSON.stringify({ id, method, params }))
})
const connect = (u) => new Promise(async (r) => { const w = new WebSocket(u); await new Promise(x => w.addEventListener('open', x)); r(w) })
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const t = await (await fetch('http://127.0.0.1:9222/json')).json()
const panel = t.find(x => x.type === 'page' && x.webSocketDebuggerUrl && !x.url.includes('editor') && !x.url.includes('notification'))
const ws = await connect(panel.webSocketDebuggerUrl)
const shot = async (n) => { const r = await send(ws, 1, 'Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, n + '.png'), Buffer.from(r.data, 'base64')); console.log(n + '.png') }
await shot('min-01-panel')
await send(ws, 2, 'Runtime.evaluate', { expression: "window.location.hash='/settings'" }); await sleep(2500)
await shot('min-02-settings')
// scroll to the hotkeys card
await send(ws, 3, 'Runtime.evaluate', { expression: "(()=>{const c=[...document.querySelectorAll('div')].find(d=>d.scrollHeight>d.clientHeight+40); if(c) c.scrollTop=c.scrollHeight; return 1})()" }); await sleep(900)
await shot('min-03-hotkeys')
ws.close()
