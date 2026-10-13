/**
 * Asserts the landscape window shell: geometry, the custom titlebar, and the
 * drag wiring a frameless window depends on. Drops a screenshot in %TEMP%.
 *
 * Physical behaviours (double-click maximize, snap layouts, dragging, close to
 * tray) are inherently manual and are covered by the Task 11 checklist.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export default async function ({ evaluate, send }) {
  const info = await evaluate(`(() => {
    const bar = document.querySelector('[data-testid="titlebar"]')
    const gearBtn = document.querySelector('[data-testid="titlebar-settings"]')
    const noDrag = gearBtn ? gearBtn.closest('.no-drag') : null
    const region = (el) => (el ? getComputedStyle(el).getPropertyValue('-webkit-app-region') : '')
    return {
      outerW: window.outerWidth,
      outerH: window.outerHeight,
      innerW: window.innerWidth,
      innerH: window.innerHeight,
      titlebar: !!bar,
      gear: !!gearBtn,
      barHeight: bar ? Math.round(bar.getBoundingClientRect().height) : 0,
      barRegion: region(bar),
      gearRegion: region(noDrag),
      barHasDragClass: bar ? bar.classList.contains('drag-region') : false,
      gearHasNoDragClass: noDrag ? noDrag.classList.contains('no-drag') : false,
    }
  })()`)
  console.log('shell:', JSON.stringify(info))

  try {
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(os.tmpdir(), 'rewind-titlebar.png'), Buffer.from(shot.data, 'base64'))
    console.log('screenshot: %TEMP%/rewind-titlebar.png')
  } catch (e) {
    console.log('screenshot failed:', e.message)
  }

  const problems = []
  if (info.outerW < 860 || info.outerH < 540) {
    problems.push('window is ' + info.outerW + 'x' + info.outerH + ', below the 860x540 floor')
  }
  if (!info.titlebar) problems.push('no titlebar')
  if (!info.gear) problems.push('no settings button')
  if (info.barHeight !== 40) problems.push('titlebar height ' + info.barHeight + ', expected 40 (overlay height)')
  if (info.barRegion !== 'drag' && !info.barHasDragClass) problems.push('titlebar is not a drag region')
  if (info.gearRegion !== 'no-drag' && !info.gearHasNoDragClass) problems.push('settings button does not opt out of dragging')

  if (problems.length) {
    console.log('FAIL probe-titlebar: ' + problems.join('; '))
    throw new Error('titlebar assertion failed')
  }
  console.log('PASS probe-titlebar')
}
