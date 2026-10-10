/** Minimal, fast confirmation that the dots still toggle the clip menu. */
export default async function ({ evaluate, drainErrors }) {
  await new Promise((r) => setTimeout(r, 1200))
  const state = () => evaluate(`(()=>document.querySelector('[data-menu]')?'OPEN':'CLOSED')()`)
  const dots = () => evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/clip actions/i.test(x.getAttribute('aria-label')||''));if(!b)return 'none';b.click();return 'click'})()`)
  console.log('baseline:', await state())
  for (let i = 1; i <= 3; i++) {
    const a = await dots()
    await new Promise(r => setTimeout(r, 900))
    console.log(`  ${i}: ${a} -> ${await state()}`)
  }
  console.log('errors:', drainErrors())
}
