/** Changes the encoder setting through the UI and reports whether the app survives. */
export default async function ({ evaluate, drainErrors }) {
  await new Promise((r) => setTimeout(r, 1500))

  const ping = (ms) => Promise.race([
    evaluate(`window.electronAPI.getStatus().then(r => 'alive:' + r.data.status)`),
    new Promise((r) => setTimeout(() => r('TIMEOUT'), ms)),
  ])

  console.log('before      :', await ping(5000))

  const target = process.env.REWIND_PROBE_ENCODER ?? 'x264'
  console.log('changing encoder to', target)
  const started = Date.now()
  const res = await evaluate(`
    window.electronAPI.setVideoEncoder(${JSON.stringify(target)}).then(r => JSON.stringify(r))
  `)
  console.log(`setter returned after ${((Date.now() - started) / 1000).toFixed(1)}s:`, res)

  // Poll for a couple of minutes: the failure mode is a silent hang, so the only
  // way to see it is to keep asking.
  for (let i = 1; i <= 24; i++) {
    const alive = await ping(4000)
    console.log(`  t+${((Date.now() - started) / 1000).toFixed(0)}s`, alive)
    if (alive === 'TIMEOUT') { console.log('HUNG: renderer stopped answering'); break }
    await new Promise((r) => setTimeout(r, 5000))
  }

  const fin = await evaluate(`
    window.electronAPI.getVideoEncoder().then(r => 'encoder=' + r.data)
  `).catch(() => 'FINAL QUERY FAILED')
  console.log('final:', fin)
  console.log('errors:', drainErrors())
}
