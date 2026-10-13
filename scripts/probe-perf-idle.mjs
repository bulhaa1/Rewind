/**
 * Idle-cost probe: what does the app still do when the buffer is paused?
 *
 * Reads the panel's own state before and after pausing the buffer, so the
 * "buffer off but still capturing" question is answered from the app itself.
 * Run against the app on --remote-debugging-port=9222.
 */
export default async function ({ evaluate }) {
  const snapshot = async (label) => {
    const state = await evaluate(`(async () => {
      const api = window.electronAPI
      const [active, source, mode, status, enc] = await Promise.all([
        api.isReplayBufferActive(),
        api.getCurrentSourceName(),
        api.getCaptureMode(),
        api.getStatus(),
        api.getActiveEncoderVendor(),
      ])
      return {
        bufferActive: active.data?.active,
        startedAt: active.data?.startedAt,
        source: source.data,
        mode: mode.data,
        status: status.data,
        encoderVendor: enc.data,
      }
    })()`)
    console.log(`\n=== ${label} ===`)
    console.log(JSON.stringify(state, null, 2))
    return state
  }

  await snapshot('BEFORE (as launched)')

  const paused = await evaluate(`(async () => {
    const res = await window.electronAPI.setReplayBufferActive(false)
    return res
  })()`)
  console.log('\npause result:', JSON.stringify(paused))

  await new Promise((r) => setTimeout(r, 3000))
  await snapshot('AFTER pause +3s')

  await new Promise((r) => setTimeout(r, 5000))
  await snapshot('AFTER pause +8s')
}
