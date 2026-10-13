/** Saves a replay through the app's own IPC and reports the result. */
export default async function ({ evaluate }) {
  const res = await evaluate(`window.electronAPI.saveReplay()`)
  console.log('saveReplay ->', JSON.stringify(res))
}
