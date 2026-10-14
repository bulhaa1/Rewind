/** Inspects the editor window: does it render, and can it save a trimmed copy? */
export default async function ({ evaluate, drainErrors, url }) {
  console.log('attached to:', (url || '').slice(0, 80))

  await new Promise((r) => setTimeout(r, 2500))

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

  console.log('renderer errors:', drainErrors().length ? drainErrors() : 'none')
}