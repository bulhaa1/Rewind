/**
 * The divider between the deck and the rail: dragging it trades width between the
 * panes, the clamp holds at both ends, the arrows nudge, a double-click resets, the
 * chosen width is stored, and squeezing the window does not eat that choice.
 *
 * Restores the split and the window size it found.
 */
export default async function ({ evaluate }) {
  const call = (e) => evaluate(e)
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const problems = []
  const notes = []

  const layout = () =>
    call(`(() => {
      const rail = document.querySelector('[data-testid="rail-pane"]')
      const deck = document.querySelector('[data-testid="deck-pane"]')
      const handle = document.querySelector('[data-testid="pane-resizer"]')
      const total = handle.parentElement.clientWidth
      return {
        rail: Math.round(rail.getBoundingClientRect().width),
        deck: Math.round(deck.getBoundingClientRect().width),
        handle: Math.round(handle.getBoundingClientRect().width),
        total,
        ceiling: Math.max(260, Math.min(480, total - 460)),
        role: handle.getAttribute('role'),
        valuenow: Number(handle.getAttribute('aria-valuenow')),
        stored: Number(window.localStorage.getItem('rewind.railWidth')),
        innerW: window.innerWidth,
        outerW: window.outerWidth,
        outerH: window.outerHeight,
      }
    })()`)

  /** Drags the divider by `dx` pixels (negative moves it left, widening the rail). */
  const drag = (dx) =>
    call(`(() => {
      const handle = document.querySelector('[data-testid="pane-resizer"]')
      const r = handle.getBoundingClientRect()
      const x = r.left + r.width / 2
      const y = r.top + r.height / 2
      const opts = { bubbles: true, pointerId: 1, isPrimary: true }
      handle.dispatchEvent(new PointerEvent('pointerdown', { ...opts, clientX: x, clientY: y }))
      window.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: x + ${dx}, clientY: y }))
      window.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: x + ${dx}, clientY: y }))
      return true
    })()`)

  const press = (key) =>
    call(`(() => {
      const handle = document.querySelector('[data-testid="pane-resizer"]')
      handle.focus()
      handle.dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', bubbles: true }))
      return true
    })()`)

  const start = await layout()
  console.log('resizer:', JSON.stringify(start))
  if (start.role !== 'separator') problems.push('divider is not a separator (' + start.role + ')')
  if (start.valuenow !== start.rail) problems.push('aria-valuenow ' + start.valuenow + ' disagrees with ' + start.rail)
  if (start.rail < 260 || start.rail > 480) problems.push('rail started outside its range (' + start.rail + ')')

  // Wide open: the measured ceiling stops it.
  await drag(-1000)
  await wait(350)
  const wide = await layout()
  console.log('drag wide open:', start.rail, '->', wide.rail, '(ceiling', wide.ceiling + ')')
  if (wide.rail !== wide.ceiling) problems.push('rail stopped at ' + wide.rail + ', expected the ceiling ' + wide.ceiling)

  // Shut: the rail's own floor stops it, and the deck takes everything else.
  await drag(1000)
  await wait(350)
  const narrow = await layout()
  console.log('drag shut:', wide.rail, '->', narrow.rail, '(deck', narrow.deck + ')')
  if (narrow.rail !== 260) problems.push('rail stopped at ' + narrow.rail + ', expected its 260px floor')
  if (narrow.deck + narrow.handle + narrow.rail !== narrow.total)
    problems.push('panes do not fill the row at the floor')

  // Mid-range the drag is exact, and the deck gives up precisely what it gains.
  await drag(-100)
  await wait(350)
  const mid = await layout()
  console.log('drag left 100px:', narrow.rail, '->', mid.rail, '(deck', narrow.deck, '->', mid.deck + ')')
  if (mid.rail !== 360) problems.push('mid-range drag landed at ' + mid.rail + ', expected 360')
  if (mid.deck !== narrow.deck - 100) problems.push('deck did not give up the same 100px')
  if (mid.stored !== mid.rail) problems.push('rail width was not stored (' + mid.stored + ')')

  // The keyboard nudges the split the way the arrows point.
  await press('ArrowLeft')
  await wait(350)
  const nudged = await layout()
  console.log('ArrowLeft:', mid.rail, '->', nudged.rail)
  if (nudged.rail !== mid.rail + 16) problems.push('ArrowLeft moved the rail to ' + nudged.rail)

  // A double-click puts it back to the default.
  await call(
    `(() => { document.querySelector('[data-testid="pane-resizer"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true })()`,
  )
  await wait(350)
  const reset = await layout()
  console.log('double-click:', nudged.rail, '->', reset.rail)
  if (reset.rail !== 340) problems.push('double-click left the rail at ' + reset.rail + 'px, expected 340')

  // The preference must survive being clamped by a narrow window: set it wide,
  // squeeze the window so the rail has to give way, then reopen it.
  await drag(-1000)
  await wait(350)
  const chosen = (await layout()).rail
  await call(`window.resizeTo(880, ${start.outerH}); true`)
  await wait(900)
  const squeezed = await layout()
  if (squeezed.innerW === start.innerW) {
    notes.push('window.resizeTo had no effect, preference test skipped')
  } else {
    await call(`window.resizeTo(${start.outerW}, ${start.outerH}); true`)
    await wait(900)
    const reopened = await layout()
    console.log('squeeze + reopen:', chosen, '->', squeezed.rail, '->', reopened.rail)
    if (squeezed.rail >= chosen && squeezed.ceiling < chosen)
      problems.push('squeeze did not clamp the rail (' + squeezed.rail + ')')
    if (reopened.rail !== chosen) problems.push('reopening did not restore the chosen ' + chosen + 'px')
    if (reopened.stored !== chosen) problems.push('squeeze rewrote the stored width to ' + reopened.stored)
  }

  // Leave the split and the window exactly as they were found.
  const end = await layout()
  if (end.rail !== start.rail) {
    await drag(end.rail - start.rail)
    await wait(350)
    const restored = await layout()
    if (restored.rail !== start.rail) problems.push('could not restore the rail to ' + start.rail)
    console.log('restored split:', end.rail, '->', restored.rail)
  }
  if (end.innerW !== start.innerW) {
    await call(`window.resizeTo(${start.outerW}, ${start.outerH}); true`)
    await wait(600)
  }

  if (notes.length) console.log('note: ' + notes.join('; '))
  if (problems.length) {
    console.log('FAIL probe-resize: ' + problems.join('; '))
    throw new Error('resize assertion failed')
  }
  console.log('PASS probe-resize')
}
