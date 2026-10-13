/** Sets notificationsEnabled, used to restore state a probe left behind. */
export default async function ({ evaluate }) {
  const value = process.env.NOTIFICATIONS === '1'
  const res = await evaluate(`window.electronAPI.setNotificationsEnabled(${value})`)
  console.log('setNotificationsEnabled(' + value + ') ->', JSON.stringify(res))
  const read = await evaluate('window.electronAPI.getNotificationsEnabled().then((r) => r.data)')
  console.log('read back ->', JSON.stringify(read))
}
