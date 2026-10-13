/**
 * Asserts the two-pane shell: titlebar, capture deck on the left, resizable clips
 * rail on the right, and the grain layer over the panel.
 */
export default async function ({ evaluate }) {
  const info = await evaluate(`(() => {
    const deck = document.querySelector('[data-testid="deck-pane"]')
    const rail = document.querySelector('[data-testid="rail-pane"]')
    const bar = document.querySelector('[data-testid="titlebar"]')
    const handle = document.querySelector('[data-testid="pane-resizer"]')
    const r = (el) => (el ? el.getBoundingClientRect() : null)
    return {
      titlebar: !!bar,
      deck: !!deck,
      rail: !!rail,
      resizer: !!handle,
      grain: !!document.querySelector('.grain'),
      deckWidth: deck ? Math.round(r(deck).width) : 0,
      railWidth: rail ? Math.round(r(rail).width) : 0,
      resizerWidth: handle ? Math.round(r(handle).width) : 0,
      railRight: rail ? Math.round(r(rail).right) : 0,
      innerW: window.innerWidth,
    }
  })()`)
  console.log('shell:', JSON.stringify(info))

  const problems = []
  if (!info.titlebar) problems.push('no titlebar')
  if (!info.deck) problems.push('no deck pane')
  if (!info.rail) problems.push('no rail pane')
  if (!info.grain) problems.push('no grain layer')
  if (!info.resizer) problems.push('no pane resizer')
  // The rail is a user-set width now, so the invariant is the split filling the
  // window inside the drag's own bounds, not a fixed 340.
  if (info.railWidth < 260 || info.railWidth > 480)
    problems.push('rail is ' + info.railWidth + 'px, outside its 260-480 range')
  if (info.deckWidth < 460) problems.push('deck is ' + info.deckWidth + 'px, under its 460px floor')
  if (info.deckWidth + info.resizerWidth + info.railWidth !== info.innerW)
    problems.push(
      'panes do not fill the window: ' +
        info.deckWidth +
        ' + ' +
        info.resizerWidth +
        ' + ' +
        info.railWidth +
        ' != ' +
        info.innerW,
    )
  if (info.railRight !== info.innerW) problems.push('rail does not reach the right edge')

  if (problems.length) {
    console.log('FAIL probe-shell: ' + problems.join('; '))
    throw new Error('shell assertion failed')
  }
  console.log('PASS probe-shell')
}
