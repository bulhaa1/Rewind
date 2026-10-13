/**
 * Profile switching probe.
 *
 * Fires the real global hotkey (Alt+4 by default) through Windows input, the way the
 * user does, and checks the active profile advances and wraps. Then checks the deck's
 * chips and the Settings rows agree with it.
 *
 * Run against a running app with a debugging port:
 *   node scripts/cdp.mjs scripts/probe-profiles.mjs
 */
import { spawnSync } from 'node:child_process'

/** Sends Alt+4 through Windows, which the app's low-level hook sees like any keypress. */
function pressNextProfile() {
  const r = spawnSync('powershell', [
    '-NoProfile',
    '-Command',
    'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("%4")',
  ])
  if (r.status !== 0) throw new Error('could not send the hotkey')
}

/** Brings the app to the front: SendKeys goes to the active window. */
function focusApp() {
  spawnSync('powershell', [
    '-NoProfile',
    '-Command',
    "$w = New-Object -ComObject WScript.Shell; $null = $w.AppActivate('Rewind')",
  ])
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export default async function ({ evaluate }) {
  const problems = []
  const profiles = () => evaluate('window.electronAPI.getProfiles()')

  const start = await profiles()
  if (!start?.success) {
    console.log('FAIL: getProfiles failed: ' + JSON.stringify(start))
    throw new Error('profiles unavailable')
  }
  const count = start.data.profiles.length
  console.log(`profiles: ${start.data.profiles.map((p) => p.name).join(', ')} (active ${start.data.activeProfile})`)

  /**
   * Presses the hotkey until the profile moves, or gives up.
   *
   * The first press after the app is brought to the front is consistently lost -- the
   * window is still coming forward when SendKeys fires -- so one press is retried
   * rather than reported as a dead hotkey. A hotkey that is genuinely not registered
   * fails both attempts.
   */
  const pressUntilMoved = async (before) => {
    const expected = (before + 1) % count
    for (let attempt = 0; attempt < 2; attempt++) {
      focusApp()
      await sleep(800)
      pressNextProfile()
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        await sleep(500)
        if ((await profiles()).data.activeProfile === expected) return expected
      }
    }
    return (await profiles()).data.activeProfile
  }

  // Four presses must come back to where it started, one step at a time.
  for (let i = 0; i < count; i++) {
    const before = (await profiles()).data.activeProfile
    const after = await pressUntilMoved(before)
    const expected = (before + 1) % count
    const ok = after === expected
    console.log(`${ok ? 'PASS' : 'FAIL'}  press ${i + 1}: active ${before} -> ${after} (expected ${expected})`)
    if (!ok) problems.push(`press ${i + 1} moved ${before} -> ${after}, expected ${expected}`)
  }

  const back = (await profiles()).data.activeProfile
  if (back !== start.data.activeProfile) problems.push(`cycling did not wrap: ${back} != ${start.data.activeProfile}`)

  // The deck must show the same thing the settings store says.
  const chips = await evaluate(`(() => {
    const nodes = [...document.querySelectorAll('[data-testid^="profile-chip-"]')]
    return { count: nodes.length, active: nodes.filter((n) => n.dataset.active === 'true').map((n) => n.dataset.testid) }
  })()`)
  console.log('deck chips:', JSON.stringify(chips))
  if (chips.count !== count) problems.push(`deck shows ${chips.count} chips, expected ${count}`)
  if (chips.active.length !== 1) problems.push(`deck highlights ${chips.active.length} chips, expected 1`)

  // Clicking a chip switches, the same way the hotkey does.
  const beforeClick = (await profiles()).data.activeProfile
  const target = (beforeClick + 1) % count
  const clicked = await evaluate(`(() => {
    const chip = document.querySelector('[data-testid="profile-chip-${target}"]')
    if (!chip) return 'missing'
    chip.click()
    return 'clicked'
  })()`)
  if (clicked !== 'clicked') problems.push(`chip ${target} could not be clicked (${clicked})`)
  let afterClick = beforeClick
  const clickDeadline = Date.now() + 20_000
  while (Date.now() < clickDeadline && afterClick !== target) {
    await sleep(500)
    afterClick = (await profiles()).data.activeProfile
  }
  console.log(`${afterClick === target ? 'PASS' : 'FAIL'}  chip click: active ${beforeClick} -> ${afterClick} (expected ${target})`)
  if (afterClick !== target) problems.push(`chip click moved ${beforeClick} -> ${afterClick}, expected ${target}`)

  // The Settings section renders a row per profile.
  await evaluate(`window.location.hash = '/settings'`)
  await sleep(2000)
  const opened = await evaluate(`(() => {
    const item = document.querySelector('[data-testid="settings-nav-profiles"]')
    if (!item) return 'no section'
    item.click()
    return 'clicked'
  })()`)
  if (opened !== 'clicked') problems.push(`settings has no Profiles section (${opened})`)
  await sleep(1500)
  const rows = await evaluate(
    `[...document.querySelectorAll('input[aria-label$="name"]')].filter((i) => i.getAttribute('aria-label').startsWith('Profile ')).length`,
  )
  console.log(`${rows === count ? 'PASS' : 'FAIL'}  settings rows: ${rows} (expected ${count})`)
  if (rows !== count) problems.push(`settings shows ${rows} profile rows, expected ${count}`)
  await evaluate(`window.location.hash = '/'`)
  await sleep(1000)

  if (problems.length) {
    console.log('FAIL probe-profiles: ' + problems.join('; '))
    throw new Error('profile assertion failed')
  }
  console.log('PASS probe-profiles')
}
