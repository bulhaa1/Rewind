/** Sets the frame rate through the app's own IPC (full pipeline reinit). FPS=<n>. */
export default async function ({ evaluate }) {
  const fps = Number(process.env.FPS || 0)
  if (!fps) {
    console.log('FPS env not set; nothing changed')
    return
  }
  const res = await evaluate(`window.electronAPI.setFps(${fps})`)
  console.log(`setFps(${fps}) ->`, JSON.stringify(res))
  if (!res.success) return

  if (process.env.PAUSED_OK === '1') {
    console.log('PAUSED_OK set; not waiting for the buffer')
    return
  }

  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    const s = await evaluate(`window.electronAPI.isReplayBufferActive()`)
    if (s?.data?.active) {
      console.log(`buffer live again after ${i + 1}s`)
      return
    }
  }
  console.log('TIMED OUT waiting for the buffer after the reinit')
}
