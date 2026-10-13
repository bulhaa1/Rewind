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
// leftover, not something this test created.
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
}

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
  const ok = after.files === 0
  line(`${ok ? 'PASS' : 'FAIL'}  cache emptied (${(freed / 1024 / 1024).toFixed(1)} MB freed)`)
  if (!ok) {
    exitCode = 1
    for (const e of fs.readdirSync(CACHE, { recursive: true })) line(`  left: ${e}`)
  }

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
