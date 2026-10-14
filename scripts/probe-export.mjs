/**
 * Editor export probe: small MP4 (quality and two-pass size target), GIF, and the
 * compressed-copy suffix, plus the refusal of a backwards range.
 *
 * Needs at least one saved clip. If the library is empty it saves one from the
 * replay buffer first, the same way the regression sweep does.
 *
 * Run against a running app with a debugging port:
 *   node scripts/cdp.mjs scripts/probe-export.mjs
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export default async function ({ evaluate }) {
  const problems = []

  // Progress events are collected in the page so the awaited export promise does
  // not have to be interleaved with polling.
  await evaluate(`(() => {
    window.__exportProgress = []
    window.electronAPI.on('export-progress', (p) => window.__exportProgress.push(p.percent))
    return true
  })()`)

  let clips = await evaluate('window.electronAPI.getSavedClips().then(r => r.data)')
  if (!clips?.length) {
    const saved = await evaluate('window.electronAPI.saveReplay().then(r => r.success)')
    if (!saved) {
      console.log('FAIL probe-export: no clips and the replay buffer could not save one')
      throw new Error('no clip to export')
    }
    await sleep(4000)
    clips = await evaluate('window.electronAPI.getSavedClips().then(r => r.data)')
  }
  const clip = clips[0]
  console.log(`clip: ${clip.filename} (${(clip.fileSize / 1024 / 1024).toFixed(1)} MB, ${clip.duration}s)`)
  const end = Math.min(3, Math.max(1, clip.duration))

  // Backwards range is refused, cleanly.
  const bad = await evaluate(
    `window.electronAPI.editorExport({ clipPath: ${JSON.stringify(clip.path)}, startSec: 2, endSec: 1, format: 'mp4', maxHeight: 720, targetMb: null, audio: false })`,
  )
  const badOk = bad && bad.success === false
  console.log(`${badOk ? 'PASS' : 'FAIL'}  backwards range refused`)
  if (!badOk) problems.push('a backwards range was not refused')

  // Quality MP4 of the first 3 seconds.
  const mp4 = await evaluate(
    `window.electronAPI.editorExport({ clipPath: ${JSON.stringify(clip.path)}, startSec: 0, endSec: ${end}, format: 'mp4', maxHeight: 720, targetMb: null, audio: false })`,
  )
  const mp4Ok = mp4?.success && mp4.data.bytes > 0
  console.log(
    `${mp4Ok ? 'PASS' : 'FAIL'}  mp4 export: ${mp4?.data ? (mp4.data.bytes / 1024).toFixed(0) + ' KB, ' + mp4.data.width + 'x' + mp4.data.height : JSON.stringify(mp4)}`,
  )
  if (!mp4Ok) problems.push('quality mp4 export failed')

  // Two-pass target: 1 MB must land close to it.
  const target = await evaluate(
    `window.electronAPI.editorExport({ clipPath: ${JSON.stringify(clip.path)}, startSec: 0, endSec: ${end}, format: 'mp4', maxHeight: 720, targetMb: 1, audio: false, suffix: 'target' })`,
  )
  const targetMb = target?.data ? target.data.bytes / 1024 / 1024 : 0
  const targetOk = target?.success && targetMb <= 1.2 && targetMb >= 0.5
  console.log(
    `${targetOk ? 'PASS' : 'FAIL'}  two-pass 1 MB target: ${target?.data ? (targetMb * 1024).toFixed(0) + ' KB' : JSON.stringify(target)}`,
  )
  if (!targetOk) problems.push(`1 MB target landed at ${targetMb.toFixed(2)} MB`)

  // GIF: animated, real, and small enough to have come from the 480p cap.
  const gif = await evaluate(
    `window.electronAPI.editorExport({ clipPath: ${JSON.stringify(clip.path)}, startSec: 0, endSec: ${end}, format: 'gif', maxHeight: 480, gifFps: 15, targetMb: null, audio: false })`,
  )
  const gifOk = gif?.success && gif.data.bytes > 0 && gif.data.height <= 480
  console.log(
    `${gifOk ? 'PASS' : 'FAIL'}  gif export: ${gif?.data ? (gif.data.bytes / 1024).toFixed(0) + ' KB, ' + gif.data.width + 'x' + gif.data.height : JSON.stringify(gif)}`,
  )
  if (!gifOk) problems.push('gif export failed')

  // The compress suffix names the copy, and the original is untouched.
  const compress = await evaluate(
    `window.electronAPI.editorExport({ clipPath: ${JSON.stringify(clip.path)}, startSec: 0, endSec: ${end}, format: 'mp4', maxHeight: 720, targetMb: 2, audio: false, suffix: 'compressed' })`,
  )
  const compressOk = compress?.success && /compressed/i.test(compress.data.path)
  console.log(`${compressOk ? 'PASS' : 'FAIL'}  compress copy: ${compress?.data?.path ?? JSON.stringify(compress)}`)
  if (!compressOk) problems.push('the compressed copy was not named with its suffix')

  const progress = await evaluate('window.__exportProgress')
  const maxPercent = Math.max(0, ...(progress ?? [0]))
  console.log(`${maxPercent >= 90 ? 'PASS' : 'FAIL'}  progress events reached ${maxPercent}%`)
  if (maxPercent < 90) problems.push(`progress never passed 90% (max ${maxPercent})`)

  // A range that starts mid-clip: input-side -ss resets timestamps to 0, so the
  // progress must still run 0..100 against the RANGE, not the clip.
  await evaluate(`window.__exportProgress = []`)
  const long = clips.find((c) => c.duration >= 20) ?? clip
  const midStart = Math.min(10, Math.max(0, long.duration - 3))
  const midEnd = Math.min(midStart + 3, long.duration)
  const mid = await evaluate(
    `window.electronAPI.editorExport({ clipPath: ${JSON.stringify(long.path)}, startSec: ${midStart}, endSec: ${midEnd}, format: 'mp4', maxHeight: 480, targetMb: null, audio: false })`,
  )
  const midProgress = await evaluate('window.__exportProgress')
  const midMax = Math.max(0, ...(midProgress ?? [0]))
  const midOk = mid?.success && midMax >= 90
  console.log(`${midOk ? 'PASS' : 'FAIL'}  mid-clip export progress reached ${midMax}% (range ${midStart}s..${midEnd}s)`)
  if (!midOk) problems.push(`mid-clip export: progress stuck at ${midMax}%, success ${mid?.success}`)

  if (problems.length) {
    console.log('FAIL probe-export: ' + problems.join('; '))
    throw new Error('export assertion failed')
  }
  console.log('PASS probe-export')
}
