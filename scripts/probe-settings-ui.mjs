/**
 * Settings spine: every numbered section opens and shows its controls, Escape
 * returns to the panel, and the vitals strip reports the pipeline.
 */
export default async function ({ evaluate, send }) {
  const call = (e) => evaluate(e)
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const problems = []

  await call('window.location.hash = "/settings"')

  // Poll rather than assume: a probe run straight after another one can catch the
  // previous surface still unmounting.
  let spine = false
  for (let i = 0; i < 15 && !spine; i++) {
    await wait(400)
    spine = await call('!!document.querySelector("[data-testid=\\"settings-spine\\"]")')
  }
  const navIds = await call('[...document.querySelectorAll("[data-section]")].map((el) => el.getAttribute("data-section"))')
  console.log('spine:', spine, JSON.stringify(navIds))
  if (!spine) problems.push('no settings spine')
  const expected = ['capture', 'audio', 'encoder', 'replay', 'hotkeys', 'system']
  for (const id of expected) {
    if (!navIds.includes(id)) problems.push('spine is missing ' + id)
  }

  const titles = { capture: 'Display', audio: 'Audio', encoder: 'Quality', replay: 'Replays', hotkeys: 'Hotkeys', system: 'Notifications' }
  for (const id of expected) {
    await call('document.querySelector("[data-section=\\"' + id + '\\"]").click()')
    await wait(900)
    const shown = await call('(() => { const c = document.querySelector("[data-testid=\\"settings-content\\"]"); return c ? (c.textContent || "").includes(' + JSON.stringify(titles[id]) + ') : false })()')
    if (!shown) problems.push('section ' + id + ' did not render its controls')
  }

  // the vitals strip answers what the machine is set to do
  const vitals = await call('(() => { const f = document.querySelector("footer"); return f ? (f.textContent || "") : "" })()')
  console.log('vitals:', JSON.stringify(vitals))
  if (!/fps/.test(vitals)) problems.push('vitals strip does not report the frame rate')

  try {
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    fs.writeFileSync(path.join(os.tmpdir(), 'rewind-settings.png'), Buffer.from(shot.data, 'base64'))
    console.log('screenshot: %TEMP%/rewind-settings.png')
  } catch (e) {
    console.log('screenshot failed:', e.message)
  }

  await call('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))')
  await wait(1500)
  const backOnPanel = await call('!!document.querySelector("[data-testid=\\"rail-pane\\"]")')
  if (!backOnPanel) problems.push('Escape did not return to the panel')

  if (problems.length) {
    console.log('FAIL probe-settings-ui: ' + problems.join('; '))
    throw new Error('settings spine assertion failed')
  }
  console.log('PASS probe-settings-ui')
}
