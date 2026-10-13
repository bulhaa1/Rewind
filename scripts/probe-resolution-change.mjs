/**
 * Real resolution-change probe.
 *
 * Changes the primary display's mode through Windows itself, watches the running app
 * react, and restores the original mode. The app half is `REWIND_SELFTEST_DISPLAY_WATCH`
 * (see runDisplayWatchSelfTest): it waits for the size to change, saves a clip, waits
 * for it to come back, and saves another. This script does the disruptive part and
 * then checks that each clip came out at the size the display had when it was saved.
 *
 * Run with:  npm run test:resolution
 *
 * It blanks the screen for a few seconds and moves windows. The original mode is
 * restored in a finally and on Ctrl+C, but a hard kill mid-run leaves the test mode
 * in place.
 */
import { spawn, execFileSync } from 'node:child_process'
import koffi from 'koffi'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const OUT = path.join(os.tmpdir(), 'rewind-display-watch')
const PROFILE = path.join(OUT, 'profile')
const FFPROBE = path.join(projectRoot, 'node_modules', 'ffprobe-static', 'bin', 'win32', 'x64', 'ffprobe.exe')

const DM_BITSPERPEL = 0x00040000
const DM_PELSWIDTH = 0x00080000
const DM_PELSHEIGHT = 0x00100000
const DM_DISPLAYFREQUENCY = 0x00400000

function line(msg) {
  process.stdout.write(`${msg}\n`)
}

// DEVMODEA: char[32] device name and form name, which is why it is 156 bytes and the
// W variant is 220. The A entry points are used throughout to match.
const DEVMODE = koffi.struct('DEVMODE', {
  dmDeviceName: koffi.array('char', 32),
  dmSpecVersion: 'uint16',
  dmDriverVersion: 'uint16',
  dmSize: 'uint16',
  dmDriverExtra: 'uint16',
  dmFields: 'uint32',
  dmOrientation: 'int16',
  dmPaperSize: 'int16',
  dmPaperLength: 'int16',
  dmPaperWidth: 'int16',
  dmScale: 'int16',
  dmCopies: 'int16',
  dmDefaultSource: 'int16',
  dmPrintQuality: 'int16',
  dmColor: 'int16',
  dmDuplex: 'int16',
  dmYResolution: 'int16',
  dmTTOption: 'int16',
  dmCollate: 'int16',
  dmFormName: koffi.array('char', 32),
  dmLogPixels: 'uint16',
  dmBitsPerPel: 'uint32',
  dmPelsWidth: 'uint32',
  dmPelsHeight: 'uint32',
  dmDisplayFlags: 'uint32',
  dmDisplayFrequency: 'uint32',
  dmICMMethod: 'uint32',
  dmICMIntent: 'uint32',
  dmMediaType: 'uint32',
  dmDitherType: 'uint32',
  dmReserved1: 'uint32',
  dmReserved2: 'uint32',
  dmPanningWidth: 'uint32',
  dmPanningHeight: 'uint32',
})

const user32 = koffi.load('user32.dll')
const EnumDisplaySettingsA = user32.func('bool __stdcall EnumDisplaySettingsA(const char *device, uint32 modeNum, _Inout_ DEVMODE *devMode)')
const ChangeDisplaySettingsExA = user32.func('int __stdcall ChangeDisplaySettingsExA(const char *device, _Inout_ DEVMODE *devMode, void *hwnd, uint32 flags, void *param)')

const DISPLAY_DEVICE = koffi.struct('DISPLAY_DEVICEA', {
  cb: 'uint32',
  DeviceName: koffi.array('char', 32),
  DeviceString: koffi.array('char', 128),
  StateFlags: 'uint32',
  DeviceID: koffi.array('char', 128),
  DeviceKey: koffi.array('char', 128),
})
const EnumDisplayDevicesA = user32.func('bool __stdcall EnumDisplayDevicesA(const char *device, uint32 devNum, _Inout_ DISPLAY_DEVICEA *displayDevice, uint32 flags)')

const DISPLAY_DEVICE_PRIMARY_DEVICE = 0x00000004

/**
 * The adapter Windows calls primary.
 *
 * Not `\\.\DISPLAY1`: the number is the order the driver registered adapters in, which
 * is not the order the user sees them in, and this machine's primary is not DISPLAY1.
 */
function primaryDevice() {
  for (let i = 0; i < 16; i++) {
    const dd = { cb: koffi.sizeof(DISPLAY_DEVICE) }
    if (!EnumDisplayDevicesA(null, i, dd, 0)) break
    if (dd.StateFlags & DISPLAY_DEVICE_PRIMARY_DEVICE) {
      return { name: String(dd.DeviceName).replace(/\0.*$/, ''), label: String(dd.DeviceString).replace(/\0.*$/, '') }
    }
  }
  return null
}

const primary = primaryDevice()
if (!primary) {
  line('FAIL: no primary display device reported')
  process.exit(1)
}
const DEVICE = primary.name

/** Every mode the adapter reports. 636 on the machine this was written on. */
function listModes() {
  const modes = []
  for (let i = 0; i < 4096; i++) {
    const dm = { dmDeviceName: DEVICE, dmSize: koffi.sizeof(DEVMODE), dmDriverExtra: 0 }
    if (!EnumDisplaySettingsA(DEVICE, i, dm)) break
    modes.push({ ...dm })
  }
  return modes
}

function applyMode(mode) {
  const dm = { ...mode, dmFields: DM_PELSWIDTH | DM_PELSHEIGHT | DM_BITSPERPEL | DM_DISPLAYFREQUENCY }
  const rc = ChangeDisplaySettingsExA(DEVICE, dm, null, 0, null)
  if (rc !== 0) throw new Error(`ChangeDisplaySettingsExA returned ${rc}`)
}

function dimensions(file) {
  const out = execFileSync(
    FFPROBE,
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', file],
    { encoding: 'utf8' },
  )
  const stream = (JSON.parse(out).streams || [])[0]
  return stream?.width && stream?.height ? { width: stream.width, height: stream.height } : null
}

const modes = listModes()
if (modes.length === 0) {
  line(`FAIL: no display modes reported for ${DEVICE}`)
  process.exit(1)
}

// Dry run: prove the enumeration without touching the display.
if (process.argv.includes('--list')) {
  line(`primary device: ${DEVICE} (${primary.label})`)
  const seen = new Set()
  for (const m of modes) {
    const key = `${m.dmPelsWidth}x${m.dmPelsHeight}@${m.dmDisplayFrequency}`
    if (seen.has(key)) continue
    seen.add(key)
    line(`${key} ${m.dmBitsPerPel}bpp fields=0x${m.dmFields.toString(16)}`)
  }
  process.exit(0)
}

// EnumDisplaySettings enumerates from the lowest mode up; the last one is the current
// desktop mode. (ENUM_CURRENT_SETTINGS would say so directly, but the list is already
// here and the last entry agrees with it.)
const current = modes[modes.length - 1]
const original = {
  width: current.dmPelsWidth,
  height: current.dmPelsHeight,
  bits: current.dmBitsPerPel,
  hz: current.dmDisplayFrequency,
}
line(`current mode: ${original.width}x${original.height} @ ${original.hz}Hz ${original.bits}bpp`)

// A different mode of the same colour depth. 1920x1080 when it exists -- a standard
// size the encoder is certain to accept -- otherwise the largest one smaller than the
// current, so the canvas change is unmistakable in the saved clip.
const candidates = modes
  .filter((m) => m.dmBitsPerPel === original.bits)
  .filter((m) => m.dmPelsWidth >= 1024 && m.dmPelsHeight >= 768)
  .filter((m) => m.dmPelsWidth !== original.width || m.dmPelsHeight !== original.height)
  .sort((a, b) => b.dmPelsWidth - a.dmPelsWidth)
const target = candidates.find((m) => m.dmPelsWidth === 1920 && m.dmPelsHeight === 1080) ?? candidates[0]
if (!target) {
  line('FAIL: no alternative mode of the same colour depth to switch to')
  process.exit(1)
}
line(`target mode:  ${target.dmPelsWidth}x${target.dmPelsHeight} @ ${target.dmDisplayFrequency}Hz`)

fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(PROFILE, { recursive: true })

const electron = require('electron')
const child = spawn(electron, ['.', `--user-data-dir=${PROFILE}`], {
  stdio: ['ignore', 'inherit', 'inherit'],
  cwd: projectRoot,
  env: { ...process.env, REWIND_SELFTEST_DISPLAY_WATCH: '1', REWIND_SELFTEST_OUT: OUT },
})

let exitCode = 0
let switched = false
const restore = () => {
  if (!switched) return
  switched = false
  try {
    applyMode(current)
    line(`restored ${original.width}x${original.height} @ ${original.hz}Hz`)
  } catch (e) {
    line(`FAIL: could not restore the original mode: ${e.message}`)
    exitCode = 1
  }
}
process.on('SIGINT', () => {
  restore()
  child.kill()
  process.exit(1)
})

const guard = setTimeout(() => {
  line('\nTIMEOUT: killing Rewind')
  child.kill()
  exitCode = 1
}, 420_000)

/** Waits for a line to appear in the app's log. */
async function waitForLog(pattern, timeoutMs) {
  const logPath = path.join(PROFILE, 'logs', 'main.log')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fs.existsSync(logPath) && pattern.test(fs.readFileSync(logPath, 'utf8'))) return true
    await new Promise((r) => setTimeout(r, 1000))
  }
  return false
}

child.on('exit', (code) => {
  clearTimeout(guard)
  restore()
  line(`\nRewind exited with code ${code}`)
  report()
  process.exit(exitCode)
})

async function drive() {
  // The app needs to boot, start the buffer and redirect its output first.
  if (!(await waitForLog(/DISPLAY-WATCH start=/, 90_000))) {
    line('FAIL: the app never reported its starting size')
    child.kill()
    return
  }
  await new Promise((r) => setTimeout(r, 2_000))

  line(`switching to ${target.dmPelsWidth}x${target.dmPelsHeight}`)
  applyMode(target)
  switched = true

  if (!(await waitForLog(/DISPLAY-WATCH clip=changed/, 180_000))) {
    line('FAIL: no clip was saved after the change')
    child.kill()
    return
  }
  line('clip saved after the change; switching back')
  restore()

  if (!(await waitForLog(/DISPLAY-WATCH complete|DISPLAY-WATCH failed/, 180_000))) {
    line('FAIL: the app never finished the second half')
    child.kill()
  }
}

function report() {
  line('\n============ RESOLUTION CHANGE REPORT ============')

  const resultPath = path.join(OUT, 'watch.json')
  if (!fs.existsSync(resultPath)) {
    line(`FAIL: ${resultPath} was never written`)
    exitCode = 1
    return
  }

  const { start, changed, restored, clips } = JSON.parse(fs.readFileSync(resultPath, 'utf8'))
  line(`start ${start.width}x${start.height} -> changed ${changed.width}x${changed.height} -> restored ${restored.width}x${restored.height}`)

  const check = (label, file, expected) => {
    if (!file || !fs.existsSync(file)) {
      line(`FAIL  ${label}: no clip (${file ?? 'missing'})`)
      exitCode = 1
      return
    }
    const got = dimensions(file)
    const ok = got && got.width === expected.width && got.height === expected.height
    line(
      `${ok ? 'PASS' : 'FAIL'}  ${label}: ${got ? `${got.width}x${got.height}` : 'no video stream'} ` +
        `(expected ${expected.width}x${expected.height})`,
    )
    if (!ok) exitCode = 1
  }

  check('after-change', clips.changed, changed)
  check('after-restore', clips.restored, restored)

  if (restored.width !== start.width || restored.height !== start.height) {
    line('FAIL: the display did not come back to its starting size')
    exitCode = 1
  }
}

await drive()
