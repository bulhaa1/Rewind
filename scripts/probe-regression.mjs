/** Final regression sweep across the whole feature surface. */
export default async function ({ evaluate, drainErrors }) {
  const call = (expr) => evaluate(expr)
  const results = []
  const check = (name, pass, detail = '') => {
    results.push({ name, pass, detail })
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`)
  }

  // 1. status
  const status = await call(`window.electronAPI.getStatus().then(r => r.data.status)`)
  check('pipeline ready', status === 'ready', status)

  // 2. screenshot
  const shot = await call(`window.electronAPI.takeScreenshot().then(r => r.success)`)
  check('screenshot', shot === true)

  // 3. save clip
  const saved = await call(`window.electronAPI.saveReplay().then(r => r.success)`)
  check('save clip', saved === true)
  await new Promise((r) => setTimeout(r, 4000))

  // 4. library rewinds it
  const clips = await call(`window.electronAPI.getSavedClips().then(r => r.data.length)`)
  check('clip library non-empty', clips > 0, `${clips} clips`)

  // 5. thumbnails generate
  const thumb = await call(`
    window.electronAPI.getSavedClips().then(r => {
      const c = r.data[0]; if (!c) return 'no clip'
      return window.electronAPI.getClipThumbnail(c.path).then(t => t.success && t.data ? 'ok' : 'fail:' + t.error)
    })
  `)
  check('clip thumbnail', thumb === 'ok', String(thumb))

  // 6. screenshot thumbnail
  const sThumb = await call(`
    window.electronAPI.getScreenshots().then(r => {
      const s = r.data[0]; if (!s) return 'no shot'
      return window.electronAPI.getScreenshotThumbnail(s.path).then(t => t.success && t.data ? 'ok' : 'fail:' + t.error)
    })
  `)
  check('screenshot thumbnail', sThumb === 'ok', String(sThumb))

  // 7. hotkeys registered
  const hk = await call(`window.electronAPI.getHotkeys().then(r => JSON.stringify(r.data))`)
  check('hotkeys bound', /save-replay/.test(hk) && /screenshot/.test(hk), hk)

  // 8. audio sessions + devices
  const apps = await call(`window.electronAPI.getAudioSessions().then(r => r.success ? r.data.length : -1)`)
  check('audio sessions enumerated', apps >= 0, `${apps} apps`)
  const devs = await call(`window.electronAPI.getAudioDevices().then(r => r.success ? r.data.length : -1)`)
  check('audio devices enumerated', devs > 0, `${devs} devices`)

  // 9. encoder info
  const vendors = await call(`window.electronAPI.getAvailableEncoderVendors().then(r => r.data.map(v => v.vendor))`)
  check('encoder vendors detected', vendors.length > 0, JSON.stringify(vendors))
  const codecs = await call(`window.electronAPI.getAvailableCodecs().then(r => JSON.stringify(r.data))`)
  check('codecs detected', codecs !== '[]', codecs)

  // 10. clip editor info
  const edInfo = await call(`
    window.electronAPI.getSavedClips().then(r => {
      const c = r.data.find(x => !x.path.includes('-edit')) || r.data[0]
      return window.electronAPI.editorGetClipInfo(c.path).then(i => i.success ? 'ok dur=' + i.data.duration : 'fail:' + i.error)
    })
  `)
  check('editor clip info', String(edInfo).startsWith('ok'), String(edInfo))

  // 11. delete round trip
  const del = await call(`
    window.electronAPI.getSavedClips().then(r => {
      const c = r.data.find(x => x.filename.includes('Renamed Test')) || r.data[0]
      return window.electronAPI.deleteClip(c.path, 'local').then(d => d.success ? c.path : 'fail:' + d.error)
    })
  `)
  check('delete clip', typeof del === 'string' && !del.startsWith('fail'), String(del).slice(-40))
  await new Promise((r) => setTimeout(r, 1500))
  const afterDel = await call(`window.electronAPI.getSavedClips().then(r => r.data.length)`)
  check('library shrinks after delete', afterDel === clips - 1, `${clips} -> ${afterDel}`)

  // 12. path guards reject outside files
  const guard = await call(`window.electronAPI.openFile('C:\\\\\\\\Windows\\\\\\\\System32\\\\\\\\config\\\\\\\\SAM').then(r => r.success ? 'LEAKED' : 'blocked')`)
  check('path guard blocks outside files', guard === 'blocked', guard)

  const errs = drainErrors()
  check('no renderer exceptions', errs.length === 0, errs.join(' | '))

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
}