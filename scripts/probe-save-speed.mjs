/** Measures how long a clip save takes, end to end, as the user experiences it. */
export default async function ({ evaluate, drainErrors }) {
  await new Promise((r) => setTimeout(r, 2000))
  const runs = []
  for (let i = 1; i <= 3; i++) {
    const t = await evaluate(`
      (async () => {
        const t0 = performance.now()
        const r = await window.electronAPI.saveReplay()
        return JSON.stringify({ ok: r.success, ms: Math.round(performance.now() - t0), err: r.error || null })
      })()
    `)
    console.log(`save ${i}:`, t)
    runs.push(JSON.parse(t))
    await new Promise((r) => setTimeout(r, 2500))
  }
  console.log('all succeeded:', runs.every(r => r.ok))
  console.log('errors:', drainErrors())
}
