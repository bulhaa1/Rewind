/**
 * Four silent-failure paths that sit one layer below the interface.
 *
 * 1. `getTrackPeaks` spawned TWO ffmpeg processes per audio track. The first
 *    (`runFfmpeg`, output options before `-i`) was discarded with `void child`,
 *    never registered in `runningFfmpeg`, never killed when the editor closed,
 *    and its rejection unhandled. The observable is process count while the
 *    editor loads: one per track, not two.
 *
 * 2. `withStatus` broadcast `ready` from its `finally`, so a settings change
 *    that threw still left the panel claiming a live buffer.
 *
 * 3. `shell.openPath` returns an error string that five handlers discarded, so
 *    "Open folder" reported success with an unset path.
 *
 * 4. The editor window's backgroundColor was `#0a0a0a` against a canvas token
 *    of oklch(17%), a visible flash on open.
 *
 * Run against the app on --remote-debugging-port=9222.
 */

import fs from 'node:fs'
import path from 'node:path'

const results = []
function check(name, pass, detail = '') {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`)
}

async function connect(filter) {
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && (t.url || '').includes(filter))
  if (!page) return null
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
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
  return { send, close: () => ws.close() }
}

export default async function ({ evaluate }) {
  // ---- 1. one ffmpeg per audio track, not two ----
  /*
   * Must pick a clip that actually has several audio lanes. The duplicate spawn
   * happens once per lane, so a single-lane clip launches one process either way
   * and the check passes vacuously -- which it did on the first run.
   *
   * "Lanes" is what the editor renders, not file streams: `analyzeAudio` drops
   * stream 0 (the mix) when a clip is split, so a 3-stream file is 2 lanes and
   * spawns 2 peak decodes. Thresholded at 2+, which is what is needed to tell
   * "one per lane" apart from "two per lane".
   */
  const clips = JSON.parse(await evaluate(`window.electronAPI.getSavedClips().then(r => JSON.stringify(r.data.map(c => c.path)))`))

  const trackCount = async (file) => {
    try {
      return JSON.parse(
        await evaluate(
          `window.electronAPI.editorGetClipInfo(${JSON.stringify(file)}).then(i => JSON.stringify({ n: i.data?.audioTracks?.length ?? 0 }))`,
        ),
      ).n
    } catch {
      return 0
    }
  }

  let target = null
  let tracks = 0
  // Scan the whole library, not just the head: the list is newest-first and the
  // newest clips are single-lane recordings, so a short slice finds none.
  for (const p of clips) {
    const n = await trackCount(p)
    if (n >= 2) { target = p; tracks = n; break }
  }
  if (!target) {
    check('found a multi-lane clip to open in the editor', false, 'no clip with 2+ audio lanes in the library')
    console.log('\n0/2 checks passed')
    return
  }
  console.log(`using clip with ${tracks} audio lanes`)

  /*
   * Process-count sampling cannot see this defect. The discarded call passes
   * output options before `-i`, so ffmpeg rejects the arguments and exits
   * immediately -- it never coexists with the real process. Sampling 300 times
   * with no sleep still saw a peak of 1.
   *
   * What it leaves behind is louder: `runFfmpeg` rejects on a non-zero exit,
   * `void child` discards that promise, and `index.ts` has an
   * `unhandledRejection` handler that logs it. So the observable is an
   * "Unhandled rejection" in main.log during the peak load.
   */
  const logPath = path.join(process.env.APPDATA, 'Rewind', 'logs', 'main.log')
  const logSizeBefore = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0

  await evaluate(`window.electronAPI.openClipEditor(${JSON.stringify(target)}).catch(() => 0)`)
  for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 250))

  const tail = fs.existsSync(logPath)
    ? fs.readFileSync(logPath, 'utf8').slice(logSizeBefore)
    : ''
  const rejections = (tail.match(/Unhandled rejection/gi) || []).length
  const ffmpegErrors = (tail.match(/ffmpeg exited with code|Unrecognized|Invalid argument|Output file .* does not contain any stream/gi) || []).length

  console.log(`log tail: ${rejections} unhandled rejection(s), ${ffmpegErrors} ffmpeg error line(s)`)
  if (rejections) console.log('  first: ' + tail.split('\n').find((l) => /Unhandled rejection/i.test(l)))

  check(
    'loading peaks produces no unhandled ffmpeg rejection',
    rejections === 0,
    `${rejections} rejection(s)`,
  )
  check(
    'loading peaks produces no ffmpeg argument errors',
    ffmpegErrors === 0,
    `${ffmpegErrors} error line(s)`,
  )

  // ---- 2. the editor background matches the canvas token ----
  /*
   * The window background must MATCH the canvas token, not merely be a literal.
   * BrowserWindow needs a concrete colour before any CSS exists to read, so a
   * literal is correct here; what was wrong was the value. Rejecting all
   * literals would fail a correct fix.
   */
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'main', 'editor.ts'), 'utf8')
  const css = fs.readFileSync(path.join(process.cwd(), 'src', 'renderer', 'index.css'), 'utf8')

  const m = src.match(/backgroundColor:\s*['"]([^'"]+)['"]/i)
  const used = m ? m[1].toLowerCase() : null

  // oklch(17% 0.006 285) -> sRGB, computed rather than transcribed.
  const oklchToHex = (L, C, Hdeg) => {
    const h = (Hdeg * Math.PI) / 180
    const a = C * Math.cos(h)
    const b = C * Math.sin(h)
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b
    const s_ = L - 0.0894841775 * a - 1.291485548 * b
    const l = l_ ** 3, mm = m_ ** 3, s = s_ ** 3
    const enc = (x) => Math.round(Math.min(1, Math.max(0, x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055)) * 255)
    const to = (x) => enc(x).toString(16).padStart(2, '0')
    return '#' + to(4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s) +
      to(-1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s) +
      to(-0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s)
  }
  const token = /--color-canvas:\s*oklch\(([\d.]+)%\s+([\d.]+)\s+(\d+)\)/.exec(css)
  const expected = token ? oklchToHex(Number(token[1]) / 100, Number(token[2]), Number(token[3])) : null

  console.log(`editor background ${used}; --color-canvas resolves to ${expected}`)
  check(
    'the editor window background matches --color-canvas',
    !!used && !!expected && used === expected,
    `${used} vs ${expected}`,
  )

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
}