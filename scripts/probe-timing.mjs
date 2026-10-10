/** Times encoder setting changes: chain-tier vs full-reinit. */
export default async function ({ evaluate }) {
  await evaluate(`window.location.hash = '#/settings'`)
  await new Promise((r) => setTimeout(r, 1500))

  const clickText = (t) => evaluate(`
    (() => {
      const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === ${JSON.stringify(t)})
      if (!b) return false
      b.click(); return true
    })()
  `)

  const timeChange = async (open, pick) => {
    if (!(await clickText(open))) return `${open}: trigger not found`
    await new Promise((r) => setTimeout(r, 400))
    const t0 = Date.now()
    if (!(await clickText(pick))) return `${open} -> ${pick}: option not found`
    // Poll until the app reports ready again.
    let status = 'initializing'
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 500))
      status = await evaluate(`window.electronAPI.getStatus().then(r => r.data.status)`)
      if (status === 'ready' || status === 'error') break
    }
    return `${open} -> ${pick}: ${((Date.now() - t0) / 1000).toFixed(1)}s (status=${status})`
  }

  console.log(await timeChange('High (default)', 'Standard'))
  console.log(await timeChange('Standard', 'Highest (archival)'))
  console.log(await timeChange('Off (lower load)', 'On (higher quality)'))
  console.log(await timeChange('Performance (P4)', 'Quality (P5)'))
  console.log('--- full reinit tier (expected slower) ---')
  console.log(await timeChange('Native', '1080p'))
}