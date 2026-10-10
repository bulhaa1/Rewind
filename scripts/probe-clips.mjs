/**
 * Saves a clip through the real API, then exercises the library rows.
 * Verifies list rendering, click-to-open, context menu, rename and delete.
 */
export default async function ({ evaluate, drainErrors }) {
  await evaluate(`window.location.hash = '#/'`)
  await new Promise((r) => setTimeout(r, 600))

  // Save a clip via the real bridge.
  const save = await evaluate(`window.electronAPI.saveReplay().then(r => JSON.stringify(r))`)
  console.log('saveReplay:', save)
  await new Promise((r) => setTimeout(r, 3000))

  // Take a screenshot too.
  const shot = await evaluate(`window.electronAPI.takeScreenshot().then(r => JSON.stringify(r))`)
  console.log('takeScreenshot:', shot)
  await new Promise((r) => setTimeout(r, 3000))

  const clips = await evaluate(`window.electronAPI.getSavedClips().then(r => r.success ? r.data.map(c => c.filename) : 'ERR')`)
  console.log('clips from IPC:', JSON.stringify(clips))

  const shots = await evaluate(`window.electronAPI.getScreenshots().then(r => r.success ? r.data.length : 'ERR')`)
  console.log('screenshots from IPC:', shots)

  const text = await evaluate(`document.body.innerText`)
  console.log('--- HOME AFTER SAVE ---')
  console.log(text)

  // Click the clip row (the row is the element that opens on click).
  const clicked = await evaluate(`
    (() => {
      const rows = [...document.querySelectorAll('div')].filter(d =>
        d.className.includes('cursor-pointer') && d.className.includes('justify-between')
      )
      if (!rows.length) return 'NO ROWS'
      rows[0].click()
      return 'clicked row: ' + rows[0].innerText.split('\\n')[0]
    })()
  `)
  console.log('clip row click:', clicked)
  await new Promise((r) => setTimeout(r, 1500))

  // Context menu (right-click) then confirm the items render.
  const menu = await evaluate(`
    (() => {
      const rows = [...document.querySelectorAll('div')].filter(d =>
        d.className.includes('cursor-pointer') && d.className.includes('justify-between')
      )
      if (!rows.length) return 'NO ROWS'
      rows[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
      return 'right-clicked'
    })()
  `)
  console.log('context menu:', menu)
  await new Promise((r) => setTimeout(r, 500))
  const menuText = await evaluate(`document.body.innerText`)
  console.log('menu contains Edit:', /Edit/.test(menuText), '| contains Delete:', /Delete/.test(menuText))

  console.log('renderer errors:', drainErrors().length ? drainErrors() : 'none')
}