/** Sets the rolling buffer on/off via the app's own IPC. BUFFER_ACTIVE=1 for on. */
export default async function ({ evaluate }) {
  const want = process.env.BUFFER_ACTIVE === '1'
  const res = await evaluate(`window.electronAPI.setReplayBufferActive(${want})`)
  console.log('setReplayBufferActive(' + want + ') ->', JSON.stringify(res))
  await new Promise((r) => setTimeout(r, 1000))
  const now = await evaluate(`window.electronAPI.isReplayBufferActive()`)
  console.log('isReplayBufferActive ->', JSON.stringify(now))
}
