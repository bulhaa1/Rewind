/**
 * Updater-cache probe.
 *
 * Seeds the directory electron-updater downloads into, starts the app, and checks the
 * app cleared it. The directory is shared with the installed build on purpose: that is
 * where the leftovers accumulate, and the point is that the app cleans it on start.
 *
 * Run with:  npm run test:update-cache
 *
 * The seed files are small. Anything already in the directory -- measured at 379 MB on
 * this machine, two copies of the 1.1.0 installer -- is deleted along with them, which
 * is the behaviour being tested.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const PROFILE = path.join(os.tmpdir(), 'rewind-update-cache', 'profile')
const CACHE = path.join(process.env.LOCALAPPDATA ?? '', 'rewind-desktop-updater')
const PENDING = path.join(CACHE, 'pending')

function line(msg) {
  process.stdout.write(`${msg}\n`)
}

function measure(dir) {
  let files = 0
  let bytes = 0
  const walk = (d) => {
    if (!fs.existsSync(d)) return
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) walk(full)
      else {
        files++
        bytes += fs.statSync(full).size
      }
    }
  }
  walk(dir)
  return { files, bytes }
}

const before = measure(CACHE)
line(`cache: ${CACHE}`)
line(`before: ${before.files} file(s), ${(before.bytes / 1024 / 1024).toFixed(1)} MB`)

// Seed the two-copy shape an update leaves behind, plus the blockmap at the root.
// Seeding overwrites whatever is already there, so say so: those bytes are a real
// leftover, not something this test created. The seeds are aged, because the prune
// deliberately leaves anything modified in the last five minutes alone -- that is what
// stops it deleting a download in flight.
const AGE_MS = 30 * 60_000
const age = (file) => {
  const when = (Date.now() - AGE_MS) / 1000
  fs.utimesSync(file, when, when)
}
fs.mkdirSync(PENDING, { recursive: true })
for (const [file, size] of [
  [path.join(CACHE, 'installer.exe'), 2 * 1024 * 1024],
  [path.join(CACHE, 'current.blockmap'), 4],
  [path.join(PENDING, 'Rewind-1.1.0-setup.exe'), 3 * 1024 * 1024],
  [path.join(PENDING, 'update-info.json'), 16],
]) {
  if (fs.existsSync(file)) {
    line(`note: seeding over ${path.basename(file)} (${(fs.statSync(file).size / 1024 / 1024).toFixed(1)} MB)`)
  }
  fs.writeFileSync(file, Buffer.alloc(size, 7))
  age(file)
}
age(PENDING)
age(CACHE)

// One fresh file, to pin the other half of the rule: a download in flight must survive.
const FRESH = path.join(PENDING, 'fresh-download.tmp')
fs.writeFileSync(FRESH, Buffer.alloc(1024 * 1024, 7))

fs.rmSync(PROFILE, { recursive: true, force: true })
fs.mkdirSync(PROFILE, { recursive: true })

const electron = require('electron')
const child = spawn(electron, ['.', `--user-data-dir=${PROFILE}`], {
  stdio: ['ignore', 'inherit', 'inherit'],
  cwd: projectRoot,
  env: { ...process.env },
})

const LOG = path.join(PROFILE, 'logs', 'main.log')
let exitCode = 0

const guard = setTimeout(() => {
  line('\nTIMEOUT: killing Rewind')
  child.kill()
}, 120_000)

child.on('exit', () => {
  clearTimeout(guard)
  report()
  process.exit(exitCode)
})

/** Waits for the app to say it pruned, or for the timeout. */
async function waitForPrune(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fs.existsSync(LOG) && /Update cache pruned/.test(fs.readFileSync(LOG, 'utf8'))) return true
    if (!fs.existsSync(CACHE)) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

function report() {
  line('\n============== UPDATE CACHE REPORT ===============')

  const after = measure(CACHE)
  line(`after:  ${after.files} file(s), ${(after.bytes / 1024 / 1024).toFixed(1)} MB`)

  const freed = before.bytes - after.bytes
  // The aged seeds go; the fresh file stays. That is the whole rule: leftovers from a
  // previous update are cleared, a download in flight is not touched.
  const freshKept = fs.existsSync(FRESH)
  const staleGone = !fs.existsSync(path.join(CACHE, 'installer.exe')) && !fs.existsSync(path.join(PENDING, 'Rewind-1.1.0-setup.exe'))
  line(`${staleGone ? 'PASS' : 'FAIL'}  aged leftovers pruned`)
  line(`${freshKept ? 'PASS' : 'FAIL'}  a download in flight was left alone`)
  if (!staleGone || !freshKept) exitCode = 1
  line(`      ${(freed / 1024 / 1024).toFixed(1)} MB freed, ${after.files} file(s) left`)

  if (fs.existsSync(LOG)) {
    const log = fs.readFileSync(LOG, 'utf8')
    const pruned = /Update cache pruned[^\n]*/.exec(log)
    line(pruned ? `PASS  logged: ${pruned[0]}` : 'FAIL  no prune line in the log')
    if (!pruned) exitCode = 1
  }
}

if (!(await waitForPrune(60_000))) {
  line('the app never reported pruning the cache')
}
child.kill()
