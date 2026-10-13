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
  // Settings shows one section at a time; notifications live under System.
  await call('(() => { const nav = document.querySelector("[data-section=\\"system\\"]"); if (nav) nav.click(); return !!nav })()')
  await wait(1000)
  const found = await (async () => {
    for (let i = 0; i < 12; i++) {
      if (await call('!!document.querySelector("[aria-label=\\"Show notifications\\"]")')) return true
      await wait(400)
    }
    return false
  })()
  if (!found) {
    problems.push('notifications switch not found on the settings page')
  } else {
    const read = () => call('window.electronAPI.getNotificationsEnabled().then((r) => r.data)')
    const clickSwitch = () =>
      call('(() => { document.querySelector("[aria-label=\\"Show notifications\\"]").click(); return true })()')

    const before = await read()
    let after = before
    for (let i = 0; i < 3 && after === before; i++) {
      await clickSwitch()
      for (let j = 0; j < 6 && after === before; j++) {
        await wait(500)
        after = await read()
      }
    }
    if (after === before) problems.push('switch did not change the setting')

    let restored = after
    for (let i = 0; i < 3 && restored !== before; i++) {
      await clickSwitch()
      for (let j = 0; j < 6 && restored !== before; j++) {
        await wait(500)
        restored = await read()
      }
    }
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
