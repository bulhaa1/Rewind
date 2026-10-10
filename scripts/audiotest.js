/**
 * End-to-end audio test.
 *
 * Plays a known 1kHz tone through the default output device while Rewind records,
 * then measures the saved clip. This distinguishes "the capture chain is broken"
 * from "the machine happened to be silent", which a quiet test run cannot tell apart.
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const OUT = 'C:\\Users\\jude\\AppData\\Local\\Temp\\rewind-audiotest'
const TONE = path.join(OUT, 'tone.wav')
const ffmpeg = path.join(projectRoot, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe')
const electron = require('electron')

const log = (m) => console.log(m)

function reset() {
  fs.rmSync(OUT, { recursive: true, force: true })
  fs.mkdirSync(OUT, { recursive: true })
}

function makeTone() {
  execFileSync(
    ffmpeg,
    ['-y', '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=44100:duration=20', '-ac', '2', TONE],
    { stdio: 'ignore' },
  )
  log(`tone generated: ${(fs.statSync(TONE).size / 1024).toFixed(0)} KB`)
}

/** Plays the tone through the default playback device, non-blocking. */
function playTone(seconds) {
  return new Promise((resolve) => {
    // PowerShell's SoundPlayer is the only non-interactive WAV player available here.
    const ps = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `(New-Object Media.SoundPlayer '${TONE}').PlaySync(); Start-Sleep -Seconds ${seconds}`,
      ],
      { stdio: 'ignore' },
    )
    ps.on('exit', () => resolve())
  })
}

async function main() {
  reset()
  makeTone()

  const child = spawn(electron, ['.'], {
    stdio: ['ignore', 'ignore', 'ignore'],
    cwd: projectRoot,
    env: { ...process.env, REWIND_SELFTEST: '1', REWIND_SELFTEST_OUT: OUT, REWIND_SELFTEST_AUDIO: '1' },
  })

  const guard = setTimeout(() => {
    log('TIMEOUT')
    child.kill()
    process.exit(1)
  }, 240_000)

  child.on('exit', () => {
    clearTimeout(guard)
    measure()
  })

  // Wait for the app to signal that the buffer is full, then play the tone over
  // the top of the recording window.
  const signal = path.join(OUT, 'PLAY_TONE')
  log('waiting for app to be ready to capture...')
  for (let i = 0; i < 120; i++) {
    if (fs.existsSync(signal)) break
    await new Promise((r) => setTimeout(r, 1000))
  }
  log('playing tone during recording...')
  await playTone(16)
}

function measure() {
  const clips = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) walk(full)
      else if (/\.mp4$|\.mkv$/i.test(e.name)) clips.push(full)
    }
  }
  if (fs.existsSync(OUT)) walk(OUT)

  log('\n================ AUDIO TEST ================')
  if (!clips.length) {
    log('FAIL: no clip produced')
    process.exit(1)
  }

  let failed = false
  for (const c of clips) {
    log(`\nclip: ${path.basename(c)} (${(fs.statSync(c).size / 1024 / 1024).toFixed(2)} MB)`)
    try {
      const probe = execFileSync(
        path.join(projectRoot, 'node_modules', 'ffprobe-static', 'bin', 'win32', 'x64', 'ffprobe.exe'),
        ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,channels,sample_rate', '-of', 'json', c],
        { encoding: 'utf8' },
      )
      const streams = JSON.parse(probe).streams || []
      const audio = streams.filter((s) => s.codec_type === 'audio')
      log(`  audio streams: ${audio.length}${audio.length ? ` (${audio[0].codec_name} ${audio[0].channels}ch @${audio[0].sample_rate}Hz)` : ''}`)
      if (!audio.length) {
        log('  FAIL: no audio stream')
        failed = true
        continue
      }

      // ffmpeg writes volumedetect to stderr; spawnSync gives both streams without
      // throwing, so a silent file is reported rather than silently "passing".
      const r = spawnSync(ffmpeg, ['-hide_banner', '-nostats', '-i', c, '-af', 'volumedetect', '-f', 'null', 'NUL'], {
        encoding: 'utf8',
      })
      const text = `${r.stdout || ''}\n${r.stderr || ''}`
      const mean = /mean_volume:\s+(-?[\d.]+|-inf)\s+dB/.exec(text)
      const max = /max_volume:\s+(-?[\d.]+|-inf)\s+dB/.exec(text)
      log(`  mean_volume: ${mean ? mean[1] : '?'} dB   max_volume: ${max ? max[1] : '?'} dB`)

      if (!mean) {
        log('  FAIL: could not measure loudness')
        failed = true
      } else if (mean[1] === '-inf' || Number(mean[1]) < -80) {
        log('  FAIL: audio is silent')
        failed = true
      } else {
        log('  PASS: audio present')
      }
    } catch (e) {
      log(`  FAIL: ${e.message}`)
      failed = true
    }
  }

  log(`\nRESULT: ${failed ? 'FAIL' : 'PASS'}`)
  process.exit(failed ? 1 : 0)
}

main()