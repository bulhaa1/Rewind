/**
 * Display-canvas test.
 *
 * Runs Rewind with `REWIND_SELFTEST_DISPLAY=1`, which forces the OBS canvas to a
 * size the display is not and saves one clip per phase. A clip's dimensions are
 * the only honest readback of which canvas OBS actually rendered, so this probes
 * them and decides.
 *
 * Expected:
 *   with-buffer     the display's size  - the reset was refused while the output was live
 *   without-buffer  half the display's  - the reset applies once nothing holds the context
 *   after-fix       the display's size  - the display-change path restarts the chain around it
 *
 * Run with:  npm run test:display
 */
import { spawn, execFileSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const OUT = path.join(os.tmpdir(), 'rewind-display-test')
// A fresh profile per run: a lingering helper process holds files in the old one.
const PROFILE = path.join(OUT, `profile-${Date.now()}`)
const LOG = path.join(PROFILE, 'logs', 'main.log')
const FFPROBE = path.join(projectRoot, 'node_modules', 'ffprobe-static', 'bin', 'win32', 'x64', 'ffprobe.exe')

function line(msg) {
  process.stdout.write(`${msg}\n`)
}

/** The video stream's dimensions, or null when the file has none. */
function dimensions(file) {
  const out = execFileSync(
    FFPROBE,
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', file],
    { encoding: 'utf8' },
  )
  const stream = (JSON.parse(out).streams || [])[0]
  return stream?.width && stream?.height ? { width: stream.width, height: stream.height } : null
}

try {
  fs.rmSync(OUT, { recursive: true, force: true })
} catch {
  /* a previous run's profile is still locked; the new one is separate anyway */
}
fs.mkdirSync(PROFILE, { recursive: true })

const electron = require('electron')
const child = spawn(electron, ['.', `--user-data-dir=${PROFILE}`], {
  stdio: ['ignore', 'inherit', 'inherit'],
  cwd: projectRoot,
  env: { ...process.env, REWIND_SELFTEST_DISPLAY: '1', REWIND_SELFTEST_OUT: OUT },
})

let exitCode = 0

// Hard stop: a wedged OBS child must not hang the suite. Six phases, five saves and
// several chain restarts, so the budget is generous.
const guard = setTimeout(() => {
  line('\nTIMEOUT: killing Rewind')
  child.kill()
  exitCode = 1
}, 360_000)

child.on('exit', (code) => {
  clearTimeout(guard)
  line(`\nRewind exited with code ${code}`)
  report()
  process.exit(exitCode)
})

function report() {
  line('\n================ DISPLAY TEST REPORT ================')

  const resultPath = path.join(OUT, 'result.json')
  if (!fs.existsSync(resultPath)) {
    line(`FAIL: ${resultPath} was never written`)
    exitCode = 1
    tailLog()
    return
  }

  const { real, half, clips, recording, pausedAfterChange, activeAfterConcurrent } = JSON.parse(
    fs.readFileSync(resultPath, 'utf8'),
  )
  line(`display: ${real.width}x${real.height}   forced: ${half.width}x${half.height}`)

  const check = (label, expected) => {
    const file = clips[label]
    if (!file || !fs.existsSync(file)) {
      line(`FAIL  ${label}: no clip (${file ?? 'missing'})`)
      exitCode = 1
      return
    }
    let got = null
    try {
      got = dimensions(file)
    } catch (e) {
      line(`FAIL  ${label}: ffprobe failed: ${e.message}`)
      exitCode = 1
      return
    }
    const ok = got && got.width === expected.width && got.height === expected.height
    line(
      `${ok ? 'PASS' : 'FAIL'}  ${label}: ${got ? `${got.width}x${got.height}` : 'no video stream'} ` +
        `(expected ${expected.width}x${expected.height})`,
    )
    if (!ok) exitCode = 1
  }

  check('with-buffer', real)
  check('without-buffer', half)
  check('after-fix', real)
  check('after-paused', real)
  check('after-concurrent', real)

  // A recording that was in flight when the display changed must have been finished
  // and registered, not dropped on the floor.
  const finished = recording ?? {}
  if (!finished.path || !(finished.bytes > 0)) {
    line(`FAIL  recording: not finished across the change (${finished.path ?? 'none'}, ${finished.bytes ?? 0} bytes)`)
    exitCode = 1
  } else {
    line(`PASS  recording: finished and registered (${(finished.bytes / 1024 / 1024).toFixed(1)} MB)`)
  }

  if (pausedAfterChange !== true) {
    line('FAIL  paused: a display change resumed a buffer the user had paused')
    exitCode = 1
  } else {
    line('PASS  paused: still paused after the change')
  }

  if (activeAfterConcurrent !== true) {
    line('FAIL  concurrent: two display changes left the buffer stopped')
    exitCode = 1
  } else {
    line('PASS  concurrent: buffer still running')
  }

  if (exitCode !== 0) tailLog()
}

function tailLog() {
  if (!fs.existsSync(LOG)) {
    line(`\n(no log at ${LOG})`)
    return
  }
  const lines = fs.readFileSync(LOG, 'utf8').split('\n').filter((l) => /DISPLAY-TEST|reset|canvas|Replay buffer/.test(l))
  line('\nlog lines of interest:')
  for (const l of lines.slice(-40)) line(`  ${l}`)
}
