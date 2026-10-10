/** Waits for the replay buffer to fill, then saves a clip and reports the result. */
export default async function ({ evaluate, drainErrors }) {
  await evaluate(`window.location.hash = '#/'`)
  await new Promise((r) => setTimeout(r, 500))

  const status = await evaluate(`window.electronAPI.getStatus().then(r => JSON.stringify(r))`)
  console.log('status:', status)

  console.log('waiting 20s for buffer...')
  await new Promise((r) => setTimeout(r, 20000))

  const save = await evaluate(`window.electronAPI.saveReplay().then(r => JSON.stringify(r))`)
  console.log('saveReplay:', save)

  await new Promise((r) => setTimeout(r, 3000))
  const clips = await evaluate(`window.electronAPI.getSavedClips().then(r => r.success ? r.data.map(c => c.filename) : 'ERR')`)
  console.log('clips:', JSON.stringify(clips))

  console.log('renderer errors:', drainErrors().length ? drainErrors() : 'none')
}