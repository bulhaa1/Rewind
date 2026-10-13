/**
 * CDP driver for manual UI verification.
 *
 * Attaches to the running app over the DevTools protocol and evaluates expressions
 * in the renderer, so UI behaviour can be checked without a display-driver.
 *
 * Usage: node scripts/cdp.mjs <script.js>
 */
import fs from 'node:fs'

const PORT = process.env.CDP_PORT || '9222'

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  return res.json()
}

export async function connect(urlIncludes) {
  const list = await targets()
  const candidates = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  // Without a filter prefer the main panel; the editor is a second window, and the
  // notification popup is a third. A popup that is still closing would otherwise be
  // picked, and its window can close mid-evaluate, leaving the probe hung on a
  // promise that never settles.
  const page =
    (urlIncludes
      ? candidates.find((t) => (t.url || '').includes(urlIncludes))
      : candidates.find(
          (t) => !(t.url || '').includes('editor=1') && !(t.url || '').includes('notification='),
        )) ?? candidates[0]
  if (!page) throw new Error('No debuggable page found')

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()

  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })

  const events = []
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.method) {
      events.push(msg)
      return
    }
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

  await send('Runtime.enable')
  await send('Log.enable')

  /** Evaluates an expression and returns its (JSON-serializable) value. */
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || 'eval failed')
    }
    return r.result.value
  }

  /** Errors the renderer raised since the connection opened. */
  const drainErrors = () => {
    const out = []
    for (const e of events) {
      if (e.method === 'Runtime.exceptionThrown') {
        out.push(`EXCEPTION: ${(e.params.exceptionDetails?.exception?.description || '').split('\n')[0]}`)
      } else if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') {
        out.push(`LOG-ERROR: ${e.params.entry.text}`)
      } else if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') {
        out.push(`CONSOLE-ERROR: ${e.params.args.map((a) => a.description || a.value).join(' ').split('\n')[0]}`)
      }
    }
    events.length = 0
    return out
  }

  return { send, evaluate, drainErrors, close: () => ws.close(), url: page.url }
}

const scriptPath = process.argv[2]
const targetFilter = process.argv[3]
if (scriptPath) {
  const mod = await import(`file://${process.cwd()}\\${scriptPath}`)
  const cdp = await connect(targetFilter)
  await mod.default(cdp)
  cdp.close()
}