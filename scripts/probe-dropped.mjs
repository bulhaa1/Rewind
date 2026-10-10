/**
 * Reproduces the dropped-setting problem.
 *
 * Settings mutations are serialized and overlapping ones are dropped, but the UI
 * updates its own display first. If a change is dropped the control still shows it
 * as applied while the engine never changed, which is indistinguishable from a
 * setting that only takes effect after a restart.
 */
export default async function ({ evaluate, drainErrors }) {
  await new Promise((r) => setTimeout(r, 1500))

  const engine = () => evaluate(`window.electronAPI.getVideoEncoder().then(r => r.data)`)
  const quality = () => evaluate(`window.electronAPI.getVisualQuality().then(r => r.data)`)

  console.log('engine encoder :', await engine())
  console.log('engine quality :', await quality())

  // Fire two encoder changes back to back. The first takes the fast path only if
  // the setting actually differs, so alternate values.
  console.log('--- firing two changes with no gap ---')
  const results = await evaluate(`
    (async () => {
      const a = await Promise.all([
        window.electronAPI.setVisualQuality('standard'),
        window.electronAPI.setVisualQuality('highest'),
      ])
      return JSON.stringify(a)
    })()
  `)
  console.log('results:', results)
  await new Promise((r) => setTimeout(r, 5000))
  console.log('engine quality after:', await quality())

  console.log('--- rapid encoder changes via the UI layer ---')
  const r2 = await evaluate(`
    (async () => {
      const out = []
      out.push(await window.electronAPI.setVideoEncoder('nvenc'))
      out.push(await window.electronAPI.setVideoEncoder('x264'))
      out.push(await window.electronAPI.setVideoEncoder('nvenc'))
      return JSON.stringify(out)
    })()
  `)
  console.log('results:', r2)
  await new Promise((r) => setTimeout(r, 5000))
  console.log('engine encoder after:', await engine())

  console.log('errors:', drainErrors())
}
