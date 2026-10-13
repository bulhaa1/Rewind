/**
 * Puts the main window back on the capture panel and closes anything a previous
 * probe left open. Run it between probe runs when a view has been changed: the
 * probes share one live window and the settings view has no deck.
 */
export default async function ({ evaluate }) {
  const call = (e) => evaluate(e)
  await call(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`)
  await call(`window.location.hash = '/'; true`)
  await new Promise((r) => setTimeout(r, 2500))
  const onPanel = await call(`!!document.querySelector('[data-testid="dial"]')`)
  console.log('panel restored:', onPanel)
  if (!onPanel) throw new Error('did not get back to the capture panel')
  console.log('PASS probe-reset')
}
