/** Prints the app's buffer/capture state. */
export default async function ({ evaluate }) {
  const state = await evaluate(`(async () => {
    const api = window.electronAPI
    const [active, source, mode, status] = await Promise.all([
      api.isReplayBufferActive(),
      api.getCurrentSourceName(),
      api.getCaptureMode(),
      api.getStatus(),
    ])
    return {
      bufferActive: active.data?.active,
      source: source.data,
      mode: mode.data,
      status: status.data,
    }
  })()`)
  console.log(JSON.stringify(state, null, 2))
}
