/**
 * The deck's custom buffer limit and the quick-clip control: each must change the
 * stored setting and restore it.
 */
export default async function ({ evaluate }) {
  const call = (e) => evaluate(e)
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const problems = []

  const duration = () => call('window.electronAPI.getBufferDuration().then((r) => r.data)')
  const quick = () => call('window.electronAPI.getQuickClipSeconds().then((r) => r.data)')

  const typeLimit = (value) =>
    call(
      "(() => { const el = document.querySelector('[data-testid=\"buffer-limit-custom\"]'); if (!el) return 'not-found'; el.focus(); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(el, '" +
        value +
        "'); el.dispatchEvent(new Event('input', { bubbles: true })); el.blur(); return 'typed' })()",
    )

  const openQuick = () =>
    call(
      "(() => { const b = [...document.querySelectorAll('button')].find((x) => /seconds|minute/i.test(x.title || '')); if (!b) return 'not-found'; b.click(); return 'clicked' })()",
    )

  const pickQuick = (label) =>
    call(
      "(() => { const item = [...document.querySelectorAll('[role=\"menuitem\"]')].find((el) => ((el.textContent || '').trim().indexOf('" +
        label +
        "') === 0)); if (!item) return 'not-found'; item.click(); return 'clicked' })()",
    )

  const startDuration = await duration()
  const startQuick = await quick()
  const hasCustom = await call('!!document.querySelector("[data-testid=\\"buffer-limit-custom\\"]")')
  const hasQuick = await call(
    "[...document.querySelectorAll('button')].some((b) => /seconds|minute/i.test(b.title || ''))",
  )
  console.log('controls:', JSON.stringify({ hasCustom, hasQuick, startDuration, startQuick }))
  if (!hasCustom) problems.push('no custom buffer limit field')
  if (!hasQuick) problems.push('no quick-clip control')

  // Custom limit: type a value the presets do not cover, then restore.
  const target = startDuration === 75 ? 90 : 75
  const typed = await typeLimit(target)
  await wait(3000)
  const afterCustom = await duration()
  console.log('custom limit:', startDuration, '->', afterCustom, '(', typed, ', target', target + ')')
  if (afterCustom !== target) problems.push('custom limit did not apply (' + afterCustom + ')')

  await typeLimit(startDuration)
  await wait(3000)
  const restoredDuration = await duration()
  if (restoredDuration !== startDuration) problems.push('custom limit did not restore (' + restoredDuration + ')')

  // Quick clip: open the select and choose a different length, then restore.
  const chosen = startQuick === 45 ? 60 : 45
  await openQuick()
  await wait(1200)
  const picked = await pickQuick(chosen + ' seconds')
  await wait(2500)
  const afterQuick = await quick()
  console.log('quick clip:', startQuick, '->', afterQuick, '(', picked, ', target', chosen + ')')
  if (picked !== 'clicked' || afterQuick !== chosen) problems.push('quick-clip length did not change')

  await openQuick()
  await wait(1200)
  await pickQuick(startQuick === 120 ? '2 minutes' : startQuick === 300 ? '5 minutes' : startQuick + ' seconds')
  await wait(2500)
  const restoredQuick = await quick()
  if (restoredQuick !== startQuick) problems.push('quick-clip length did not restore (' + restoredQuick + ')')

  if (problems.length) {
    console.log('FAIL probe-limits: ' + problems.join('; '))
    throw new Error('limits assertion failed')
  }
  console.log('PASS probe-limits')
}
