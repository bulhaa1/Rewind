/** Checks real keyboard dismissal: is focus in the menu, and does Escape close it? */
export default async function ({ evaluate, drainErrors }) {
  await new Promise((r) => setTimeout(r, 1500))

  const open = () => evaluate(`
    (() => {
      const rows = [...document.querySelectorAll('[role="button"]')]
      const row = rows.find(r => /Replay|Recording|Screenshot/i.test(r.textContent))
      if (!row) return 'no row'
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
      return 'opened'
    })()
  `)
  const menu = () => evaluate(`(() => { const m=document.querySelector('[data-menu]'); return m ? m.querySelectorAll('button').length + ' items' : 'CLOSED' })()`)
  const focus = () => evaluate(`
    (() => { const a = document.activeElement; return a ? (a.tagName + ':' + (a.textContent||'').trim().slice(0,18) + ':inMenu=' + !!a.closest('[data-menu]')) : 'none' })()
  `)

  console.log(await open())
  await new Promise(r => setTimeout(r, 700))
  console.log('menu    :', await menu())
  console.log('focus   :', await focus())

  // A real key event lands on the focused element, so dispatch it there.
  console.log('--- real Escape on the focused element ---')
  console.log(await evaluate(`
    (() => {
      const a = document.activeElement || document.body
      const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      a.dispatchEvent(ev)
      return 'sent to ' + a.tagName + ' (defaultPrevented=' + ev.defaultPrevented + ')'
    })()
  `))
  await new Promise(r => setTimeout(r, 600))
  console.log('menu    :', await menu())
  console.log('focus   :', await focus())

  console.log('errors:', drainErrors())
}
