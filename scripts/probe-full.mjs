/** Exercises the remaining unverified paths: rename, delete, buffer length, capture mode. */
export default async function ({ evaluate, drainErrors }) {
  const api = (expr) => evaluate(expr)

  // ---- rename ----
  const clip = await api(`window.electronAPI.getSavedClips().then(r => r.success ? r.data.find(c => !c.path.includes('-edit'))?.path : null)`)
  console.log('=== RENAME ===')
  console.log('target:', clip)
  console.log('rename ok:', await api(`window.electronAPI.renameClip(${JSON.stringify(clip)}, 'My Renamed Clip').then(r => JSON.stringify(r))`))
  console.log('rename to illegal name (should fail cleanly):',
    await api(`window.electronAPI.renameClip(${JSON.stringify(clip)}, 'bad|name').then(r => JSON.stringify(r))`))
  console.log('rename to empty (should fail cleanly):',
    await api(`window.electronAPI.renameClip(${JSON.stringify(clip)}, '').then(r => JSON.stringify(r))`))
  const renamed = await api(`window.electronAPI.getSavedClips().then(r => r.success ? r.data.map(c => c.filename) : [])`)
  console.log('clips now:', JSON.stringify(renamed))

  // ---- buffer length ----
  console.log('\n=== BUFFER LENGTH ===')
  console.log('set 120s:', await api(`window.electronAPI.setBufferDuration(120).then(r => JSON.stringify(r))`))
  await new Promise((r) => setTimeout(r, 10000))
  console.log('config now:', await api(`window.electronAPI.getConfig().then(r => JSON.stringify(r))`))

  // ---- capture mode ----
  console.log('\n=== CAPTURE MODE ===')
  console.log('set display 0:', await api(`window.electronAPI.setDisplay(0).then(r => JSON.stringify(r))`))
  await new Promise((r) => setTimeout(r, 8000))
  console.log('capture mode:', await api(`window.electronAPI.getCaptureMode().then(r => JSON.stringify(r))`))
  console.log('source name:', await api(`window.electronAPI.getCurrentSourceName().then(r => JSON.stringify(r))`))
  console.log('displays:', await api(`window.electronAPI.getDisplays().then(r => JSON.stringify(r))`))

  // ---- screenshot list ----
  console.log('\n=== SCREENSHOTS ===')
  const shots = await api(`window.electronAPI.getScreenshots().then(r => JSON.stringify(r.data.map(s => s.name)))`)
  console.log('screenshot list:', shots)

  console.log('\nrenderer errors:', drainErrors().length ? drainErrors() : 'none')
}