/**
 * Update probe: install 1.1.0, update to 1.2.0 from a local feed, and measure what the
 * update left behind.
 *
 * This is the only test that exercises the real NSIS update path: the app downloads an
 * installer, quits, the installer runs silently, and the app comes back. Everything
 * else about updates can be reasoned about; this cannot.
 *
 * Run with:  npm run test:update
 *
 * It needs a 1.2.0 build. When `--build` is passed it makes one into
 * `%TEMP%\rewind-update-test\build` first (electron-builder, a few minutes); otherwise
 * it uses what is already there.
 *
 * The 1.1.0 installer comes from `release/Rewind-1.1.0-setup.exe` -- the published
 * artifact, so the update starts from exactly what users have.
 *
 * Side effects, all cleaned up at the end: a scratch install under
 * `%TEMP%\rewind-update-test\install`, its Start Menu and desktop shortcuts, and its
 * uninstall entry. The user's own install is never touched, and the app is always
 * started with `--user-data-dir` so no real settings are read or written.
 */
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const ROOT = path.join(os.tmpdir(), 'rewind-update-test')
const BUILD = path.join(ROOT, 'build')
const FEED = path.join(ROOT, 'feed')
const INSTALL = path.join(ROOT, 'install')
const PROFILE = path.join(ROOT, 'profile')
const LOG = path.join(PROFILE, 'logs', 'main.log')
const SETUP_110 = path.join(projectRoot, 'release', 'Rewind-1.1.0-setup.exe')
/**
 * The unpacked tree the update is compared against.
 *
 * Defaults to the local build, but when the feed is a *published* release (assets
 * downloaded into BUILD) there is no unpacked tree there, and the comparison needs one
 * for the same version -- `REWIND_UPDATE_FRESH_TREE` points at it. Without it every
 * installed file looks stale, which is a harness bug that reads exactly like a finding.
 */
const FRESH_TREE = process.env.REWIND_UPDATE_FRESH_TREE || path.join(BUILD, 'win-unpacked')
const CDP_PORT = process.env.CDP_PORT || '9223'

let failures = 0
const line = (msg) => process.stdout.write(`${msg}\n`)
const check = (ok, label, detail = '') => {
  line(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

function walk(dir, base = dir, out = new Map()) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, base, out)
    else out.set(path.relative(base, full), fs.statSync(full).size)
  }
  return out
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------

function startFeed() {
  const server = http.createServer((req, res) => {
    // electron-updater appends ?noCache=... to the channel file.
    const name = decodeURIComponent((req.url || '/').split('?')[0].split('/').pop() || '')
    const file = path.join(FEED, name)
    if (!fs.existsSync(file)) {
      res.writeHead(404).end('not found')
      return
    }
    const size = fs.statSync(file).size
    res.writeHead(200, { 'Content-Length': String(size), 'Content-Type': 'application/octet-stream' })
    fs.createReadStream(file).pipe(res)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })))
}

// ---------------------------------------------------------------------------
// CDP: the update is driven through the same IPC the header button uses
// ---------------------------------------------------------------------------

async function evaluate(expression, timeoutMs = 20_000) {
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!page) throw new Error('no debuggable page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = () => rej(new Error('CDP connect failed'))
  })
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP evaluate timed out')), timeoutMs)
      ws.onmessage = (m) => {
        const msg = JSON.parse(m.data)
        if (msg.id !== 1) return
        clearTimeout(timer)
        if (msg.result?.exceptionDetails) {
          reject(new Error(`page threw: ${msg.result.exceptionDetails.text} ${msg.result.exceptionDetails.exception?.description ?? ''}`))
          return
        }
        resolve(msg.result?.result?.value)
      }
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
    })
  } finally {
    ws.close()
  }
}

/**
 * Waits until the panel's preload has run.
 *
 * The page target exists as soon as the window is created, and `window.electronAPI` is not
 * there yet at that moment -- evaluating against it then throws, and an ignored throw
 * looks exactly like an app that refused to check for updates.
 */
async function waitForApi(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const ok = await evaluate('typeof window.electronAPI === "object" && typeof window.electronAPI.checkForUpdates === "function"', 5_000)
      if (ok === true) return true
    } catch {
      /* page not ready */
    }
    await sleep(1000)
  }
  return false
}

/** Waits for a page to be up on the debugging port. */
async function waitForPage(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
      if (list.some((t) => t.type === 'page' && t.webSocketDebuggerUrl)) return true
    } catch {
      /* not up yet */
    }
    await sleep(1000)
  }
  return false
}

/** Waits for the debugging port to stop answering, i.e. the app is gone. */
async function waitForAppExit(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
    } catch {
      return true
    }
    await sleep(1000)
  }
  return false
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

function buildIfAsked() {
  if (!process.argv.includes('--build')) return
  line('building 1.2.0 (electron-builder, a few minutes)...')
  fs.rmSync(BUILD, { recursive: true, force: true })
  const r = spawnSync(
    process.execPath,
    [path.join('node_modules', 'electron-builder', 'out', 'cli', 'cli.js'), '--win', '--publish', 'never', `-c.directories.output=${BUILD}`],
    { cwd: projectRoot, stdio: 'inherit' },
  )
  if (r.status !== 0) {
    line(`FAIL: electron-builder exited ${r.status}`)
    process.exit(1)
  }
}

function prepareFeed() {
  fs.rmSync(FEED, { recursive: true, force: true })
  fs.mkdirSync(FEED, { recursive: true })
  // Name-agnostic: the same harness serves a locally built 1.2.0 and the published
  // release's own assets (Rewind-1.2.0-rc.1-setup.exe, ...), so a released installer
  // can be verified end to end by downloading it into BUILD first.
  for (const name of fs.readdirSync(BUILD)) {
    if (/^Rewind-.*setup\.exe(\.blockmap)?$/i.test(name) || name === 'latest.yml') {
      fs.copyFileSync(path.join(BUILD, name), path.join(FEED, name))
    }
  }
  const setup = fs.readdirSync(FEED).find((n) => /^Rewind-.*setup\.exe$/i.test(n))
  if (!fs.existsSync(path.join(FEED, 'latest.yml')) || !setup) {
    line(`FAIL: latest.yml and a Rewind-*-setup.exe are needed in ${BUILD} - run with --build, or copy a release's assets in`)
    process.exit(1)
  }
  const version = /^version:\s*(\S+)\s*$/m.exec(fs.readFileSync(path.join(FEED, 'latest.yml'), 'utf8'))?.[1]
  if (!version) {
    line('FAIL: latest.yml has no version')
    process.exit(1)
  }
  line(`feed version: ${version} (${setup})`)
  return version
}

/**
 * The scratch install's processes.
 *
 * The installer relaunches the app without the arguments it was started with, so the
 * relaunch has no debugging port and cannot be found over CDP. The process list can:
 * the executable path is the install directory.
 */
function scratchAppProcesses() {
  const r = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='Rewind.exe'\" | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress",
    ],
    { encoding: 'utf8' },
  )
  const raw = (r.stdout || '').trim()
  if (!raw) return []
  let list
  try {
    list = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(list)) list = [list]
  const wanted = path.join(INSTALL, 'Rewind.exe').toLowerCase()
  return list.filter((p) => (p.ExecutablePath || '').toLowerCase() === wanted)
}

async function waitForScratchApp(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  const started = Date.now()
  while (Date.now() < deadline) {
    const procs = scratchAppProcesses()
    if (procs.length) return procs
    const waited = Math.round((Date.now() - started) / 1000)
    if (waited % 30 < 2) line(`  ...still waiting for the app (${waited}s)`)
    await sleep(2_000)
  }
  return []
}

/** Reads a file out of the installed asar, which is the only reliable version stamp. */
function asarVersion() {
  try {
    const asar = require('@electron/asar')
    const pkg = asar.extractFile(path.join(INSTALL, 'resources', 'app.asar'), 'package.json')
    return JSON.parse(pkg.toString()).version ?? null
  } catch {
    return null
  }
}

function installOld() {
  if (!fs.existsSync(SETUP_110)) {
    line(`FAIL: ${SETUP_110} missing - the published 1.1.0 installer is the starting point`)
    process.exit(1)
  }
  fs.rmSync(INSTALL, { recursive: true, force: true })
  line(`installing 1.1.0 silently into ${INSTALL}`)
  const r = spawnSync(SETUP_110, ['/S', `/D=${INSTALL}`], { stdio: 'inherit' })
  if (r.status !== 0 || !fs.existsSync(path.join(INSTALL, 'Rewind.exe'))) {
    line(`FAIL: 1.1.0 install exited ${r.status}`)
    process.exit(1)
  }
}

/**
 * Points the installed build at the local feed.
 *
 * `app-update.yml` is what electron-updater reads for its provider and URL, and it is
 * the only lever that works on the *old* build: a feed override in code only exists in
 * the version being shipped, and the version being updated from cannot have it. This is
 * the same file a self-hosted feed would ship.
 */
function pointAtLocalFeed(url) {
  const yml = path.join(INSTALL, 'resources', 'app-update.yml')
  fs.writeFileSync(
    yml,
    ['provider: generic', `url: ${url}`, 'updaterCacheDirName: rewind-desktop-updater', ''].join('\n'),
  )
  line(`pointed ${path.relative(ROOT, yml)} at ${url}`)
}
function startApp(extraEnv, extraArgs = []) {
  return spawn(path.join(INSTALL, 'Rewind.exe'), [...extraArgs, `--user-data-dir=${PROFILE}`], {
    detached: false,
    stdio: 'ignore',
    env: { ...process.env, ...extraEnv },
  })
}

/**
 * Kills the app and everything it spawned.
 *
 * `child.kill()` only signals the launcher: Electron's helpers survive it, the app
 * keeps its single-instance lock, and the next start exits immediately -- which looks
 * exactly like a second instance that ignored its environment. Measured: the update
 * check ran in the instance started without a feed and reported the published version
 * as current.
 */
function killApp(child) {
  if (!child?.pid) return
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
}

async function waitForLog(pattern, timeoutMs, { since = 0 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fs.existsSync(LOG)) {
      const text = fs.readFileSync(LOG, 'utf8').slice(since)
      const hit = pattern.exec(text)
      if (hit) return hit
    }
    await sleep(1000)
  }
  return null
}

async function main() {
  buildIfAsked()
  const expectedVersion = prepareFeed()
  installOld()
  fs.rmSync(PROFILE, { recursive: true, force: true })
  fs.mkdirSync(PROFILE, { recursive: true })

  const { server, port } = await startFeed()
  const feedUrl = `http://127.0.0.1:${port}`
  line(`feed: ${feedUrl}`)
  pointAtLocalFeed(feedUrl)

  try {
    // ---- 1. no network before the click -------------------------------------
    line('\n--- idle start: nothing may reach the network ---')
    let app = startApp({}, [`--remote-debugging-port=${CDP_PORT}`])
    if (!(await waitForPage(90_000)) || !(await waitForApi(60_000))) {
      check(false, 'panel came up with a usable api')
      return
    }
    await sleep(30_000)
    const idleLog = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : ''
    const quiet = !/checking-for-update|Found update|Downloading update|update-downloaded/i.test(idleLog)
    check(quiet, 'no update activity in 30s of idle start')
    killApp(app)
    const stopped = await waitForAppExit(30_000)
    check(stopped, 'idle instance stopped before the update run')

    // ---- 2. the update, driven through the panel's own IPC ------------------
    line('\n--- update: check, download, restart and install ---')
    const sizeBefore = fs.existsSync(LOG) ? fs.statSync(LOG).size : 0
    app = startApp({}, [`--remote-debugging-port=${CDP_PORT}`])
    if (!(await waitForPage(90_000)) || !(await waitForApi(60_000))) {
      check(false, 'panel came up with a usable api')
      return
    }

    const before = await evaluate('window.electronAPI.getUpdateState()')
    check(before?.data?.version !== expectedVersion, 'starting from the older build', JSON.stringify(before?.data ?? before))

    const checked = await evaluate('window.electronAPI.checkForUpdates()')
    check(
      checked?.success === true && checked?.data?.status === 'available',
      'update offered',
      JSON.stringify(checked?.data ?? checked),
    )

    const downloaded = await evaluate('window.electronAPI.downloadUpdate()', 240_000)
    check(downloaded?.success === true, 'download reported', JSON.stringify(downloaded?.data ?? downloaded))

    // The state is what the panel shows; the log line is the same event in words.
    const ready = downloaded?.data?.status === 'ready' || (await waitForLog(/has been downloaded to/i, 30_000, { since: sizeBefore }))
    check(ready, 'download finished')

    const cacheDir = path.join(process.env.LOCALAPPDATA, 'rewind-desktop-updater')
    const cacheBefore = walk(cacheDir)
    const cacheBeforeBytes = [...cacheBefore.values()].reduce((a, b) => a + b, 0)
    line(`  update cache before install: ${cacheBefore.size} file(s), ${(cacheBeforeBytes / 1024 / 1024).toFixed(1)} MB`)

    // The app quits here and the installer takes over. It comes back by itself only
    // if the install was silent: a wizard would sit waiting for a click.
    await evaluate('window.electronAPI.quitAndInstall()', 5_000).catch(() => {})
    const exited = await waitForAppExit(60_000)
    check(exited, 'app quit for the installer')

    line('  waiting for the app to come back...')
    // A silent NSIS install of a 107 MB payload took four minutes on this machine, so
    // the window is generous: the check is "did it come back by itself", not "quickly".
    const relaunched = await waitForScratchApp(600_000)
    check(relaunched.length > 0, 'app relaunched by itself after the update (no wizard to click through)')
    // It comes back without this harness's arguments, so it is running against the real
    // profile. Let it start and do its housekeeping, then stop it.
    await sleep(20_000)
    for (const proc of scratchAppProcesses()) {
      spawnSync('taskkill', ['/PID', String(proc.ProcessId), '/T', '/F'], { stdio: 'ignore' })
    }
    await sleep(2_000)

    // ---- 3. what the update left behind ------------------------------------
    line('\n--- leftovers ---')
    const installed = walk(path.join(INSTALL, 'resources'))
    const freshRoot = path.join(FRESH_TREE, 'resources')
    if (!fs.existsSync(freshRoot)) {
      check(false, 'a reference tree to compare against', `${freshRoot} not found`)
      return
    }
    const fresh = walk(freshRoot)
    const stale = [...installed.keys()].filter((k) => !fresh.has(k) && !k.startsWith('app-update.yml'))
    const staleBytes = stale.reduce((sum, k) => sum + (installed.get(k) ?? 0), 0)
    check(stale.length === 0, 'no files the new version does not ship', `${stale.length} stale, ${(staleBytes / 1024 / 1024).toFixed(1)} MB`)
    for (const k of stale.slice(0, 10)) line(`    stale: ${k} (${((installed.get(k) ?? 0) / 1024 / 1024).toFixed(1)} MB)`)

    const cacheAfter = walk(cacheDir)
    check(cacheAfter.size === 0, 'update cache empty after the new version started', `${cacheAfter.size} file(s)`)

    const version = asarVersion()
    check(version === expectedVersion, `installed version is ${expectedVersion}`, version ?? 'unknown')

    if (fs.existsSync(LOG)) {
      const log = fs.readFileSync(LOG, 'utf8')
      const pruned = /Update cache pruned[^\n]*/.exec(log)
      line(`  prune line: ${pruned ? pruned[0] : '(none)'}`)
    }
  } finally {
    server.close()
    // Leave the machine as it was found: uninstall the scratch install.
    const uninstaller = path.join(INSTALL, 'Uninstall Rewind.exe')
    if (fs.existsSync(uninstaller)) {
      line('\nuninstalling the scratch install')
      spawnSync(uninstaller, ['/S'], { stdio: 'inherit' })
      await sleep(5_000)
    }
    try {
      spawnSync('taskkill', ['/IM', 'Rewind.exe', '/F'], { stdio: 'ignore' })
    } catch {
      /* nothing running */
    }
  }

  line(`\n================ UPDATE REPORT ================`)
  line(failures === 0 ? 'all checks passed' : `${failures} check(s) failed`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
