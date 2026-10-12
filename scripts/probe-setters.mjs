/** Calls every setting setter directly and asserts each returns a well-formed envelope. */
export default async function ({ evaluate, drainErrors }) {
  const cases = [
    ['setFps', 30, [30, 60]],
    ['setFps', 60, [30, 60]],
    ['setVisualQuality', 'low', ['low', 'standard', 'high', 'highest']],
    ['setVisualQuality', 'highest', ['low', 'standard', 'high', 'highest']],
    ['setNvencPreset', 'p3', ['p3', 'p4', 'p5']],
    ['setNvencMultipass', 'disabled', ['disabled', 'qres']],
    ['setVideoCodec', 'h264', ['h264', 'hevc', 'av1']],
    ['setOutputResolution', 'native', ['native', '1080p', '720p']],
    ['setBufferDuration', 60, null],
    ['setNotificationsEnabled', false, null],
    ['setNotificationSoundEnabled', true, null],
    ['setLaunchOnStartup', false, null],
  ]

  let bad = 0
  for (const [method, value] of cases) {
    const res = await evaluate(`
      window.electronAPI.${method}(${JSON.stringify(value)})
        .then(r => JSON.stringify(r))
        .catch(e => 'THREW: ' + e.message)
    `)
    let ok = false
    try {
      const parsed = JSON.parse(res)
      ok = parsed && typeof parsed.success === 'boolean'
    } catch {
      ok = false
    }
    if (!ok) bad++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${method}(${JSON.stringify(value)}) -> ${res.slice(0, 90)}`)
    await new Promise((r) => setTimeout(r, 3500))
  }

  console.log('\nrenderer exceptions:', drainErrors().length ? drainErrors() : 'none')
  console.log(bad === 0 ? '\nALL SETTERS RETURNED A VALID ENVELOPE' : `\n${bad} MALFORMED RESPONSES`)
}