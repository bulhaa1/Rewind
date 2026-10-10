/** Changes Frame Rate 30 -> 60 and verifies the round-trip end to end. */
export default async function ({ evaluate, drainErrors }) {
  await evaluate(`window.location.hash = '#/settings'`)
  await new Promise((r) => setTimeout(r, 1200))

  const clickByText = (text) => evaluate(`
    (() => {
      const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === ${JSON.stringify(text)})
      if (!b) return 'NOT FOUND: ' + ${JSON.stringify(text)}
      b.click()
      return 'clicked'
    })()
  `)

  console.log('fps select:', await clickByText('30 fps'))
  await new Promise((r) => setTimeout(r, 400))

  const menu = await evaluate(`
    [...document.querySelectorAll('button')].map(b => b.innerText.trim()).filter(t => /fps/.test(t))
  `)
  console.log('menu options:', JSON.stringify(menu))

  console.log('pick 60 fps:', await clickByText('60 fps'))

  // OBS restart takes a few seconds; wait, then read the control back.
  await new Promise((r) => setTimeout(r, 9000))

  const after = await evaluate(`
    [...document.querySelectorAll('button')].map(b => b.innerText.trim()).find(t => /fps/.test(t))
  `)
  console.log('fps control now reads:', after)

  const errs = drainErrors()
  console.log('renderer errors:', errs.length ? errs : 'none')
}