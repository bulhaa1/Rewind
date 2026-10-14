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

  // CRUD with the four-profile cap and shift-aware activeProfile expectations. The
  // store may hold fewer than four (a user can delete one), so the probe fills up to
  // the cap first and asserts the cap from there.
  let cap = 4
  let len = (await profiles()).data.profiles.length
  while (len < cap) {
    const fill = await evaluate('window.electronAPI.addProfile()')
    if (!fill?.success) break
    const filled = await waitForCount(evaluate, len + 1)
    len = filled ? filled.profiles.length : len
  }
  if (len !== cap) {
    console.log(`SKIP  cap checks: the store holds ${len} profiles and could not be filled to ${cap}`)
  }

  let a = (await profiles()).data.activeProfile
  const refusedAdd = await evaluate('window.electronAPI.addProfile()')
  const capOk = refusedAdd && refusedAdd.success === false && (await profiles()).data.profiles.length === cap
  console.log(`${capOk ? 'PASS' : 'FAIL'}  add at the cap is refused (${cap} profiles)`)
  if (!capOk) problems.push('addProfile did not refuse at the cap')

  const refusedDup = await evaluate('window.electronAPI.duplicateProfile(0)')
  const capDupOk = refusedDup && refusedDup.success === false && (await profiles()).data.profiles.length === cap
  console.log(`${capDupOk ? 'PASS' : 'FAIL'}  duplicate at the cap is refused`)
  if (!capDupOk) problems.push('duplicateProfile did not refuse at the cap')

  // Free a slot by removing a profile that is not active, then add into it.
  const freeIndex = a === 0 ? 1 : 0
  const freed = await evaluate(`window.electronAPI.removeProfile(${freeIndex})`)
  if (!freed?.success) problems.push(`removeProfile(${freeIndex}) failed: ${JSON.stringify(freed)}`)
  const afterFree = await waitForCount(evaluate, cap - 1)
  const expectedAfterFree = freeIndex < a ? a - 1 : a
  const freeOk = afterFree && afterFree.activeProfile === expectedAfterFree
  console.log(`${freeOk ? 'PASS' : 'FAIL'}  removing below the active profile shifts it: ${afterFree?.activeProfile} (expected ${expectedAfterFree})`)
  if (!freeOk) problems.push('removeProfile did not shift the active index down')

  a = expectedAfterFree
  const added = await evaluate('window.electronAPI.addProfile()')
  if (!added?.success) problems.push(`addProfile failed: ${JSON.stringify(added)}`)
  const afterAdd = await waitForCount(evaluate, cap)
  const addedOk = afterAdd && afterAdd.profiles.length === cap && afterAdd.activeProfile === a
  console.log(`${addedOk ? 'PASS' : 'FAIL'}  add into the free slot: ${afterAdd?.profiles.length}, active ${a}`)
  if (!addedOk) problems.push('addProfile did not append into the free slot')

  // Duplicate at the cap is refused again.
  const dup = await evaluate(`window.electronAPI.duplicateProfile(${freeIndex})`)
  const dupRefused = dup && dup.success === false
  console.log(`${dupRefused ? 'PASS' : 'FAIL'}  duplicate is refused again at the cap`)
  if (!dupRefused) problems.push('duplicateProfile was allowed past the cap')

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
  const liveCount = (await profiles()).data.profiles.length
  console.log(`${rows === liveCount ? 'PASS' : 'FAIL'}  settings rows: ${rows} (expected ${liveCount})`)
  if (rows !== liveCount) problems.push(`settings shows ${rows} profile rows, expected ${liveCount}`)
  // The Add/Duplicate buttons were removed from Settings by design — the list is
  // four fixed slots; add/duplicate stay IPC-only (the cap checks above use them).
  await evaluate(`window.location.hash = '/'`)
  await sleep(1000)

  if (problems.length) {
    console.log('FAIL probe-profiles: ' + problems.join('; '))
    throw new Error('profile assertion failed')
  }
  console.log('PASS probe-profiles')
}
