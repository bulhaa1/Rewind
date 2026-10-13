/**
 * Primitives swap: the settings Switch and the Dialog must still behave through
 * the UI, now that both are Base UI underneath.
 */
export default async function ({ evaluate }) {
  const call = (e) => evaluate(e)
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const problems = []

  // --- Switch: toggle notifications from the settings page, then restore
  await call('window.location.hash = "/settings"')
  await wait(2000)
  const found = await call('(() => { const el = document.querySelector("[aria-label=\\"Show notifications\\"]"); return !!el })()')
  if (!found) {
    problems.push('notifications switch not found on the settings page')
  } else {
    const before = await call('window.electronAPI.getNotificationsEnabled().then((r) => r.data)')
    await call('(() => { document.querySelector("[aria-label=\\"Show notifications\\"]").click(); return true })()')
    await wait(1200)
    const after = await call('window.electronAPI.getNotificationsEnabled().then((r) => r.data)')
    if (after === before) problems.push('switch did not change the setting')
    await call('(() => { document.querySelector("[aria-label=\\"Show notifications\\"]").click(); return true })()')
    await wait(1200)
    const restored = await call('window.electronAPI.getNotificationsEnabled().then((r) => r.data)')
    if (restored !== before) problems.push('switch did not restore the setting')
    console.log('switch:', JSON.stringify({ before, after, restored }))
  }

  // --- Dialog: open the hotkey dialog from a chip in the deck, Escape to close
  await call('window.location.hash = "/"')
  await wait(2000)
  const chip = await call('(() => { const b = [...document.querySelectorAll("button")].find((x) => /alt/i.test(x.textContent || "") && !x.dataset.testid); if (!b) return "not-found"; b.click(); return "clicked" })()')
  await wait(1200)
  const dialogOpen = await call('!!document.querySelector("[role=\\"dialog\\"]")')
  if (chip !== 'clicked') problems.push('no hotkey chip found to open a dialog')
  else if (!dialogOpen) problems.push('dialog did not open')
  await call('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))')
  await wait(1200)
  const dialogClosed = await call('!document.querySelector("[role=\\"dialog\\"]")')
  if (chip === 'clicked' && !dialogClosed) problems.push('dialog did not close on Escape')
  console.log('dialog:', JSON.stringify({ chip, dialogOpen, dialogClosed }))

  if (problems.length) {
    console.log('FAIL probe-primitives: ' + problems.join('; '))
    throw new Error('primitives assertion failed')
  }
  console.log('PASS probe-primitives')
}
