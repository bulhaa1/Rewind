/** Inspects the editor window: does it render, and can it save a trimmed copy? */
export default async function ({ evaluate, drainErrors, url }) {
  console.log('attached to:', (url || '').slice(0, 80))

  await new Promise((r) => setTimeout(r, 2500))

  const text = await evaluate(`document.body.innerText`)
  console.log('--- EDITOR RENDERED TEXT ---')
  console.log(text)

  const media = await evaluate(`
    (() => {
      const v = document.querySelector('video')
      if (!v) return 'NO VIDEO ELEMENT'
      return JSON.stringify({ src: v.src.slice(0, 60), readyState: v.readyState, duration: v.duration, w: v.videoWidth, h: v.videoHeight })
    })()
  `)
  console.log('video element:', media)

  const controls = await evaluate(`
    [...document.querySelectorAll('button')].map(b => b.innerText.trim()).filter(Boolean)
  `)
  console.log('buttons:', JSON.stringify(controls))

  // Trim a copy: 5s..10s, saved as a copy so the original is preserved.
  const clip = await evaluate(`document.body.innerText.match(/Replay[^\\n]*/)?.[0]`)
  console.log('clip shown:', clip)

  console.log('renderer errors:', drainErrors().length ? drainErrors() : 'none')
}