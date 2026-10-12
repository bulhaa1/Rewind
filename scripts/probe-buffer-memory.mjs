/**
 * Buffer memory readout: the estimate must be honest, and the warning must fire
 * in both directions.
 *
 * OBS's replay buffer holds encoded packets in a heap deque inside a separate
 * process and exposes no size for it, so this is a derived figure. The risk being
 * guarded against is presenting a derived number as a measured one -- so the
 * checks here are about the *provenance* of the bitrate as much as the arithmetic.
 *
 * The bitrate matters because a GPU encoder runs CQP: its output rate is a
 * property of the content, and `VBR_KBPS_BY_QUALITY` is an x264 target table that
 * overstates it by roughly 8x here. A 'measured' estimate must land near a real
 * clip of the same length; a 'table' estimate is explicitly exempt and is
 * required to *say* it is a guess.
 *
 * Run against the app on --remote-debugging-port=9222.
 * Mutates quality/duration/threshold, then restores them.
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const results = []
function check(name, pass, detail = '') {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`)
}

const ffprobe = path.join(process.cwd(), 'node_modules', 'ffprobe-static', 'bin', 'win32', 'x64', 'ffprobe.exe')

function probe(file) {
  const out = execFileSync(ffprobe, [
    '-v', 'quiet', '-print_format', 'json',
    '-show_streams', '-show_format', file,
  ], { encoding: 'utf8' })
  return JSON.parse(out)
}

/**
 * Collect clips, newest first.
 *
 * Sorted by mtime before the cap is applied. Truncating in directory-walk order
 * instead keeps whatever `readdirSync` happens to return first -- alphabetical,
 * which for a dated filename means every clip from yesterday fills the quota
 * before today's does, and the newest recordings silently drop out of every
 * comparison.
 */
function collectClips(root) {
  const found = []
  const walk = (dir, depth) => {
    if (depth > 3) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full, depth + 1)
      else if (e.name.endsWith('.mp4')) {
        try {
          found.push({ file: full, at: fs.statSync(full).mtimeMs })
        } catch {
          /* vanished mid-walk */
        }
      }
    }
  }
  if (fs.existsSync(root)) walk(root, 0)
  found.sort((a, b) => b.at - a.at)
  return found.map((f) => f.file)
}

export default async function ({ evaluate }) {
  const srcPath = path.join(process.cwd(), 'src', 'shared', 'buffer-memory.ts')
  const hasSrc = fs.existsSync(srcPath)
  check('src/shared/buffer-memory.ts exists', hasSrc, hasSrc ? fs.statSync(srcPath).size + ' bytes' : 'ENOENT')
  if (!hasSrc) {
    console.log('\n0/1 checks passed')
    return
  }

  const settings = JSON.parse(
    fs.readFileSync(path.join(process.env.APPDATA, 'Rewind', 'settings.json'), 'utf8'),
  )
  // Capture the threshold through the app rather than from raw JSON. A
  // settings.json written before this feature existed has no `memoryWarnMb` key,
  // and restoring that literal `undefined` would either fail or leave the
  // previous run's value behind -- which is how the threshold ended up pinned at
  // the floor after an earlier run.
  const resolvedWarnMb = await evaluate(
    `window.electronAPI.getMemoryWarnMb().then(r=>String(r.data ?? ''))`,
  )
  const saved = {
    quality: settings.visualQuality,
    duration: settings.bufferDuration,
    warnMb: Number(resolvedWarnMb) || 512,
  }
  console.log(`restoring on exit: ${JSON.stringify(saved)}`)

  const call = async (expr) => {
    const raw = await evaluate(expr)
    try {
      return JSON.parse(raw)
    } catch {
      return { __raw: raw }
    }
  }

  const setQuality = (q) => `window.electronAPI.setVisualQuality('${q}').then(r=>JSON.stringify(r))`
  const setDuration = (d) => `window.electronAPI.setBufferDuration(${d}).then(r=>JSON.stringify(r))`
  const setMemoryWarnMb = (m) => `window.electronAPI.setMemoryWarnMb(${m}).then(r=>JSON.stringify(r))`
  const estimate = () =>
    `window.electronAPI.getBufferMemoryEstimate().then(r=>JSON.stringify(r.data ?? r))`

  try {
    // --- the readout responds to the controls it claims to respond to --------
    await evaluate(setDuration(60))
    await evaluate(setQuality('high'))
    const base = await call(estimate())
    console.log('estimate at 60s/high:', JSON.stringify(base))

    check(
      'the app returns a buffer memory estimate',
      typeof base.estimatedMb === 'number' && base.estimatedMb > 0,
      JSON.stringify(base),
    )
    check(
      'the estimate declares its bitrate provenance',
      base.source === 'measured' || base.source === 'table',
      `source=${base.source}`,
    )

    // The arithmetic, cross-checked from the app's own inputs. A wrong kbps->Mbps
    // or MB-vs-MiB conversion shows up here even when the inputs look right.
    const expectedMb = Math.round(
      ((base.videoKbps + base.audioKbps) * 1000 * base.durationSeconds) / 8 / 1024 / 1024,
    )
    check(
      'the reported MB matches bitrate x duration from the app own inputs',
      Math.abs(base.estimatedMb - expectedMb) <= 1,
      `reported ${base.estimatedMb} vs computed ${expectedMb}`,
    )

    // --- a measured estimate must agree with a real clip ---------------------
    const clips = collectClips(settings.outputPath)
    const measured = []
    for (const f of clips) {
      if (measured.length >= 40) break
      try {
        const meta = probe(f)
        const durSec = Number(meta.format?.duration ?? 0)
        if (durSec < 8) continue
        const bytes = fs.statSync(f).size
        measured.push({
          durSec,
          mb: bytes / 1024 / 1024,
          kbps: (bytes * 8) / durSec / 1000,
          at: fs.statSync(f).mtimeMs,
        })
      } catch {
        /* unreadable, skip */
      }
    }
    if (measured.length) {
      const rates = measured.map((m) => m.kbps).sort((a, b) => a - b)
      console.log(
        `real clips: ${measured.length}, container bitrate median ${Math.round(rates[rates.length >> 1])} kbps ` +
          `(spread ${Math.round(rates[0])}..${Math.round(rates[rates.length - 1])})`,
      )
      console.log(
        `  that spread is ${(rates[rates.length - 1] / Math.max(1, rates[0])).toFixed(0)}x at identical ` +
          'encoder settings, which is why the estimate is a median over recent clips rather than one number',
      )
    }

    if (base.source === 'measured') {
      // Compared against the clips the estimator actually used -- the most recent
      // ones -- rather than the whole library. A CQP bitrate is a property of what
      // was on screen, so a quiet week of clips and a busy recording session are
      // legitimately different numbers, and averaging the two proves nothing.
      const recent = [...measured].sort((a, b) => b.at - a.at).slice(0, 8)
      const recentVideo = recent.map((m) => m.kbps - 259).sort((a, b) => a - b)
      const mid = recentVideo.length >> 1
      const medianVideo =
        recentVideo.length === 0
          ? 0
          : recentVideo.length % 2 === 1
            ? recentVideo[mid]
            : (recentVideo[mid - 1] + recentVideo[mid]) / 2

      if (medianVideo > 0) {
        const ratio = base.videoKbps / medianVideo
        check(
          'the reported bitrate matches the median of the clips actually recorded',
          ratio > 0.6 && ratio < 1.7,
          `reported ${base.videoKbps} kbps vs median of last ${recentVideo.length} clips ` +
            `${Math.round(medianVideo)} kbps (ratio ${ratio.toFixed(2)})`,
        )
      } else {
        check('recent clips available to compare against', false, 'none found')
      }
    } else {
      console.log(
        `source=table (no clip recorded at 'high' yet) -> ${base.videoKbps} kbps. ` +
          'The x264 target table is expected to overstate a GPU encoder here, so the ratio check is skipped.',
      )
      check('a table-based estimate still carries a non-zero bitrate', base.videoKbps > 0, `${base.videoKbps} kbps`)
    }

    // --- the warning must fire in BOTH directions ----------------------------
    // A warning that never fires is as useless as one that always does, and only
    // one of these two cases can pass by accident.
    await evaluate(setDuration(300))
    await evaluate(setQuality('highest'))
    const worst = await call(estimate())
    console.log('estimate at 300s/highest:', JSON.stringify(worst))
    check(
      '5 minutes at highest quality trips the warning',
      worst.exceeds === true && worst.estimatedMb > worst.warnMb,
      `${worst.estimatedMb} MB vs warn ${worst.warnMb} MB, exceeds=${worst.exceeds}`,
    )

    await evaluate(setDuration(15))
    await evaluate(setQuality('low'))
    const small = await call(estimate())
    console.log('estimate at 15s/low:', JSON.stringify(small))
    check(
      '15 seconds at low quality does not warn',
      small.exceeds === false && small.estimatedMb < small.warnMb,
      `${small.estimatedMb} MB vs warn ${small.warnMb} MB`,
    )

    // --- duration must actually move the number ------------------------------
    // Quality is held fixed here. Changing duration and quality together would
    // make this assertion unfalsifiable: the ratio could fail for either reason
    // and the message would not say which.
    await evaluate(setQuality('high'))
    await evaluate(setDuration(30))
    const shortRun = await call(estimate())
    await evaluate(setDuration(120))
    const longRun = await call(estimate())
    const durationRatio = longRun.durationSeconds / shortRun.durationSeconds
    const mbRatio = longRun.estimatedMb / shortRun.estimatedMb
    check(
      'the estimate scales with duration at a fixed quality',
      Math.abs(mbRatio / durationRatio - 1) < 0.01,
      `MB ratio ${mbRatio.toFixed(2)}x vs duration ratio ${durationRatio.toFixed(2)}x at ${longRun.videoKbps} kbps`,
    )

    // --- the threshold is read live, not baked in at startup ------------------
    // Driven from the large-estimate case, because the floor (64 MB) is above the
    // estimate at every short duration -- a threshold below that estimate does not
    // exist, so the check would be unsatisfiable there.
    await evaluate(setDuration(300))
    await evaluate(setQuality('highest'))
    const big = await call(estimate())

    await evaluate(setMemoryWarnMb(1024))
    const aboveThreshold = await call(estimate())
    check(
      'raising the threshold above the estimate silences the warning',
      aboveThreshold.warnMb === 1024 && aboveThreshold.exceeds === false,
      `warnMb=${aboveThreshold.warnMb} estimatedMb=${aboveThreshold.estimatedMb} exceeds=${aboveThreshold.exceeds}`,
    )

    await evaluate(setMemoryWarnMb(256))
    const belowThreshold = await call(estimate())
    check(
      'lowering the threshold below the estimate raises the warning again',
      belowThreshold.warnMb === 256 && belowThreshold.exceeds === true,
      `warnMb=${belowThreshold.warnMb} estimatedMb=${belowThreshold.estimatedMb} exceeds=${belowThreshold.exceeds}`,
    )

    // The two together are what make it "live": same estimate, opposite answers.
    check(
      'the same estimate warns or not purely on the threshold',
      aboveThreshold.estimatedMb === belowThreshold.estimatedMb &&
        aboveThreshold.exceeds !== belowThreshold.exceeds,
      `${aboveThreshold.estimatedMb} MB: ${aboveThreshold.exceeds} at 1024, ${belowThreshold.exceeds} at 256`,
    )

    // --- the threshold is validated -------------------------------------------
    const rejected = await call(`window.electronAPI.setMemoryWarnMb(1).then(r=>JSON.stringify(r))`)
    check('a threshold below the floor is rejected', rejected.success === false, JSON.stringify(rejected))
    const tooBig = await call(`window.electronAPI.setMemoryWarnMb(999999).then(r=>JSON.stringify(r))`)
    check('a threshold above the ceiling is rejected', tooBig.success === false, JSON.stringify(tooBig))
    const notANumber = await call(`window.electronAPI.setMemoryWarnMb('512').then(r=>JSON.stringify(r))`)
    check('a non-numeric threshold is rejected', notANumber.success === false, JSON.stringify(notANumber))
  } finally {
    for (const [expr, label] of [
      [setQuality(saved.quality), 'quality'],
      [setDuration(saved.duration), 'duration'],
      [setMemoryWarnMb(saved.warnMb), 'warnMb'],
    ]) {
      await evaluate(expr).catch(() => console.log(`  (could not restore ${label})`))
    }
    console.log('settings restored')
  }

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
}