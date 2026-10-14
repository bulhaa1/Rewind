/**
 * Export via the real UI: clicks the format toggle and the export button in the
 * editor window, exactly like a user, and reports what the panel shows.
 *
 * The editor window must already be open (scripts/probe-editor.mjs opens one).
 * Run: node scripts/cdp.mjs scripts/probe-export-ui.mjs editor=1
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export default async function ({ evaluate, drainErrors }) {
  const problems = []
  console.log('attached to:', (await evaluate('location.href')).slice(0, 70))

  const section = await evaluate(`(() => {
    const s = document.querySelector('[data-testid="export-section"]')
    return s ? { text: s.innerText, buttons: [...s.querySelectorAll('button')].map((b) => ({
      text: b.innerText.trim(), disabled: b.disabled, title: b.title,
    })) } : null
  })()`)
  if (!section) {
    console.log('FAIL probe-export-ui: no export section in the editor')
    throw new Error('no export section')
  }
  console.log('export section:', JSON.stringify(section, null, 1))

  // Select GIF the way a user does, then click the export button.
  const clicked = await evaluate(`(() => {
    const buttons = [...document.querySelectorAll('[data-testid="export-section"] button')]
    const gif = buttons.find((b) => b.innerText.trim() === 'GIF')
    if (!gif) return 'no GIF toggle'
    gif.click()
    const ex = document.querySelector('[data-testid="export-button"]')
    if (!ex) return 'no export button'
    const state = { disabled: ex.disabled, title: ex.title }
    if (ex.disabled) return JSON.stringify(state)
    ex.click()
    return JSON.stringify(state)
  })()`)
  console.log('gif click ->', clicked)
  if (clicked.startsWith('"') && JSON.parse(clicked).disabled) {
    problems.push('export button was disabled for the GIF path')
  }

  await sleep(10_000)
  const after = await evaluate(`document.querySelector('[data-testid="export-section"]')?.innerText`)
  console.log('section after 10s:', after)
  const errors = drainErrors()
  console.log('renderer errors:', errors.length ? errors : 'none')
  if (errors.length) problems.push(...errors)
  if (/error/i.test(after ?? '') && !/Saved/i.test(after ?? '')) {
    problems.push('panel shows an error: ' + (after ?? '').split('\n').filter((l) => /error/i.test(l)).join('; '))
  }
  if (!/Saved|%\s|$/.test(after ?? '') && !(after ?? '').includes('%')) {
    problems.push('no result and no progress after 10s')
  }

  if (problems.length) {
    console.log('FAIL probe-export-ui: ' + problems.join('; '))
    throw new Error('ui export assertion failed')
  }
  console.log('PASS probe-export-ui')
}
