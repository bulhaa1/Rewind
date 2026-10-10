export default async function ({ evaluate, drainErrors }) {
  await new Promise((r) => setTimeout(r, 1500))
  const menu = () => evaluate(`(() => document.querySelector('[data-menu]') ? 'OPEN' : 'CLOSED')()`)
  const click = () => evaluate(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/clip actions/i.test(x.getAttribute('aria-label')||'')); if(!b) return 'no dots'; b.click(); return 'clicked' })()`)

  for (let i = 1; i <= 5; i++) {
    const before = await menu()
    const r = await click()
    await new Promise(x => setTimeout(x, 1500))
    const after = await menu()
    console.log(`cycle ${i}: ${r} | ${before} -> ${after}`)
  }
  console.log('errors:', drainErrors())
}
