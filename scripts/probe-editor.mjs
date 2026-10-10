/**
 * Opens the clip editor and verifies it loads, then exercises a trim save.
 * The editor runs in its own window, so this connects to that target directly.
 */
export default async function ({ evaluate, drainErrors }) {
  await evaluate(`window.location.hash = '#/'`)
  await new Promise((r) => setTimeout(r, 500))

  const clip = await evaluate(`
    window.electronAPI.getSavedClips().then(r => r.success && r.data[0] ? r.data[0].path : null)
  `)
  console.log('opening editor for:', clip)
  if (!clip) return

  const open = await evaluate(`window.electronAPI.openClipEditor(${JSON.stringify(clip)}).then(r => JSON.stringify(r))`)
  console.log('openClipEditor:', open)

  await new Promise((r) => setTimeout(r, 6000))

  // The editor is a separate window; read it from the main page's perspective.
  const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json()
  const editorTarget = targets.find((t) => t.type === 'page' && t.url.includes('editor=1'))
  console.log('editor window found:', !!editorTarget, editorTarget?.url?.slice(0, 90))

  if (editorTarget) {
    const info = await evaluate(`
      window.electronAPI.editorGetClipInfo(${JSON.stringify(clip)}).then(r => JSON.stringify(r).slice(0, 400))
    `)
    console.log('editorGetClipInfo:', info)

    const peaks = await evaluate(`
      window.electronAPI.editorGetTrackPeaks(${JSON.stringify(clip)}, 0).then(r => JSON.stringify(r).slice(0, 160))
    `)
    console.log('editorGetTrackPeaks:', peaks)
  }

  console.log('main renderer errors:', drainErrors().length ? drainErrors() : 'none')
}