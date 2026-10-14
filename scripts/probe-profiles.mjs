/**
 * Profile CRUD and switching probe.
 *
 * Checks the deck's chips and the Settings rows agree with the store, that a chip
 * click switches, and that the CRUD paths (add, duplicate, remove, save current)
 * behave — including the two refusals: removing the active profile and removing
 * the last one.
 *
 * Run against a running app with a debugging port:
 *   node scripts/cdp.mjs scripts/probe-profiles.mjs
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Waits until the store reports `count` profiles, so a CRUD round trip has landed. */
async function waitForCount(evaluate, count) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const res = await evaluate('window.electronAPI.getProfiles()')
    if (res?.success && res.data.profiles.length === count) return res.data
    await sleep(400)
  }
  return null
}

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

  // The deck must show the same thing the settings store says.
  const chips = await evaluate(`(() => {
    const nodes = [...document.querySelectorAll('[data-testid^="profile-chip-"]')]
    return { count: nodes.length, active: nodes.filter((n) => n.dataset.active === 'true').map((n) => n.dataset.testid) }
  })()`)
  console.log('deck chips:', JSON.stringify(chips))
  if (chips.count !== count) problems.push(`deck shows ${chips.count} chips, expected ${count}`)
  if (chips.active.length !== 1) problems.push(`deck highlights ${chips.active.length} chips, expected 1`)

  // Clicking a chip switches.
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

  // CRUD with shift-aware activeProfile expectations:
  // duplicating at index 0 inserts at 1, shifting the active index up when it was >= 1;
  // removing at index 1 shifts it back down when it was > 1. Appending never shifts.
  let a = (await profiles()).data.activeProfile
  const added = await evaluate('window.electronAPI.addProfile()')
  if (!added?.success) problems.push(`addProfile failed: ${JSON.stringify(added)}`)
  const afterAdd = await waitForCount(evaluate, count + 1)
  const addedOk = afterAdd && afterAdd.profiles.length === count + 1 && afterAdd.activeProfile === a
  console.log(`${addedOk ? 'PASS' : 'FAIL'}  add profile: ${count} -> ${afterAdd?.profiles.length}, active ${a}`)
  if (!addedOk) problems.push('addProfile did not append one inactive profile')

  const source = afterAdd.profiles[0]
  const dup = await evaluate('window.electronAPI.duplicateProfile(0)')
  if (!dup?.success) problems.push(`duplicateProfile failed: ${JSON.stringify(dup)}`)
  const expectedActiveAfterDup = a >= 1 ? a + 1 : a
  const afterDup = await waitForCount(evaluate, count + 2)
  const copy = afterDup?.profiles[1]
  const dupOk =
    copy &&
    copy.name === `${source.name} copy` &&
    copy.fps === source.fps &&
    copy.bufferDuration === source.bufferDuration &&
    afterDup.activeProfile === expectedActiveAfterDup
  console.log(
    `${dupOk ? 'PASS' : 'FAIL'}  duplicate profile 0: ${copy ? copy.name : 'none'}, active ${afterDup?.activeProfile} (expected ${expectedActiveAfterDup})`,
  )
  if (!dupOk) problems.push('duplicateProfile did not insert a values copy with the active index shifted')

  // Remove the active profile is refused; the store is untouched.
  const activeIndex = (await profiles()).data.activeProfile
  const refused = await evaluate(`window.electronAPI.removeProfile(${activeIndex})`)
  const refusedOk = refused && refused.success === false && (await profiles()).data.profiles.length === count + 2
  console.log(`${refusedOk ? 'PASS' : 'FAIL'}  removing the active profile is refused`)
  if (!refusedOk) problems.push('removeProfile did not refuse the active profile')

  // Remove the copy, then the added profile, back to where it started.
  const removedCopy = await evaluate('window.electronAPI.removeProfile(1)')
  if (!removedCopy?.success) problems.push(`removeProfile(1) failed: ${JSON.stringify(removedCopy)}`)
  const expectedActiveAfterRemove = expectedActiveAfterDup > 1 ? expectedActiveAfterDup - 1 : expectedActiveAfterDup
  const backOne = await waitForCount(evaluate, count + 1)
  const shiftOk = backOne && backOne.activeProfile === expectedActiveAfterRemove
  console.log(
    `${shiftOk ? 'PASS' : 'FAIL'}  removing above the active profile shifts it: ${backOne?.activeProfile} (expected ${expectedActiveAfterRemove})`,
  )
  if (!shiftOk) problems.push('removeProfile did not shift the active index down')

  const removedAdded = await evaluate(`window.electronAPI.removeProfile(${count})`)
  if (!removedAdded?.success) problems.push(`removeProfile(${count}) failed: ${JSON.stringify(removedAdded)}`)
  const restored = await waitForCount(evaluate, count)
  const restoredOk = restored && restored.profiles.length === count && restored.activeProfile === expectedActiveAfterRemove
  console.log(`${restoredOk ? 'PASS' : 'FAIL'}  removals restore the original list`)
  if (!restoredOk) problems.push('removals did not restore the original list')

  // Save current settings: the active profile then carries the live values.
  const liveFps = await evaluate('window.electronAPI.getFps()')
  const liveQuality = await evaluate('window.electronAPI.getVisualQuality()')
  const saved = await evaluate('window.electronAPI.saveActiveProfile()')
  if (!saved?.success) problems.push(`saveActiveProfile failed: ${JSON.stringify(saved)}`)
  const active = saved?.data?.profiles[saved.data.activeProfile]
  const savedOk =
    active && liveFps?.data !== undefined && active.fps === liveFps.data && active.visualQuality === liveQuality.data
  console.log(
    `${savedOk ? 'PASS' : 'FAIL'}  save current settings: profile ${active?.fps}/${active?.visualQuality} vs live ${liveFps?.data}/${liveQuality?.data}`,
  )
  if (!savedOk) problems.push('saveActiveProfile did not copy the live values into the active profile')

  // The Settings section renders a row per profile, plus the add button.
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
  const addButton = await evaluate(`!!document.querySelector('[data-testid="profile-add"]')`)
  console.log(`${addButton ? 'PASS' : 'FAIL'}  settings has an Add profile button`)
  if (!addButton) problems.push('settings has no Add profile button')
  await evaluate(`window.location.hash = '/'`)
  await sleep(1000)

  if (problems.length) {
    console.log('FAIL probe-profiles: ' + problems.join('; '))
    throw new Error('profile assertion failed')
  }
  console.log('PASS probe-profiles')
}
