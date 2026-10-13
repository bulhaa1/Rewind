/**
 * Asserts the two-pane shell: titlebar, capture deck on the left, clips rail on
 * the right, and the grain layer over the panel.
 */
export default async function ({ evaluate }) {
  const info = await evaluate(`(() => {
    const deck = document.querySelector('[data-testid="deck-pane"]')
    const rail = document.querySelector('[data-testid="rail-pane"]')
    const bar = document.querySelector('[data-testid="titlebar"]')
    const r = (el) => (el ? el.getBoundingClientRect() : null)
    return {
      titlebar: !!bar,
      deck: !!deck,
      rail: !!rail,
      grain: !!document.querySelector('.grain'),
      deckWidth: deck ? Math.round(r(deck).width) : 0,
      railWidth: rail ? Math.round(r(rail).width) : 0,
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
  if (info.railWidth !== 340) problems.push('rail is ' + info.railWidth + 'px, expected 340')
  if (info.deckWidth !== info.innerW - 340) problems.push('deck is ' + info.deckWidth + 'px, expected innerW - 340')
  if (info.railRight !== info.innerW) problems.push('rail does not reach the right edge')

  if (problems.length) {
    console.log('FAIL probe-shell: ' + problems.join('; '))
    throw new Error('shell assertion failed')
  }
  console.log('PASS probe-shell')
}
