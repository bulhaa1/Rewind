/**
 * Profiles test.
 *
 * Runs Rewind with `REWIND_SELFTEST_PROFILES=1`, which checks the tier a switch needs,
 * that a switch writes the profile's values into the live settings, that editing a
 * setting lands in the active profile, and that a paused buffer stays paused.
 *
 * Run with:  npm run test:profiles
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const OUT = path.join(os.tmpdir(), 'rewind-profiles-test')
// A fresh profile per run: a lingering helper process holds files in the old one, and
// the cleanup failure used to fail the whole test before the app even started.
const PROFILE = path.join(OUT, `profile-${Date.now()}`)
// The clips the selftest records go somewhere else: it clears that directory at the
// start, and pointing it at the profile's parent deleted the running app's own profile.
const CLIPS = path.join(OUT, `clips-${Date.now()}`)
const RESULT = path.join(os.tmpdir(), 'rewind-profiles-test.txt')

const line = (msg) => process.stdout.write(`${msg}\n`)

try {
  fs.rmSync(OUT, { recursive: true, force: true })
} catch {
  /* a previous run's profile is still locked; the new one is separate anyway */
}
fs.rmSync(RESULT, { force: true })
fs.mkdirSync(PROFILE, { recursive: true })

const electron = require('electron')
const child = spawn(electron, ['.', `--user-data-dir=${PROFILE}`], {
  stdio: ['ignore', 'inherit', 'inherit'],
  cwd: projectRoot,
  env: { ...process.env, REWIND_SELFTEST_PROFILES: '1', REWIND_SELFTEST_OUT: CLIPS },
})

let exitCode = 0
const guard = setTimeout(() => {
  line('\nTIMEOUT: killing Rewind')
  child.kill()
  exitCode = 1
}, 300_000)

child.on('exit', (code) => {
  clearTimeout(guard)
  line(`\nRewind exited with code ${code}`)
  line('\n================ PROFILES REPORT ================')
  if (!fs.existsSync(RESULT)) {
    line(`FAIL: ${RESULT} was never written`)
    process.exit(1)
  }
  const results = fs.readFileSync(RESULT, 'utf8').split('\n').filter(Boolean)
  for (const r of results) line(r)
  const failed = results.filter((r) => r.startsWith('FAIL')).length
  line(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed === 0 && code === 0 ? 0 : 1)
})
