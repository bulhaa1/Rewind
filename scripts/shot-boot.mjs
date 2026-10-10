import fs from 'node:fs'
import path from 'node:path'
const OUT = 'C:\\Users\\jude\\AppData\\Local\\Temp\\rewind-shots'
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const send = (ws, id, method, params = {}) => new Promise((resolve) => {
  const onMsg = (ev) => { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener('message', onMsg); resolve(m.result) } }
  ws.addEventListener('message', onMsg); ws.send(JSON.stringify({ id, method, params }))
})

// Reloading the renderer during a cold start is exactly "never seen this engine".
// The overlay's refs reset with the page, so this exercises the boot branch.
for (let attempt = 0; attempt < 40; attempt++) {
  let targets = []
  try { targets = await (await fetch('http://127.0.0.1:9222/json')).json() } catch {}
  const p = targets.find(x => x.type === 'page' && x.webSocketDebuggerUrl && !x.url.includes('editor') && !x.url.includes('notification'))
  if (!p) { await sleep(300); continue }

  let ws
  try {
    ws = await new Promise(async (r) => { const w = new WebSocket(p.webSocketDebuggerUrl); await new Promise(x => w.addEventListener('open', x)); r(w) })
  } catch { await sleep(300); continue }

  try {
    const copy = await Promise.race([
      send(ws, 9, 'Runtime.evaluate', {
        expression: `(()=>{const o=document.querySelector('[role="alertdialog"]');return o?[...o.querySelectorAll('p')].map(x=>x.textContent.trim()).join(' | '):''})()`,
        returnByValue: true,
      }).then(r => r?.result?.value ?? ''),
      sleep(1500).then(() => ''),
    ])
    if (copy) {
      console.log('attempt', attempt, '->', copy)
      if (copy.startsWith('Starting up')) {
        const r = await send(ws, 1, 'Page.captureScreenshot', { format: 'png' })
        fs.writeFileSync(path.join(OUT, 'boot-overlay.png'), Buffer.from(r.data, 'base64'))
        console.log('captured boot-overlay.png')
        ws.close(); process.exit(0)
      }
    }
    // Nudge the page so the next poll happens mid-boot again.
    await send(ws, 8, 'Page.reload', {}).catch(() => {})
  } catch {}
  try { ws.close() } catch {}
  await sleep(250)
}
console.log('boot variant not observed (it is sub-second on this machine)')
