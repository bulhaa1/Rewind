/**
 * Opens a specific clip in the editor and reports whether it actually plays.
 *
 * The other editor probes open whichever clip the library happens to hold, which
 * is useless for "does a file *I* just produced play" — the black-screen bug only
 * reproduced on joined recordings, so this targets one by name.
 *
 *   node scripts/cdp.mjs scripts/probe-editor-clip.mjs
 */
const TARGET = process.env.REFLECT_PROBE_CLIP ?? 'Editor Test Recording.mp4'

export default async function ({ evaluate, drainErrors }) {
  const opened = await evaluate(`
    (() => {
      const q = ${JSON.stringify(TARGET)}
      return window.electronAPI.getSavedClips().then(r => {
        if (!r.success) return 'library error: ' + r.error
        const hit = r.data.find(c => c.filename === q)
        if (!hit) return 'not found: ' + r.data.map(c => c.filename).join(' | ')
        return window.electronAPI.openClipEditor(hit.path).then(o => o.success ? 'opened ' + hit.filename : 'open failed: ' + o.error)
      })
    })()
  `)
  console.log('open:', opened)

  await new Promise((r) => setTimeout(r, 4000))
  await drainErrors()

  const state = await evaluate(`
    (() => {
      const v = document.querySelector('video')
      if (!v) return 'NO VIDEO ELEMENT'
      return JSON.stringify({
        src: (v.currentSrc || '').split('/').pop(),
        readyState: v.readyState,
        networkState: v.networkState,
        duration: +(v.duration || 0).toFixed(2),
        error: v.error ? v.error.code + ':' + v.error.message : null,
      })
    })()
  `)
  console.log('video element:', state)

  const played = await evaluate(`
    (() => {
      const v = document.querySelector('video')
      if (!v) return 'NO VIDEO ELEMENT'
      v.currentTime = Math.min(5, (v.duration || 10) / 2)
      return v.play().then(() => 'play() accepted').catch(e => 'play() rejected: ' + e.message)
    })()
  `)
  console.log('play:', played)

  await new Promise((r) => setTimeout(r, 3000))
  const after = await evaluate(`
    (() => {
      const v = document.querySelector('video')
      if (!v) return 'NO VIDEO ELEMENT'
      return JSON.stringify({ time: +v.currentTime.toFixed(2), paused: v.paused, readyState: v.readyState, error: v.error ? v.error.code : null })
    })()
  `)
  console.log('after 3s:', after)

  const painted = await evaluate(`
    (() => {
      const v = document.querySelector('video')
      if (!v) return 'NO VIDEO ELEMENT'
      const c = document.createElement('canvas')
      c.width = 160; c.height = 90
      const g = c.getContext('2d')
      g.drawImage(v, 0, 0, 160, 90)
      const d = g.getImageData(0, 0, 160, 90).data
      let sum = 0, distinct = new Set()
      for (let i = 0; i < d.length; i += 4) {
        sum += d[i] + d[i+1] + d[i+2]
        if (i % 400 === 0) distinct.add(d[i] + ',' + d[i+1] + ',' + d[i+2])
      }
      return JSON.stringify({ meanLuma: +(sum / (d.length / 4) / 3).toFixed(1), distinctColours: distinct.size })
    })()
  `)
  console.log('frame pixels:', painted)
  console.log('errors:', drainErrors())
}
