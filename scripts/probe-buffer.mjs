/** Exercises the buffer start/stop buttons through the real UI. */
export default async function ({ evaluate, drainErrors }) {
  await new Promise((r) => setTimeout(r, 1500))

  const buttons = () => evaluate(`
    (() => {
      const b = [...document.querySelectorAll('button')].filter(x => /^(Start|Stop)$/.test(x.textContent.trim()))
      return JSON.stringify(b.map(x => ({ label: x.textContent.trim(), disabled: x.disabled })))
    })()
  `)
  console.log('buttons:', await buttons())

  const click = (label) => evaluate(`
    (() => {
      const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(label)})
      if (!b) return 'missing'
      if (b.disabled) return 'disabled'
      b.click()
      return 'clicked'
    })()
  `)

  const state = () => evaluate(`window.electronAPI.isReplayBufferActive().then(r => 'engine=' + r.data.active)`)
  const status = () => evaluate(`window.electronAPI.getStatus().then(r => 'status=' + r.data.status)`)

  console.log('before      :', await state(), await status())
  console.log('stop        :', await click('Stop'))
  await new Promise((r) => setTimeout(r, 3000))
  console.log('after stop  :', await state(), await status())
  console.log('buttons     :', await buttons())

  // Pressing Stop again must be harmless, not a start.
  console.log('stop again  :', await click('Stop'), '(expect disabled)')
  console.log('start       :', await click('Start'))
  await new Promise((r) => setTimeout(r, 6000))
  console.log('after start :', await state(), await status())
  console.log('buttons     :', await buttons())

  // Pressing Start again must not pause it.
  console.log('start again :', await click('Start'), '(expect disabled)')
  await new Promise((r) => setTimeout(r, 2000))
  console.log('still       :', await state())

  console.log('start again :', await click('Start'))
  await new Promise((r) => setTimeout(r, 2000))
  console.log('unchanged   :', await state())

  console.log('start       :', await click('Start'))
  await new Promise((r) => setTimeout(r, 8000))
  console.log('running     :', await state(), await status())
  console.log('errors:', drainErrors())
}
