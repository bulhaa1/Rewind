/** Verifies the clip menu: right-click, three-dot, placement, and closing. */
export default async function ({ evaluate, drainErrors }) {
  await new Promise((r) => setTimeout(r, 2000))

  const menuState = () => evaluate(`
    (() => {
      const m = document.querySelector('[data-menu]')
      if (!m) return 'CLOSED'
      const r = m.getBoundingClientRect()
      const offscreen = r.top < 0 || r.left < 0 || r.bottom > innerHeight + 1 || r.right > innerWidth + 1
      return JSON.stringify({
        parent: m.parentElement.tagName,
        top: Math.round(r.top), left: Math.round(r.left),
        w: Math.round(r.width), h: Math.round(r.height),
        window: innerWidth + 'x' + innerHeight,
        offscreen,
        items: [...m.querySelectorAll('button')].map(b => b.textContent.trim()),
      })
    })()
  `)

  const openOn = (how) => evaluate(`
    (() => {
      const rows = [...document.querySelectorAll('.group')]
      if (!rows.length) return 'no rows'
      const row = rows[${how === 'last' ? 'rows.length - 1' : '0'}]
      if (${JSON.stringify(how)} === 'dots') {
        const d = [...row.querySelectorAll('button')].find(b => /actions/i.test(b.getAttribute('aria-label') || ''))
        if (!d) return 'no dots'
        d.click()
        return 'clicked dots'
      }
      const r = row.getBoundingClientRect()
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 10 }))
      return 'right-clicked row'
    })()
  `)

  console.log('--- right-click first row ---')
  console.log(await openOn('rightclick'))
  await new Promise((r) => setTimeout(r, 700))
  console.log(await menuState())

  console.log('--- close with Escape ---')
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await new Promise((r) => setTimeout(r, 400))
  console.log(await menuState())

  console.log('--- three-dot button ---')
  console.log(await openOn('dots'))
  await new Promise((r) => setTimeout(r, 700))
  console.log(await menuState())

  console.log('--- close with outside mousedown ---')
  await evaluate(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
  await new Promise((r) => setTimeout(r, 400))
  console.log(await menuState())

  console.log('--- right-click the LAST row (bottom edge) ---')
  console.log(await openOn('rightclick-last'))
  await new Promise((r) => setTimeout(r, 700))
  console.log(await menuState())

  console.log('--- scroll the list while open ---')
  await evaluate(`(() => { const s=[...document.querySelectorAll('div')].find(d=>d.scrollHeight>d.clientHeight+10); if(s) s.scrollTop += 60; return !!s })()`)
  await new Promise((r) => setTimeout(r, 500))
  console.log(await menuState())

  console.log('errors:', drainErrors())
}
