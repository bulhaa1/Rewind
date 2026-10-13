/**
 * Smoke test for the moved capture wiring: stop/start the buffer and save a clip
 * by clicking the panel, asserting against the engine's own answers.
 */
export default async function ({ evaluate }) {
  const call = (expr) => evaluate(expr)
  const clickByText = (needle) =>
    call('(() => { const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim().toLowerCase().includes(' + JSON.stringify(needle.toLowerCase()) + ')); if (!b) return "not-found"; b.click(); return "clicked" })()')
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))

  const before = await call('window.electronAPI.isReplayBufferActive().then((r) => r.data.active)')
  const stopClick = await clickByText('stop')
  await wait(3000)
  const afterStop = await call('window.electronAPI.isReplayBufferActive().then((r) => r.data.active)')
  const startClick = await clickByText('start')
  await wait(4000)
  const afterStart = await call('window.electronAPI.isReplayBufferActive().then((r) => r.data.active)')

  const clipsBefore = await call('window.electronAPI.getSavedClips().then((r) => r.data.length)')
  const saveClick = await clickByText('save clip')
  await wait(6000)
  const clipsAfter = await call('window.electronAPI.getSavedClips().then((r) => r.data.length)')

  console.log(JSON.stringify({ before, afterStop, afterStart, clipsBefore, clipsAfter, stopClick, startClick, saveClick }))

  const problems = []
  if (stopClick !== 'clicked') problems.push('stop button not found')
  if (afterStop !== false) problems.push('buffer did not stop from the UI')
  if (startClick !== 'clicked') problems.push('start button not found')
  if (afterStart !== true) problems.push('buffer did not start from the UI')
  if (saveClick !== 'clicked') problems.push('save clip button not found')
  if (!(clipsAfter > clipsBefore)) problems.push('clip count did not grow: ' + clipsBefore + ' -> ' + clipsAfter)

  if (problems.length) {
    console.log('FAIL probe-panel-smoke: ' + problems.join('; '))
    throw new Error('panel smoke failed')
  }
  console.log('PASS probe-panel-smoke')
}
