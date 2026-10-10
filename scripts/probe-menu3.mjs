/** Clean-state check: dots open, menu is a real menu, dots toggle shut. */
export default async function ({ evaluate, drainErrors }) {
  await new Promise((r) => setTimeout(r, 1500))
  // Force a clean slate.
  await evaluate(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/clip actions/i.test(x.getAttribute('aria-label')||'')); if(b) b.click(); return 1 })()`)
  await new Promise(r => setTimeout(r, 500))

  const menu = () => evaluate(`(() => { const m=document.querySelector('[data-menu]'); return m ? 'OPEN' : 'CLOSED' })()`)
  console.log('baseline:', await menu())

  console.log(await evaluate(`
    (() => { const b=[...document.querySelectorAll('button')].find(x=>/clip actions/i.test(x.getAttribute('aria-label')||'')); b.click(); return 'clicked dots' })()
  `))
  await new Promise(r => setTimeout(r, 700))
  console.log('after dots:', await menu())
  console.log('semantics:', await evaluate(`
    (() => { const m=document.querySelector('[data-menu]'); if(!m) return 'n/a';
      const t=[...document.querySelectorAll('button')].find(x=>/clip actions/i.test(x.getAttribute('aria-label')||''))
      return JSON.stringify({ role:m.getAttribute('role'), label:m.getAttribute('aria-label'),
        haspopup:t?t.getAttribute('aria-haspopup'):null, expanded:t?t.getAttribute('aria-expanded'):null }) })()
  `))
  console.log(await evaluate(`
    (() => { const b=[...document.querySelectorAll('button')].find(x=>/clip actions/i.test(x.getAttribute('aria-label')||'')); b.click(); return 'clicked again' })()
  `))
  await new Promise(r => setTimeout(r, 600))
  console.log('after 2nd:', await menu())
  console.log('errors:', drainErrors())
}
