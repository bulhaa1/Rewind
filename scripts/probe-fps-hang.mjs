/** Reproduces the fps change that leaves the app stuck on "Starting engine". */
export default async function ({ evaluate, drainErrors }) {
  const status = () => evaluate(`window.electronAPI.getStatus().then(r => r.data.status + '/' + (r.data.message || ''))`).catch(() => 'DEAD')
  const fps = () => evaluate(`window.electronAPI.getFps().then(r => r.data)`).catch(() => 'DEAD')

  console.log('fps now:', await fps(), ' status:', await status())

  await evaluate(`window.electronAPI.setFps(120).then(r => JSON.stringify(r))`).catch(e => console.log('set 120 failed', e))
  await new Promise((r) => setTimeout(r, 15000))
  console.log('after 120:', await fps(), ' status:', await status())

  const t0 = Date.now()
  console.log('--- now 120 -> 60, the reported failure ---')
  const res = await evaluate(`window.electronAPI.setFps(60).then(r => JSON.stringify(r))`).catch(e => 'THREW: ' + e)
  console.log(`setter settled after ${((Date.now() - t0) / 1000).toFixed(1)}s:`, res)

  for (let i = 1; i <= 20; i++) {
    const s = await status()
    console.log(`  t+${((Date.now() - t0) / 1000).toFixed(0)}s status=${s}`)
    await new Promise((r) => setTimeout(r, 5000))
  }
  console.log('final fps:', await fps())
  console.log('errors:', drainErrors())
}
