/** 3-dot in isolation, plus the a11y and waveform claims. */
export default async function ({ evaluate, drainErrors }) {
  await new Promise((r) => setTimeout(r, 1500))
  const menu = () => evaluate(`(() => { const m=document.querySelector('[data-menu]'); return m ? 'OPEN ' + m.querySelectorAll('button').length + ' items' : 'CLOSED' })()`)

  console.log('start:', await menu())
  console.log('--- click the three dots on a closed menu ---')
  console.log(await evaluate(`
    (() => {
      const d = [...document.querySelectorAll('button')].find(b => /clip actions/i.test(b.getAttribute('aria-label') || ''))
      if (!d) return 'no dots button'
      d.click()
      return 'clicked'
    })()
  `))
  await new Promise(r => setTimeout(r, 700))
  console.log('after click:', await menu())

  console.log('--- a11y: rows and menus ---')
  console.log(await evaluate(`
    (() => {
      const row = document.querySelector('[role="button"][tabindex]')
      const m = document.querySelector('[data-menu]')
      return JSON.stringify({
        rowRole: !!row, rowTabbable: row ? row.getAttribute('tabindex') : null,
        menuRole: m ? m.getAttribute('role') : 'n/a',
        menuAria: m ? m.getAttribute('aria-label') : 'n/a',
      })
    })()
  `))

  console.log('--- waveform bar budget ---')
  console.log(await evaluate(`
    window.electronAPI ? 'bridge present' : 'no bridge'
  `))
  console.log('errors:', drainErrors())
}
