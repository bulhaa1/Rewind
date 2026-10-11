/**
 * End-to-end self test.
 *
 * Launches Rewind, waits for the replay buffer to fill, then drives the real
 * save, screenshot and library paths through the same functions the UI uses, and
 * reports what actually landed on disk.
 *
 * Run with:  npm run selftest
 *
 * This exists because "the buffer started" is not evidence that saving works — the
 * only proof is a file with real frames in it.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const OUT = path.join(os.tmpdir(), 'rewind-selftest')
const LOG = path.join(process.env.APPDATA || '', 'Rewind', 'logs', 'main.log')

function reset() {
  try {
    fs.rmSync(OUT, { recursive: true, force: true })
  } catch {
    /* fresh run */
  }
  fs.mkdirSync(OUT, { recursive: true })
}

function line(msg) {
  process.stdout.write(`${msg}\n`)
}

const electron = require('electron')
const child = spawn(electron, ['.', '--selftest'], {
  stdio: ['ignore', 'inherit', 'inherit'],
  cwd: projectRoot,
  env: { ...process.env, REWIND_SELFTEST: '1', REWIND_SELFTEST_OUT: OUT },
})

let exitCode = 0
child.on('exit', (code) => {
  line(`\nRewind exited with code ${code}`)
  report()
  process.exit(exitCode)
})

// Hard stop: a wedged OBS child must not hang the suite.
const guard = setTimeout(() => {
  line('\nTIMEOUT: killing Rewind')
  child.kill()
  exitCode = 1
}, 180_000)

function report() {
  clearTimeout(guard)
  line('\n================ SELFTEST REPORT ================')

  const ffprobe = path.join(projectRoot, 'node_modules', 'ffprobe-static', 'bin', 'win32', 'x64', 'ffprobe.exe')

  let clips = []
  let shots = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (/\.mp4$|\.mkv$/i.test(e.name)) clips.push(full)
      else if (/\.png$/i.test(e.name)) shots.push(full)
    }
  }
  if (fs.existsSync(OUT)) walk(OUT)

  line(`\nClips found: ${clips.length}`)
  for (const c of clips) {
    const size = fs.statSync(c).size
    line(`  ${path.basename(c)}  ${(size / 1024 / 1024).toFixed(2)} MB`)
    if (size > 0 && fs.existsSync(ffprobe)) {
      try {
        const { execFileSync } = require('node:child_process')
        const out = execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-show_entries', 'stream=codec_type,codec_name,width,height', '-of', 'json', c], { encoding: 'utf8' })
        const p = JSON.parse(out)
        const v = (p.streams || []).find((s) => s.codec_type === 'video')
        const a = (p.streams || []).filter((s) => s.codec_type === 'audio')
        line(`     duration=${Number(p.format?.duration || 0).toFixed(1)}s video=${v?.codec_name} ${v?.width}x${v?.height} audioStreams=${a.length}`)
      } catch (e) {
        line(`     ffprobe FAILED: ${e.message}`)
        exitCode = 1
      }
    }
    if (size < 10_000) {
      line('     FAIL: file is suspiciously small - likely no encoded frames')
      exitCode = 1
    }
  }

  line(`\nScreenshots found: ${shots.length}`)
  for (const s of shots) {
    const size = fs.statSync(s).size
    line(`  ${path.basename(s)}  ${(size / 1024).toFixed(1)} KB`)
    if (size < 5_000) {
      line('     FAIL: screenshot is empty')
      exitCode = 1
    }
  }

  if (clips.length === 0) {
    line('\nFAIL: no clip was saved')
    exitCode = 1
  }
  if (shots.length === 0) {
    line('\nFAIL: no screenshot was taken')
    exitCode = 1
  }

  line(`\nRESULT: ${exitCode === 0 ? 'PASS' : 'FAIL'}`)
}

reset()
line(`Self-test output directory: ${OUT}`)