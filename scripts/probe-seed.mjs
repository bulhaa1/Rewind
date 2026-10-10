export default async function ({ evaluate }) {
  for (let i = 0; i < 2; i++) {
    await evaluate(`window.electronAPI.saveReplay().then(r => r.success)`)
    await new Promise(r => setTimeout(r, 3000))
  }
  const n = await evaluate(`window.electronAPI.getSavedClips().then(r => r.data.length)`)
  console.log('clips in library:', n)
}
