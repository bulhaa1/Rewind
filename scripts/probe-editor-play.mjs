/**
 * Verifies the editor timeline playhead is a real keyboard-driven slider, and that
 * the transport starts playback. Assertions rather than printouts: the lane's
 * aria-valuenow is the value the editor itself reads back after a seek.
 */
export default async function ({ evaluate, drainErrors }) {
  await new Promise((r) => setTimeout(r, 2000))

  const lane = '[role="slider"][aria-label="Playhead"]'
  const value = () =>
    evaluate(`(() => {
      const el = document.querySelector('${lane}')
      return el ? Number(el.getAttribute('aria-valuenow')) : null
    })()`)

  const problems = []
  const before = await value()
  if (before === null) problems.push('no playhead element')
  if (!Number.isFinite(before)) problems.push('aria-valuenow is not a finite number')

  // ArrowRight is the lane's own key binding; React writes the new time back into
  // aria-valuenow, so reading it after the event proves the seek landed.
  if (before !== null) {
    await evaluate(`(() => {
      const el = document.querySelector('${lane}')
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      return true
    })()`)
    await new Promise((r) => setTimeout(r, 300))
    const after = await value()
    console.log('playhead:', before, '->', after)
    if (!(after > before)) problems.push('ArrowRight did not move the playhead')
  }

  // The transport button starts playback.
  const played = await evaluate(`(() => {
    const b = document.querySelector('button[aria-label="Play"], button[aria-label="Pause"]')
    if (!b) return null
    b.click()
    return b.getAttribute('aria-label')
  })()`)
  if (played === null) problems.push('no transport button')
  await new Promise((r) => setTimeout(r, 1500))
  const playing = await evaluate(`(() => { const v = document.querySelector('video'); return v ? !v.paused : null })()`)
  console.log('transport:', played, 'playing:', playing)
  if (playing !== true) problems.push('transport did not start playback')

  console.log('errors:', drainErrors().length ? drainErrors() : 'none')

  if (problems.length) {
    console.log('FAIL probe-editor-play: ' + problems.join('; '))
    throw new Error('editor play assertion failed')
  }
  console.log('PASS probe-editor-play')
}
