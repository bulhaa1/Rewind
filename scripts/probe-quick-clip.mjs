#!/usr/bin/env node
/**
 * Quick-clip trim probe.
 *
 * The bug this guards against is a reporting one, not a trimming one: `keepTail` used
 * to return only a path, so the caller had nothing but the length it *asked* for and
 * announced that. A 60s request against a 40s clip was saved as "Saved last 60s" over a
 * 40s file -- the toast was wrong by more than half again.
 *
 * So the contract asserted here is that `keepTail` reports what it measured. Both
 * branches run against real media, and the three-audio-stream layout is checked on the
 * output because `-map 0` is what keeps the second and third lanes.
 */
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ffmpeg = require('ffmpeg-static')
const ffprobe = require('ffprobe-static').path

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`)
  if (!ok) failures++
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rewind-quickclip-'))

/** Bundles the real ffmpeg module so this exercises shipped code, not a copy. */
async function loadFfmpegModule() {
  const stub = path.join(work, 'electron-stub.mjs')
  // `resolveFfmpeg` reads `app.isPackaged`; outside Electron that would throw.
  fs.writeFileSync(stub, 'export const app = { isPackaged: false, getPath: () => work }')

  const entry = path.join(work, 'entry.mjs')
  fs.writeFileSync(
    entry,
    `export { keepTail, probeDuration, probe } from ${JSON.stringify(path.join(root, 'src/main/ffmpeg.ts'))}\n`,
  )

  const out = path.join(root, 'node_modules', '.cache', 'rewind-probe', 'bundle.cjs')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  await build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    platform: 'node',
    // CommonJS, so the transitive `require` of ffprobe-static's deps stays a real
    // require. Bundling it to ESM turns those into "dynamic require is not supported".
    format: 'cjs',
    logLevel: 'silent',
    // ffprobe-static resolves its binary from __dirname, so bundling it relocates it
    // and every probe silently returns null. Keep it external, and build inside the
    // project so the runtime `require` still resolves.
    external: ['ffprobe-static', 'ffmpeg-static'],
    alias: { electron: stub, '@shared': path.join(root, 'src/shared') },
  })
  return createRequire(import.meta.url)(out)
}

/**
 * Runs `fn` with any require of ffprobe-static throwing.
 *
 * The cut this gate exists for: the app must probe through ffmpeg alone. The
 * inspector above is unaffected -- its binary path was resolved before this hook.
 */
async function withFfprobeBlocked(fn) {
  const Module = require('module')
  const load = Module._load
  Module._load = function (request, ...rest) {
    if (request === 'ffprobe-static') throw new Error('ffprobe-static must not be used by the app')
    return load.call(this, request, ...rest)
  }
  try {
    return await fn()
  } finally {
    Module._load = load
  }
}

/** A clip with three audio lanes, matching what the recorder actually produces. */
function makeClip(name, seconds) {
  const out = path.join(work, name)
  execFileSync(
    ffmpeg,
    [
      '-y',
      '-f', 'lavfi', '-i', `testsrc=size=320x180:rate=15:duration=${seconds}`,
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
      '-f', 'lavfi', '-i', `sine=frequency=660:duration=${seconds}`,
      '-f', 'lavfi', '-i', `sine=frequency=880:duration=${seconds}`,
      '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:a',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
      out,
    ],
    { stdio: 'ignore' },
  )
  return out
}

function inspect(file) {
  const json = execFileSync(
    ffprobe,
    ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file],
    { encoding: 'utf8' },
  )
  const parsed = JSON.parse(json)
  return {
    duration: Number(parsed.format.duration),
    bitrateKbps: Math.round(Number(parsed.format.bit_rate) / 1000),
    audio: parsed.streams.filter((s) => s.codec_type === 'audio').length,
    streams: parsed.streams.map((s) => ({
      type: s.codec_type,
      codec: s.codec_name,
      width: s.width ?? 0,
      height: s.height ?? 0,
      fps: s.r_frame_rate,
      tags: s.tags ?? {},
    })),
  }
}

const { keepTail, probeDuration, probe } = await loadFfmpegModule()

// --- a 40s clip, the shape that used to produce the lie ------------------------
const source = makeClip('Replay source.mp4', 40)

// --- probe() parity, with ffprobe poisoned: the cut this gate guards -----------
//
// `probe()` is what the editor, the clip scanner and the diagnostics line read a
// file through. It must produce the same facts as ffprobe while never loading it.
// This runs before any other probe call, because resolveFfprobe caches its path --
// a warm cache would hide a require that still happens.
{
  const app = await withFfprobeBlocked(() => probe(source).catch((e) => ({ error: String(e) })))
  if (app?.error) {
    check('probe(): reads a file without ffprobe-static', false, app.error)
  } else {
    const ref = inspect(source)
    const appAudio = app.streams.filter((s) => s.codec_type === 'audio')
    const refAudio = ref.streams.filter((s) => s.type === 'audio')
    const appVideo = app.streams.find((s) => s.codec_type === 'video')
    const refVideo = ref.streams.find((s) => s.type === 'video')
    const fpsOf = (fraction) => {
      const [n, d] = String(fraction ?? '').split('/').map(Number)
      return d ? n / d : 0
    }

    check('probe(): reads a file without ffprobe-static', true)
    check(
      'probe(): duration matches ffprobe',
      Math.abs(Number(app.format?.duration) - ref.duration) < 0.1,
      `${app.format?.duration} vs ${ref.duration}`,
    )
    check(
      'probe(): bitrate matches ffprobe',
      Math.abs(Math.round(Number(app.format?.bit_rate) / 1000) - ref.bitrateKbps) <= 1,
      `${app.format?.bit_rate} vs ${ref.bitrateKbps}`,
    )
    check('probe(): audio stream count matches ffprobe', appAudio.length === ref.audio, `${appAudio.length} vs ${ref.audio}`)
    check(
      'probe(): video codec and resolution match ffprobe',
      appVideo?.codec_name === refVideo?.codec && appVideo?.width === refVideo?.width && appVideo?.height === refVideo?.height,
      `${appVideo?.codec_name} ${appVideo?.width}x${appVideo?.height} vs ${refVideo?.codec} ${refVideo?.width}x${refVideo?.height}`,
    )
    check(
      'probe(): frame rate matches ffprobe',
      Math.abs(fpsOf(appVideo?.r_frame_rate) - fpsOf(refVideo?.fps)) < 0.1,
      `${appVideo?.r_frame_rate} vs ${refVideo?.fps}`,
    )
    check(
      'probe(): audio tags match ffprobe',
      JSON.stringify(appAudio.map((s) => s.tags?.handler_name ?? null)) ===
        JSON.stringify(refAudio.map((s) => s.tags?.handler_name ?? null)),
      JSON.stringify(appAudio.map((s) => s.tags?.handler_name ?? null)),
    )
  }
}

const measured = await probeDuration(source)
console.log(`source clip: ${measured}s with 3 audio lanes\n`)

// 1. Request shorter than the clip: trimmed, and the report is the measurement.
{
  const request = 15
  const res = await keepTail(source, request)
  const info = inspect(res.file)
  check('short request: not marked wholeClip', res.wholeClip === false)
  check('short request: reports ~what it kept', Math.abs(res.seconds - request) <= 1, `reported ${res.seconds}s, asked ${request}s`)
  check('short request: file really is that long', Math.abs(info.duration - res.seconds) <= 1, `on disk ${info.duration.toFixed(2)}s`)
  check('short request: all three audio lanes survive', info.audio === 3, `${info.audio} streams`)
  check('short request: original filename kept', path.basename(res.file) === 'Replay source.mp4', path.basename(res.file))
  check('short request: no -tail file left behind', !fs.existsSync(path.join(work, 'Replay source-tail.mp4')))
}

// 2. Request longer than the clip: the whole clip, reported as the whole clip.
{
  const clip = makeClip('Replay overlong.mp4', 40)
  const request = 90
  const res = await keepTail(clip, request)
  const info = inspect(res.file)
  check('overlong request: marked wholeClip', res.wholeClip === true)
  check('overlong request: does NOT echo the request', res.seconds !== request, `reported ${res.seconds}s, asked ${request}s`)
  check('overlong request: reports the real length', Math.abs(res.seconds - measured) <= 1, `reported ${res.seconds}s, clip is ${measured}s`)
  check('overlong request: nothing was trimmed', Math.abs(info.duration - measured) <= 1, `on disk ${info.duration.toFixed(2)}s`)
  check('overlong request: all three audio lanes survive', info.audio === 3, `${info.audio} streams`)
  check('overlong request: file untouched in place', path.basename(res.file) === 'Replay overlong.mp4')
}

// 3. Exactly the buffer length: still the whole thing, still reported honestly.
{
  const clip = makeClip('Replay exact.mp4', 40)
  const res = await keepTail(clip, 40)
  check('exact-length request: wholeClip', res.wholeClip === true)
  check('exact-length request: reports measured length', res.seconds === 40, `reported ${res.seconds}s`)
}

fs.rmSync(work, { recursive: true, force: true })

console.log(`\n${failures ? `${failures} check(s) failed` : 'all checks passed'}`)
process.exit(failures ? 1 : 0)