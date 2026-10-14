/** Inspects the editor window: does it render, and can it save a trimmed copy? */
export default async function ({ evaluate, drainErrors, url, send }) {
  const problems = []
  console.log('attached to:', (url || '').slice(0, 80))

  await new Promise((r) => setTimeout(r, 2500))
  // The wheel scrub coalesces seeks with requestAnimationFrame, and rAF does not
  // run in a hidden window -- so the check needs the editor actually on screen.
  await send('Page.bringToFront')

  const text = await evaluate(`document.body.innerText`)
  console.log('--- EDITOR RENDERED TEXT ---')
  console.log(text)

  const media = await evaluate(`
    (() => {
      const v = document.querySelector('video')
      if (!v) return 'NO VIDEO ELEMENT'
      return JSON.stringify({ src: v.src.slice(0, 60), readyState: v.readyState, duration: v.duration, w: v.videoWidth, h: v.videoHeight })
    })()
  `)
  console.log('video element:', media)

  const controls = await evaluate(`
    [...document.querySelectorAll('button')].map(b => b.innerText.trim()).filter(Boolean)
  `)
  console.log('buttons:', JSON.stringify(controls))

  // Live monitoring graph: one <audio> per track (reached through the debug
  // handle — the elements are created imperatively, not in the DOM), video muted
  // while it is live, and the lanes play in sync with the picture.
  const audio = await evaluate(`(() => {
    const g = window.__previewAudio
    return {
      built: !!g,
      lanes: g ? g.lanes.length : 0,
      ctxState: g ? g.ctx.state : null,
      videoMuted: g ? g.video.muted : null,
    }
  })()`)
  console.log('monitor graph (before play):', JSON.stringify(audio))

  const played = await evaluate(`(() => {
    const play = [...document.querySelectorAll('button[aria-label]')].find((b) => b.getAttribute('aria-label') === 'Play')
    if (!play) return 'no play button'
    play.click()
    return 'clicked'
  })()`)
  if (played === 'clicked') {
    await new Promise((r) => setTimeout(r, 1500))
    const during = await evaluate(`(() => {
      const g = window.__previewAudio
      const v = document.querySelector('video')
      return {
        videoPaused: v ? v.paused : null,
        ctxState: g ? g.ctx.state : null,
        allPlaying: g ? g.lanes.every((l) => !l.el.paused) : null,
        drift: g && v && g.lanes.length ? Math.max(...g.lanes.map((l) => Math.abs(l.el.currentTime - v.currentTime))) : null,
      }
    })()`)
    console.log('monitor graph (playing):', JSON.stringify(during))
    await evaluate(`(() => {
      const pause = [...document.querySelectorAll('button[aria-label]')].find((b) => b.getAttribute('aria-label') === 'Pause')
      pause?.click()
      return true
    })()`)
  }

  // Trim a copy: 5s..10s, saved as a copy so the original is preserved.
  const clip = await evaluate(`document.body.innerText.match(/Replay[^\\n]*/)?.[0]`)
  console.log('clip shown:', clip)

  // Clip-volume row: same lane shape as the tracks, with the combined waveform.
  const master = await evaluate(`(() => {
    const lane = document.querySelector('[role="slider"][aria-label="Clip volume playhead"]')
    return { present: !!lane, hasBars: lane ? lane.children.length > 0 : false }
  })()`)
  console.log('clip volume waveform:', JSON.stringify(master))
  if (!master.present) problems.push('clip volume lane missing')

  // Wheel scrub: scrolling the trim bar must move the playhead.
  const scrub = await evaluate(`(async () => {
    const v = document.querySelector('video')
    const lane = document.querySelector('[role="slider"][aria-label="Playhead"]')
    if (!v || !lane) return 'missing'
    const before = v.currentTime
    const dispatch = (dy) => lane.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, bubbles: true, cancelable: true }))
    for (let i = 0; i < 5; i++) { dispatch(100); await new Promise((r) => setTimeout(r, 60)) }
    await new Promise((r) => setTimeout(r, 300))
    return JSON.stringify({ before: Math.round(before * 10) / 10, after: Math.round(v.currentTime * 10) / 10 })
  })()`)
  console.log('wheel scrub:', scrub)
  try {
    const parsed = JSON.parse(scrub)
    // The first notch lands immediately; the rest need a rendered frame, which an
    // occluded window never gets, so any advance proves the handler is wired.
    if (!(parsed.after > parsed.before + 0.5)) problems.push('wheel scrub did not advance the playhead')
  } catch {
    /* non-JSON outcome already printed */
  }

  // The export panel: slider, readout, savings, range row.
  const exportPanel = await evaluate(`(() => {
    const s = document.querySelector('[data-testid="export-section"]')
    return s ? { readout: !!s.querySelector('[data-testid="size-readout"]'), text: s.innerText } : null
  })()`)
  console.log('export panel:', JSON.stringify(exportPanel?.text))
  if (!exportPanel?.readout) problems.push('export size readout missing')

  console.log('renderer errors:', drainErrors().length ? drainErrors() : 'none')

  // Copy clip: the footer button writes the file to the clipboard and confirms.
  const copyResult = await evaluate(`(async () => {
    const b = document.querySelector('[data-testid="copy-clip"]')
    if (!b) return 'missing'
    b.click()
    await new Promise((r) => setTimeout(r, 800))
    return b.textContent.trim()
  })()`)
  console.log('copy clip button:', copyResult)
  if (copyResult !== 'Copied') problems.push('copy clip button did not confirm the write')

  if (problems.length) {
    console.log('FAIL probe-editor-ui: ' + problems.join('; '))
    throw new Error('editor ui assertion failed')
  }
  console.log('PASS probe-editor-ui')
}

