/**
 * Editor export probe: sized MP4s (the readout and its two-pass landing), the
 * compressed-copy suffix, audio always present, and the refusal of a backwards
 * range and of a size below the floor.
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
    `window.electronAPI.editorExport({ clipPath: ${JSON.stringify(clip.path)}, startSec: 2, endSec: 1, targetMb: 1 })`,
  )
  const badOk = bad && bad.success === false
  console.log(`${badOk ? 'PASS' : 'FAIL'}  backwards range refused`)
  if (!badOk) problems.push('a backwards range was not refused')

  // A size under the floor is refused rather than encoded into garbage.
  const tooSmall = await evaluate(
    `window.electronAPI.editorExport({ clipPath: ${JSON.stringify(clip.path)}, startSec: 0, endSec: ${end}, targetMb: 0.1 })`,
  )
  const smallOk = tooSmall && tooSmall.success === false
  console.log(`${smallOk ? 'PASS' : 'FAIL'}  a sub-floor size is refused`)
  if (!smallOk) problems.push('a sub-floor size was not refused')

  // Small preset: the file lands close to the ask and keeps its audio.
  const mp4 = await evaluate(
    `window.electronAPI.editorExport({ clipPath: ${JSON.stringify(clip.path)}, startSec: 0, endSec: ${end}, targetMb: 1 })`,
  )
  const mp4Mb = mp4?.data ? mp4.data.bytes / 1024 / 1024 : 0
  const mp4Ok = mp4?.success && mp4Mb <= 1.2 && mp4Mb >= 0.5 && mp4.data.audioStreams === 1
  console.log(
    `${mp4Ok ? 'PASS' : 'FAIL'}  mp4 export: ${mp4?.data ? (mp4Mb * 1024).toFixed(0) + ' KB, ' + mp4.data.width + 'x' + mp4.data.height + ', ' + mp4.data.audioStreams + ' audio' : JSON.stringify(mp4)}`,
  )
  if (!mp4Ok) problems.push('mp4 export missed its size or its audio')

  // A larger ask on the same range: sizes must follow the ask.
  const target = await evaluate(
    `window.electronAPI.editorExport({ clipPath: ${JSON.stringify(clip.path)}, startSec: 0, endSec: ${end}, targetMb: 2 })`,
  )
  const targetMb = target?.data ? target.data.bytes / 1024 / 1024 : 0
  const targetOk = target?.success && targetMb <= 2.4 && targetMb >= 1.0
  console.log(
    `${targetOk ? 'PASS' : 'FAIL'}  two-pass 2 MB target: ${target?.data ? (targetMb * 1024).toFixed(0) + ' KB' : JSON.stringify(target)}`,
  )
  if (!targetOk) problems.push(`2 MB target landed at ${targetMb.toFixed(2)} MB`)

  // The compress suffix names the copy, and the original is untouched.
  const compress = await evaluate(
    `window.electronAPI.editorExport({ clipPath: ${JSON.stringify(clip.path)}, startSec: 0, endSec: ${end}, targetMb: 2 })`,
  )
  const compressOk = compress?.success && compress.data.path.includes('Compressed')
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
    `window.electronAPI.editorExport({ clipPath: ${JSON.stringify(long.path)}, startSec: ${midStart}, endSec: ${midEnd}, targetMb: 1 })`,
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

