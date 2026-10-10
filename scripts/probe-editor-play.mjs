/** Verifies the editor transport actually moves the video and drives playback. */
export default async function ({ evaluate, drainErrors }) {
  await new Promise((r) => setTimeout(r, 2000))

  const state = () => evaluate(`
    (() => {
      const v = document.querySelector('video')
      if (!v) return 'NO VIDEO'
      return JSON.stringify({ t: +v.currentTime.toFixed(2), paused: v.paused, dur: +(v.duration||0).toFixed(2) })
    })()
  `)

  console.log('initial:', await state())

  // Click the middle of the timeline lane - should seek the video.
  const seeked = await evaluate(`
    (() => {
      const lane = document.querySelector('[role="slider"][aria-label="Trim range"]')
      if (!lane) return 'NO TIMELINE'
      const r = lane.getBoundingClientRect()
      lane.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + r.width * 0.5, clientY: r.top + r.height / 2 }))
      return 'clicked midpoint'
    })()
  `)
  console.log('timeline click:', seeked)
  await new Promise((r) => setTimeout(r, 800))
  console.log('after seek:', await state())

  // Press the transport button - should start playback.
  const played = await evaluate(`
    (() => {
      const b = document.querySelector('button[aria-label="Play"], button[aria-label="Pause"]')
      if (!b) return 'NO TRANSPORT BUTTON'
      b.click()
      return 'clicked ' + b.getAttribute('aria-label')
    })()
  `)
  console.log('transport:', played)
  await new Promise((r) => setTimeout(r, 2000))
  console.log('after play:', await state())

  const text = await evaluate(`document.body.innerText`)
  console.log('--- TEXT ---')
  console.log(text.split('\n').filter(l => /Trim|:/.test(l)).join('\n'))

  console.log('errors:', drainErrors().length ? drainErrors() : 'none')
}