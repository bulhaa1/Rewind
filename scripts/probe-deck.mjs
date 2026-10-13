/**
 * Deck behaviour: the dial toggles the buffer, the action rows drive the engine,
 * the limit chips change the rolling window, the record row reflects and changes
 * the engine's recording state. Screenshot dropped in %TEMP%.
 */
export default async function ({ evaluate, send }) {
  const call = (e) => evaluate(e)
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const click = (sel) =>
    call('(() => { const el = document.querySelector(' + JSON.stringify(sel) + '); if (!el) return "not-found"; el.click(); return "clicked" })()')
  const active = () => call('window.electronAPI.isReplayBufferActive().then((r) => r.data.active)')
  const duration = () => call('window.electronAPI.getBufferDuration().then((r) => r.data)')
  const clips = () => call('window.electronAPI.getSavedClips().then((r) => r.data.length)')
  const shots = () => call('window.electronAPI.getScreenshots().then((r) => r.data.length)')
  const recording = () =>
    call('window.electronAPI.getRecordingState().then((r) => (typeof r.data === "boolean" ? r.data : !!(r.data && r.data.recording)))')

  const shape = await call('({ dial: !!document.querySelector("[data-testid=\\"dial\\"]"), limit: !!document.querySelector("[data-testid=\\"buffer-limit\\"]"), rows: ["save-clip","record","screenshot"].every((t) => !!document.querySelector("[data-testid=\\"" + t + "\\"]")) })')
  const startActive = await active()
  const startDuration = await duration()
  const startClips = await clips()
  const startShots = await shots()
  console.log('start:', JSON.stringify(Object.assign({}, shape, { startActive: startActive, startDuration: startDuration, startClips: startClips, startShots: startShots })))

  const problems = []
  if (!shape.dial) problems.push('no dial')
  if (!shape.limit) problems.push('no buffer limit strip')
  if (!shape.rows) problems.push('missing an action row')

  // Dial toggles the buffer, then restores it.
  if ((await click('[data-testid="dial"]')) !== 'clicked') problems.push('dial not clickable')
  await wait(3500)
  const toggled = await active()
  if (toggled === startActive) problems.push('dial did not toggle the buffer')
  await click('[data-testid="dial"]')
  await wait(4500)
  const restored = await active()
  if (restored !== startActive && startActive) problems.push('buffer did not come back')

  // Limit chips change the rolling window, then restore it.
  const target = startDuration === 120 ? 60 : 120
  if ((await click('[data-testid="buffer-limit-' + target + '"]')) !== 'clicked') problems.push('limit chip not clickable')
  await wait(3000)
  const durationAfter = await duration()
  if (durationAfter !== target) problems.push('duration is ' + durationAfter + ', expected ' + target)
  await click('[data-testid="buffer-limit-' + startDuration + '"]')
  await wait(3000)
  const durationRestored = await duration()

  // Screenshot row
  if ((await click('[data-testid="screenshot"]')) !== 'clicked') problems.push('screenshot row not clickable')
  await wait(4000)
  const shotsAfter = await shots()
  if (!(shotsAfter > startShots)) problems.push('screenshots ' + startShots + ' -> ' + shotsAfter)

  // Save clip row
  if ((await click('[data-testid="save-clip"]')) !== 'clicked') problems.push('save clip row not clickable')
  await wait(6000)
  const clipsAfter = await clips()
  if (!(clipsAfter > startClips)) problems.push('clips ' + startClips + ' -> ' + clipsAfter)

  // Record row
  if ((await click('[data-testid="record"]')) !== 'clicked') problems.push('record row not clickable')
  await wait(5000)
  const rec1 = await recording()
  await click('[data-testid="record"]')
  await wait(5000)
  const rec2 = await recording()
  if (rec1 === rec2) problems.push('record row did not change recording state (' + rec1 + ' -> ' + rec2 + ')')

  try {
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(os.tmpdir(), 'rewind-deck.png'), Buffer.from(shot.data, 'base64'))
    console.log('screenshot: %TEMP%/rewind-deck.png')
  } catch (e) {
    console.log('screenshot failed:', e.message)
  }

  console.log(JSON.stringify({ toggled: toggled, restored: restored, durationAfter: durationAfter, durationRestored: durationRestored, shotsAfter: shotsAfter, clipsAfter: clipsAfter, rec1: rec1, rec2: rec2 }))
  if (problems.length) {
    console.log('FAIL probe-deck: ' + problems.join('; '))
    throw new Error('deck assertion failed')
  }
  console.log('PASS probe-deck')
}
