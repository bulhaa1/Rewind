/**
 * End-to-end test for continuous recording.
 *
 * Starts a real recording through the same path the Record button uses, holds it
 * while a known tone plays, stops it, and measures the finished file: is there
 * audio with signal, and is the frame rate what was actually requested rather
 * than what the encoder was relabelled as?
 *
 *   node scripts/recordtest.js [fps] [seconds]
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electron = require('electron')
const ffmpeg = path.join(projectRoot, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe')
const ffprobe = path.join(projectRoot, 'node_modules', 'ffprobe-static', 'bin', 'win32', 'x64', 'ffprobe.exe')

const OUT = 'C:\\Users\\jude\\AppData\\Local\\Temp\\rewind-recordtest'
const TONE = path.join(OUT, 'tone.wav')

const FPS = Number(process.argv[2] ?? '120')
const SECONDS = Number(process.argv[3] ?? '10')

const log = (m) => console.log(m)

fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })
execFileSync(
  ffmpeg,
  ['-y', '-f', 'lavfi', '-i', `sine=frequency=1000:sample_rate=44100:duration=${SECONDS + 6}`, '-ac', '2', TONE],
  { stdio: 'ignore' },
)

// A still desktop produces almost no distinct frames no matter how fast it is
// captured, which would make the duplicate-frame check meaningless. A full-screen
// animated page guarantees the capture has genuine motion to resolve.
const child = spawn(electron, ['.'], {
  stdio: ['ignore', 'ignore', 'ignore'],
  cwd: projectRoot,
  env: {
    ...process.env,
    REWIND_SELFTEST_RECORD: '1',
    REWIND_SELFTEST_OUT: OUT,
    REWIND_SELFTEST_RECORD_SECONDS: String(SECONDS),
    REWIND_SELFTEST_FPS: String(FPS),
    REWIND_SELFTEST_AUDIO: '1',
  },
})

const done = path.join(OUT, 'RECORD_DONE')
const signal = path.join(OUT, 'PLAY_TONE')

const waitFor = async (file, label, limitSeconds) => {
  for (let i = 0; i < limitSeconds; i++) {
    if (fs.existsSync(file)) return true
    await new Promise((r) => setTimeout(r, 1000))
  }
  log(`TIMEOUT waiting for ${label}`)
  return false
}

const timer = setTimeout(() => {
  log('TIMEOUT (300s)')
  child.kill()
  process.exit(1)
}, 300_000)

child.on('exit', () => {
  clearTimeout(timer)
  report()
})

async function main() {
  if (await waitFor(signal, 'tone cue', 200)) {
    log('playing tone and animation during recording...')

    // Motion first, so it is already on screen when the tone starts.
    const MOTION_PS = path.join(OUT, 'motion.ps1')
    fs.writeFileSync(
      MOTION_PS,
      [
        'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
        '$f = New-Object System.Windows.Forms.Form',
        '$f.FormBorderStyle = "None"; $f.StartPosition = "Manual"; $f.Location = New-Object System.Drawing.Point 0,0',
        '$f.Size = New-Object System.Drawing.Size ([System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width), ([System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height)',
        '$f.TopMost = $true; $f.BackColor = [System.Drawing.Color]::FromArgb(17,17,17)',
        '$tick = 0',
        '$handler = {',
        '  param($s, $e)',
        '  $g = $s.Graphics; $g.SmoothingMode = "AntiAlias"',
        '  $g.Clear([System.Drawing.Color]::FromArgb(17,17,17))',
        '  $w = $f.Width; $h = $f.Height; $t = [System.Windows.Forms.Timer]::new()',
        '  $timer = {',
        '    $script:tick++',
        '    $g = $f.Graphics; $g.SmoothingMode = "AntiAlias"',
        '    $g.Clear([System.Drawing.Color]::FromArgb(17,17,17))',
        '    $cx = [int]($w/2 + [Math]::Cos($script:tick/12.0) * ($w/3))',
        '    $cy = [int]($h/2 + [Math]::Sin($script:tick/9.0) * ($h/3))',
        '    $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(230,60,60))',
        '    $g.FillEllipse($brush, $cx-70, $cy-70, 140, 140)',
        '    $brush.Dispose()',
        '    $g.DrawString("frame $script:tick", (New-Object System.Drawing.Font("Consolas",28)), [System.Drawing.Brushes]::White, 40, 40)',
        '  }.GetNewClosure()',
        '  $timer.Interval = 8',
        '  $timer.add_Tick($timer)',
        '  $timer.Start()',
        '  $f.Show()',
        '  Start-Sleep -Seconds ' + (SECONDS + 4) + '',
        '  $timer.Stop()',
        '  $f.Close()',
        '}.GetNewClosure()',
        '$f.add_Paint($handler)',
        '[System.Windows.Forms.Application]::Run($f)',
      ].join("\n"),
    )

    const motion = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', MOTION_PS], {
      stdio: 'ignore',
      detached: true,
    })
    log('animation window launched')

    await new Promise((r) => setTimeout(r, 4000))

    await new Promise((resolve) => {
      const ps = spawn(
        'powershell.exe',
        ['-NoProfile', '-Command', `(New-Object Media.SoundPlayer '${TONE}').PlaySync()`],
        { stdio: 'ignore' },
      )
      ps.on('exit', resolve)
    })

    try {
      spawn('taskkill', ['/pid', String(motion.pid), '/f'], { stdio: 'ignore' })
    } catch {
      /* already gone */
    }
  }
  await waitFor(done, 'recording to finish', 120)
}

main()

function report() {
  log('\n================ RECORDING TEST ================')

  if (fs.existsSync(done)) {
    const result = fs.readFileSync(done, 'utf8')
    if (result.startsWith('ERROR:')) {
      log(`FAIL: recording errored -> ${result.slice(6)}`)
      process.exit(1)
    }
  }

  const clips = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) walk(full)
      else if (/\.(mp4|mkv)$/i.test(e.name)) clips.push(full)
    }
  }
  if (fs.existsSync(OUT)) walk(OUT)

  if (!clips.length) {
    log('FAIL: no recording was produced')
    process.exit(1)
  }

  let failed = false

  for (const clip of clips) {
    log(`\nclip: ${path.basename(clip)} (${(fs.statSync(clip).size / 1024 / 1024).toFixed(2)} MB)`)

    const raw = execFileSync(
      ffprobe,
      ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', clip],
      { encoding: 'utf8' },
    )
    const meta = JSON.parse(raw)
    const v = (meta.streams || []).find((s) => s.codec_type === 'video')
    const a = (meta.streams || []).find((s) => s.codec_type === 'audio')

    if (!v) {
      log('  FAIL: no video stream')
      failed = true
      continue
    }

    // avg_frame_rate is measured from the actual packet timestamps; r_frame_rate is
    // only the container's declared rate and would happily claim 120 for a 60fps
    // file, which is exactly the false label this check exists to catch.
    const avg = v.avg_frame_rate
    const declared = v.r_frame_rate
    const [n, d] = avg.split('/').map(Number)
    const measured = d ? n / d : 0
    const duration = Number(meta.format?.duration ?? 0)

    log(`  video: ${v.codec_name} ${v.width}x${v.height}  duration=${duration.toFixed(2)}s`)
    log(`  frame rate: measured=${measured.toFixed(2)} fps   declared=${declared}`)

    // A container can declare any rate it likes; OBS will happily pad a slower
    // capture with duplicated frames to reach it. `mpdecimate` drops frames that
    // match their predecessor, so counting what survives measures how many frames
    // genuinely differ from the one before them — the number that actually decides
    // whether this is a 120 fps recording or a 30 fps one wearing the label.
    const dec = spawnSync(
      ffmpeg,
      ['-hide_banner', '-nostats', '-i', clip, '-vf', 'mpdecimate,showinfo', '-f', 'null', 'NUL'],
      { encoding: 'utf8' },
    )
    const decText = `${dec.stdout || ''}\n${dec.stderr || ''}`
    const unique = (decText.match(/Parsed_showinfo.*n:\s*\d+/g) || []).length
    const uniqueFps = duration > 0 ? unique / duration : 0
    log(`  unique frames: ${unique} over ${duration.toFixed(2)}s = ${uniqueFps.toFixed(2)} distinct fps`)

    // Advisory, not a pass/fail. This only means something if the capture saw real
    // motion, and whether the animation window actually came up is not something
    // this script can confirm — a run where it never appeared reports a low number
    // for a perfectly correct recording. It is printed so the figure is on record,
    // and a number far below the requested rate is worth a second look.
    if (uniqueFps < FPS * 0.5) {
      log(`  NOTE: only ${uniqueFps.toFixed(1)} distinct frames/s against a declared ${measured.toFixed(0)} fps.`)
      log('        If the animation window really was on screen, OBS is duplicating frames to reach the rate.')
    } else {
      log(`  OK: ${uniqueFps.toFixed(1)} distinct frames per second`)
    }

    if (measured < FPS * 0.85) {
      log(`  FAIL: requested ${FPS} fps but the file actually averages ${measured.toFixed(2)} fps`)
      failed = true
    } else {
      log(`  PASS: real frame rate matches the requested ${FPS} fps`)
    }

    if (!a) {
      log('  FAIL: no audio stream')
      failed = true
    } else {
      const r = spawnSync(ffmpeg, ['-hide_banner', '-nostats', '-i', clip, '-af', 'volumedetect', '-f', 'null', 'NUL'], {
        encoding: 'utf8',
      })
      const text = `${r.stdout || ''}\n${r.stderr || ''}`
      const mean = /mean_volume:\s+(-?[\d.]+|-inf)\s+dB/.exec(text)
      log(`  audio: ${a.codec_name} ${a.channels}ch  mean_volume=${mean ? mean[1] : '?'} dB`)
      if (!mean || mean[1] === '-inf' || Number(mean[1]) < -80) {
        log('  FAIL: audio stream is silent')
        failed = true
      } else {
        log('  PASS: audio present')
      }
    }
  }

  log(`\nRESULT: ${failed ? 'FAIL' : 'PASS'}`)
  process.exit(failed ? 1 : 0)
}