/**
 * Rail motion and hover scrub.
 *
 * React synthesises onPointerEnter/onPointerLeave from native pointerover /
 * pointerout, so the probe dispatches those. The new-card tag lasts a few
 * seconds and the scrub video needs to decode before it can seek, so both are
 * polled rather than sampled once.
 */
export default async function ({ evaluate }) {
  const call = (e) => evaluate(e)
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const poll = async (expr, timeoutMs) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await call(expr)) return true
      await wait(400)
    }
    return false
  }
  const problems = []

  const clipsBefore = await call('window.electronAPI.getSavedClips().then((r) => r.data.length)')
  await call('document.querySelector("[data-testid=\\"save-clip\\"]").click()')
  const tagged = await poll('!!document.querySelector("[data-new]")', 12000)
  const clipsAfter = await call('window.electronAPI.getSavedClips().then((r) => r.data.length)')
  console.log('save:', clipsBefore, '->', clipsAfter, 'tagged:', tagged)
  if (!(clipsAfter > clipsBefore)) problems.push('save did not add a clip')
  if (!tagged) problems.push('the newest card was never tagged as new')

  await call('(() => { const t = document.querySelector("[data-testid=\\"card-thumb\\"]"); t.dispatchEvent(new PointerEvent("pointerover", { bubbles: true })); return true })()')
  const layerUp = await poll('!!document.querySelector("[data-testid=\\"scrub-layer\\"]")', 4000)
  console.log('hover: layer', layerUp)
  if (!layerUp) problems.push('scrub layer did not mount on hover')

  const decoded = await poll('(() => { const v = document.querySelector("[data-testid=\\"scrub-layer\\"] video"); return !!(v && v.readyState >= 2) })()', 8000)
  if (!decoded) problems.push('scrub video never decoded')

  await call('(() => { const t = document.querySelector("[data-testid=\\"scrub-layer\\"]"); const r = t.getBoundingClientRect(); t.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: r.left + r.width * 0.7, clientY: r.top + r.height / 2 })); return true })()')
  await wait(800)
  const seeked = await call('(() => { const v = document.querySelector("[data-testid=\\"scrub-layer\\"] video"); return v ? { ready: v.readyState, duration: Math.round(v.duration * 100) / 100, t: Math.round(v.currentTime * 100) / 100, paused: v.paused } : null })()')
  console.log('scrub video:', JSON.stringify(seeked))
  if (!seeked || !(seeked.t > 0)) problems.push('the pointer move did not seek the video')
  if (seeked && seeked.t > 0 && seeked.duration > 0 && seeked.t > seeked.duration) problems.push('seek past the clip end')

  await call('(() => { const t = document.querySelector("[data-testid=\\"card-thumb\\"]"); t.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body })); return true })()')
  const layerDown = await poll('!document.querySelector("[data-testid=\\"scrub-layer\\"]")', 4000)
  if (!layerDown) problems.push('scrub layer stayed after the pointer left')

  if (problems.length) {
    console.log('FAIL probe-scrub: ' + problems.join('; '))
    throw new Error('scrub assertion failed')
  }
  console.log('PASS probe-scrub')
}

