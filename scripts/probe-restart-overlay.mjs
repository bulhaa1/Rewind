export default async function ({ evaluate, drainErrors }) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const overlay = () => evaluate(`
    (() => {
      const o = document.querySelector('[role="alertdialog"]')
      if (!o) return 'ABSENT'
      const r = o.getBoundingClientRect()
      const centre = document.elementFromPoint(innerWidth/2, innerHeight/2)
      return JSON.stringify({
        coversAll: Math.round(r.width) >= innerWidth - 1 && Math.round(r.height) >= innerHeight - 1,
        z: getComputedStyle(o).zIndex,
        copy: [...o.querySelectorAll('p')].map(p => p.textContent.trim()),
        centreHit: centre && centre.closest('[role="alertdialog"]') ? 'input blocked' : 'LEAKED',
      })
    })()
  `)
  const status = () => evaluate(`window.electronAPI.getStatus().then(r => r.data.status)`)
  const fps = () => evaluate(`window.electronAPI.getFps().then(r => r.data)`)

  await sleep(2000)
  await evaluate(`window.location.hash = '/settings'`)
  await sleep(1800)

  const current = await fps()
  const target = current === 30 ? 120 : 30
  console.log('fps', current, '->', target)

  await evaluate(`(() => { window.__done = false; window.electronAPI.setFps(${target}).then(r => { window.__done = r.success }) })()`)

  await sleep(1500)
  console.log('t+1.5s status :', await status())
  console.log('t+1.5s overlay:', await overlay())

  await sleep(5000)
  console.log('t+6.5s overlay:', await overlay())

  await sleep(14000)
  console.log('t+20s  status :', await status(), '| overlay:', await overlay())
  console.log('setter ok     :', await evaluate(`window.__done`))
  console.log('fps now       :', await fps())
  console.log('errors:', drainErrors())
}
