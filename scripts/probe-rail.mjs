/**
 * Rail behaviour: cards render, the segmented header switches, a card opens the
 * editor window, the context menu opens, and the delete dialog cancels without
 * deleting. Screenshot dropped in %TEMP%.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export default async function ({ evaluate, send }) {
  const call = (e) => evaluate(e)
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const problems = []

  const clipCount = await call('window.electronAPI.getSavedClips().then((r) => r.data.length)')
  const cards = await call('document.querySelectorAll("[data-testid=\\"rail-card\\"]").length')
  console.log('cards:', cards, 'of', clipCount, 'clips')
  if (!(cards > 0)) problems.push('no cards rendered')

  // segmented header switches to screenshots and back
  await call('document.querySelector("[data-testid=\\"rail-segment-screenshots\\"]").click()')
  await wait(1500)
  const shotsView = await call('document.querySelector("[data-testid=\\"rail-segment-screenshots\\"]").getAttribute("aria-pressed")')
  if (shotsView !== 'true') problems.push('screenshots segment did not activate')
  await call('document.querySelector("[data-testid=\\"rail-segment-clips\\"]").click()')
  await wait(1500)

  // card click opens the editor window
  // The editor is a single window, so close any leftover from an earlier run:
  // the click below has to be what opens it.
  const leftover = (await (await fetch('http://127.0.0.1:9222/json/list')).json()).filter((t) => (t.url || '').includes('editor=1'))
  for (const t of leftover) await fetch('http://127.0.0.1:9222/json/close/' + t.id)
  await wait(900)

  const pagesBefore = (await (await fetch('http://127.0.0.1:9222/json/list')).json()).filter((t) => (t.url || '').includes('editor=1')).length
  await call('document.querySelector("[data-testid=\\"rail-card\\"]").click()')
  await wait(3000)
  const pagesAfter = (await (await fetch('http://127.0.0.1:9222/json/list')).json()).filter((t) => (t.url || '').includes('editor=1')).length
  console.log('editor windows:', pagesBefore, '->', pagesAfter)
  if (pagesAfter <= pagesBefore) problems.push('clicking a card did not open the editor window')

  // context menu via right-click
  await call('(() => { const c = document.querySelector("[data-testid=\\"rail-card\\"]"); c.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); return true })()')
  await wait(1200)
  const menuOpen = await call('!!document.querySelector("[role=\\"menu\\"]")')
  if (!menuOpen) problems.push('context menu did not open')
  await call('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))')
  await wait(800)
  const menuClosed = await call('!document.querySelector("[role=\\"menu\\"]")')
  if (!menuClosed) problems.push('context menu did not close on Escape')

  // delete dialog cancels without deleting
  await call('(() => { const c = document.querySelector("[data-testid=\\"rail-card\\"]"); c.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); return true })()')
  await wait(1000)
  const clickedDelete = await call('(() => { const items = [...document.querySelectorAll("[role=\\"menuitem\\"]")]; const del = items.find((i) => /delete/i.test(i.textContent || "")); if (!del) return "not-found"; del.click(); return "clicked" })()')
  await wait(1200)
  const dialogOpen = await call('!!document.querySelector("[role=\\"dialog\\"]")')
  if (clickedDelete !== 'clicked' || !dialogOpen) problems.push('delete dialog did not open (' + clickedDelete + ')')
  const cancelled = await call('(() => { const b = [...document.querySelectorAll("button")].find((x) => /cancel/i.test(x.textContent || "")); if (!b) return "not-found"; b.click(); return "clicked" })()')
  await wait(1500)
  const dialogClosed = await call('!document.querySelector("[role=\\"dialog\\"]")')
  const clipCountAfter = await call('window.electronAPI.getSavedClips().then((r) => r.data.length)')
  if (cancelled !== 'clicked' || !dialogClosed) problems.push('delete dialog did not cancel')
  if (clipCountAfter !== clipCount) problems.push('cancel deleted a clip (' + clipCount + ' -> ' + clipCountAfter + ')')

  try {
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(os.tmpdir(), 'rewind-rail.png'), Buffer.from(shot.data, 'base64'))
    console.log('screenshot: %TEMP%/rewind-rail.png')
  } catch (e) {
    console.log('screenshot failed:', e.message)
  }

  if (problems.length) {
    console.log('FAIL probe-rail: ' + problems.join('; '))
    throw new Error('rail assertion failed')
  }
  console.log('PASS probe-rail')
}
