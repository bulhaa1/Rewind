/** Sets the output path through the app's own IPC. OUTPUT_PATH=<dir>. */
export default async function ({ evaluate }) {
  const target = process.env.OUTPUT_PATH || ''
  if (!target) {
    console.log('OUTPUT_PATH env not set; nothing changed')
    return
  }
  const res = await evaluate(`window.electronAPI.setOutputPath(${JSON.stringify(target)})`)
  console.log(`setOutputPath(${JSON.stringify(target)}) ->`, JSON.stringify(res))
  const read = await evaluate(`window.electronAPI.getOutputPath()`)
  console.log('getOutputPath ->', JSON.stringify(read))
}
