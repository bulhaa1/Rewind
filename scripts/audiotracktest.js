/**
 * End-to-end test for separate audio tracks.
 *
 * Records with the default configuration while a known tone plays through the
 * default output device, then measures the saved file: how many audio streams it
 * has, and how loud each one is.
 *
 *   node scripts/audiotracktest.js         # default: mix + desktop + microphone
 *   node scripts/audiotracktest.js absent  # no capturable mic: mix + desktop only
 *
 * The two runs are judged by opposite counts, and both can fail. The `absent`
 * case is what proves the microphone gate is a real condition rather than a
 * constant: a gate that always set the bit would also produce three streams.
 *
 * Stream count alone is the pass/fail gate. Two streams that measure the same loudness
 * are a failed split, not a pass, so both numbers are printed together and the split
 * has to be judged from them. A silent machine produces two identical zeros either way,
 * which is why the tone is played: the desktop track should measure well above the
 * microphone track.
 */
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const require = createRequire(import.meta.url)
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// The absent-microphone run gets its own directory so it cannot be mistaken for
// the real one, or overwrite its report.
const MIC_ABSENT = process.argv[2] === 'absent'
const OUT = MIC_ABSENT
  ? path.join(os.tmpdir(), 'rewind-audiotracktest-absent')
  : path.join(os.tmpdir(), 'rewind-audiotracktest')
const TONE = path.join(OUT, 'tone.wav')
const REPORT = path.join(OUT, 'audiotracks-report.json')
const DONE = path.join(OUT, 'AUDIOTRACKS_DONE')

const TONE_SECONDS = 16

const ffmpeg = path.join(projectRoot, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe')
const ffprobe = path.join(projectRoot, 'node_modules', 'ffprobe-static', 'bin', 'win32', 'x64', 'ffprobe.exe')
const electron = require('electron')

const log = (m) => console.log(m)

function reset() {
  fs.rmSync(OUT, { recursive: true, force: true })
  fs.mkdirSync(OUT, { recursive: true })
  execFileSync(
    ffmpeg,
    ['-y', '-f', 'lavfi', '-i', `sine=frequency=1000:sample_rate=44100:duration=${TONE_SECONDS}`, '-ac', '2', TONE],
    { stdio: 'ignore' },
  )
}

const waitFor = async (file, label, limitSeconds) => {
  for (let i = 0; i < limitSeconds; i++) {
    if (fs.existsSync(file)) return true
    await new Promise((r) => setTimeout(r, 1000))
  }
  log(`TIMEOUT waiting for ${label}`)
  return false
}

/** Plays the tone through the default playback device, non-blocking. */
function playTone() {
  return new Promise((resolve) => {
    // SoundPlayer is the only non-interactive WAV player available without a dependency.
    const ps = spawn(
      'powershell.exe',
      ['-NoProfile', '-Command', `(New-Object Media.SoundPlayer '${TONE}').PlaySync()`],
      { stdio: 'ignore' },
    )
    ps.on('exit', resolve)
  })
}

let childCode = 0

const child = spawn(electron, ['.'], {
  stdio: ['ignore', 'inherit', 'inherit'],
  cwd: projectRoot,
  env: {
    ...process.env,
    REWIND_SELFTEST_AUDIOTRACKS: '1',
    REWIND_SELFTEST_MIC: MIC_ABSENT ? 'absent' : 'present',
    REWIND_SELFTEST_OUT: OUT,
    REWIND_SELFTEST_AUDIO: '1',
  },
})

const timer = setTimeout(() => {
  log('TIMEOUT (180s): killing Rewind')
  child.kill()
}, 180_000)

child.on('exit', (code) => {
  clearTimeout(timer)
  childCode = code ?? 1
  report()
})

async function main() {
  reset()
  log(`output directory: ${OUT}`)

  if (await waitFor(path.join(OUT, 'PLAY_TONE'), 'tone cue', 120)) {
    log('playing tone during the recording window...')
    await playTone()
  }

  await waitFor(DONE, 'the audio track report', 120)
}

main()

function report() {
  log('\n============ AUDIO TRACK TEST REPORT ============')

  if (!fs.existsSync(REPORT)) {
    const done = fs.existsSync(DONE) ? fs.readFileSync(DONE, 'utf8') : 'nothing'
    log(`FAIL: no audiotracks-report.json was written (${done})`)
    process.exit(childCode || 2)
  }

  const r = JSON.parse(fs.readFileSync(REPORT, 'utf8'))
  log(`micAbsent=${r.micAbsent}`)
  log(JSON.stringify(r, null, 2))

  // The app's own numbers, plus the raw container layout behind them.
  const clip = fs.readFileSync(DONE, 'utf8')
  if (clip.startsWith('ERROR:')) {
    log(`\nFAIL: recording errored -> ${clip.slice(6)}`)
    process.exit(2)
  }

  log(`\nclip: ${clip}`)
  if (fs.existsSync(clip)) {
    const meta = JSON.parse(
      execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', clip], { encoding: 'utf8' }),
    )
    log(`  duration=${Number(meta.format?.duration ?? 0).toFixed(2)}s  size=${(fs.statSync(clip).size / 1024 / 1024).toFixed(2)} MB`)
    for (const s of meta.streams || []) {
      log(`  stream ${s.index}: ${s.codec_type} ${s.codec_name}${s.channels ? ` ${s.channels}ch` : ''}${s.width ? ` ${s.width}x${s.height}` : ''} tags=${JSON.stringify(s.tags ?? {})}`)
    }
  }

  log('')
  // The two runs are judged by opposite expectations and both can fail. The verdict is
  // derived here from the report rather than taken from the child's exit code alone:
  // this script is the gate, and a gate that only forwards someone else's opinion of
  // the evidence reverts to a rubber stamp the moment that opinion changes.
  let verdict
  if (r.measurementFailed) {
    log('FAIL: at least one stream could not be measured, so the volumes above are not evidence either way')
    verdict = 2
  } else if (r.micAbsent) {
    // Without a capturable microphone the file must carry exactly two streams --
    // mix and desktop -- and no third. This is what proves the gate is a real
    // condition: a constant microphone bit would also produce three here.
    log(
      r.streamCount === 2
        ? 'PASS: no capturable microphone produced exactly 2 audio streams'
        : `FAIL: no capturable microphone produced ${r.streamCount} audio stream(s), expected 2`,
    )
    verdict = r.streamCount === 2 ? 0 : 1
  } else {
    log(
      r.streamCount >= 3
        ? `PASS: split tracks produced ${r.streamCount} audio streams`
        : `FAIL: split tracks produced ${r.streamCount} audio stream(s), expected at least 3`,
    )
    verdict = r.streamCount >= 3 ? 0 : 1
  }

  // Not a gate. Identical volumes mean the tracks carry the same content, which the
  // stream count alone cannot distinguish from a split that worked.
  if (!r.micAbsent && r.streamCount >= 2 && !r.measurementFailed) {
    const known = r.meanVolumes.filter((v) => typeof v === 'number')
    const spread = known.length >= 2 ? Math.max(...known) - Math.min(...known) : null
    log(
      spread === null
        ? 'NOTE: fewer than two streams reported a measurable volume, so the split cannot be judged from loudness'
        : `NOTE: per-stream volume spread = ${spread.toFixed(1)} dB (judge the split from this, not from the count)`,
    )
  }

  // A child that reported a harness error never got to judge anything, so its code
  // outranks a verdict derived from a report it may not have finished writing.
  // Otherwise the worst of the two stands, so a non-zero from either side fails.
  process.exit(childCode === 2 ? 2 : verdict === 0 ? childCode : verdict)
}
