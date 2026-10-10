/**
 * Drives two settings changes through the real UI controls, back to back.
 *
 * Both go through runAction, which drops overlapping mutations. The point is to see
 * whether the second change is discarded while its control still shows it applied.
 */
export default async function ({ evaluate, drainErrors }) {
  await new Promise((r) => setTimeout(r, 1000))

  const engine = () => evaluate(`window.electronAPI.getVideoEncoder().then(r => r.data)`)
  const quality = () => evaluate(`window.electronAPI.getVisualQuality().then(r => r.data)`)

  console.log('start encoder:', await engine(), ' quality:', await quality())

  await evaluate(`window.location.hash = '/settings'`)
  await new Promise((r) => setTimeout(r, 2500))

  // The encoder control is the select whose title matches the current encoder.
  const pick = (label) => evaluate(`
    (() => {
      const rows = [...document.querySelectorAll('button')]
      const trigger = rows.find(b => b.className.includes('justify-between') && /nvenc|x264|auto/i.test(b.title || ''))
      if (!trigger) return 'no encoder control'
      trigger.click()
      return 'opened'
    })()
  `)

  const choose = (want) => evaluate(`
    (() => {
      const item = [...document.querySelectorAll('[data-menu] button')].find(b => b.textContent.trim().toLowerCase() === ${JSON.stringify(want)})
      if (!item) return 'no option ' + ${JSON.stringify(want)} + ' in ' + [...document.querySelectorAll('[data-menu] button')].map(b=>b.textContent.trim()).join(',')
      item.click()
      return 'chose ' + ${JSON.stringify(want)}
    })()
  `)

  console.log(await pick())
  // Two clicks in the same tick: the second lands while the first is still in flight.
  const r = await evaluate(`
    (async () => {
      const out = []
      for (const want of ['x264', 'nvenc']) {
        const trig = [...document.querySelectorAll('button')].find(b => b.className.includes('justify-between') && /nvenc|x264|auto/i.test(b.title || ''))
        if (!trig) { out.push('no control'); continue }
        trig.click()
        await new Promise(r => setTimeout(r, 40))
        const item = [...document.querySelectorAll('[data-menu] button')].find(b => b.textContent.trim().toLowerCase() === want)
        if (!item) { out.push('no option ' + want); continue }
        item.click()
        out.push('chose ' + want)
      }
      return JSON.stringify(out)
    })()
  `)
  console.log('clicks:', r)

  await new Promise((r) => setTimeout(r, 8000))
  console.log('UI shows encoder:', await evaluate(`
    (() => { const b=[...document.querySelectorAll('button')].find(b=>b.className.includes('justify-between')&&/nvenc|x264|auto/i.test(b.title||'')); return b ? b.title : '?' })()
  `))
  console.log('ENGINE encoder :', await engine())
  const match = await evaluate(`(async()=>{const u=document.querySelector('button[title]');return 0})()`)
  console.log('errors:', drainErrors())
}
