/** Calls editorSaveClip with exact values to verify the trim maths deterministically. */
export default async function ({ evaluate, drainErrors }) {
  const clip = await evaluate(`
    window.electronAPI.getSavedClips().then(r => r.success ? r.data.find(c => !c.path.includes('-edit'))?.path : null)
  `)
  console.log('source clip:', clip)

  const res = await evaluate(`
    window.electronAPI.editorSaveClip({
      clipPath: ${JSON.stringify(clip)},
      startSec: 5,
      endSec: 15,
      mode: 'copy',
      trackVolumes: [{ stream: 0, volume: 1 }]
    }).then(r => JSON.stringify(r))
  `)
  console.log('editorSaveClip(5..15):', res)
}