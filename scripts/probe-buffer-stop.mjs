/**
 * A recording finished by a buffer stop must be registered immediately.
 *
 * Stopping the buffer while a continuous recording is running finishes that
 * recording rather than discarding it (`replay-buffer.ts:606-630` parks the
 * path in `finishedOnTeardown`). Registering it -- moving it into its source
 * folder, writing clip metadata, pushing `clip-saved` -- was only ever done by
 * `toggleReplayForUser` (`index.ts:436-452`).
 *
 * The panel's Stop button does not call that. It calls
 * `setReplayBufferActive(false)`, which pauses the buffer and never reads
 * `finishedOnTeardown`. So the finished clip sits unregistered on disk: no
 * metadata, no library entry, no `clip-saved`. It surfaces only on a later full
 * rescan, with its timestamp reverse-derived from the filename.
 *
 * The observable is immediacy plus metadata, not existence -- an unregistered
 * clip does eventually show up, which is exactly what hides this.
 *
 * Run against the app on --remote-debugging-port=9222. Leaves one recording
 * behind, as a real recording does.
 */

export default async function ({ evaluate }) {
  const results = []
  const check = (name, pass, detail = '') => {
    results.push({ name, pass })
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`)
  }

  const snap = () =>
    evaluate(
      `Promise.all([window.electronAPI.getSavedClips(), window.electronAPI.getRecordingState()])` +
        `.then(([c, r]) => JSON.stringify({ clips: c.data.map(x => x.path), recording: r.data?.recording }))`,
    )

  const buf = JSON.parse(
    await evaluate(`window.electronAPI.isReplayBufferActive().then(r => JSON.stringify(r.data))`),
  )
  if (!buf.active) {
    console.log('replay buffer is not running - start it first')
    console.log('\n0/1 checks passed')
    return
  }

  const before = JSON.parse(await snap())
  console.log(`library: ${before.clips.length} clips, recording=${before.recording}`)

  // Start a continuous recording long enough to produce a segment.
  console.log('\nstarting a continuous recording...')
  const started = await evaluate(`window.electronAPI.startRecording().then(r => JSON.stringify(r)).catch(e => 'THREW: ' + e.message)`)
  check('continuous recording started', String(started).includes('true'), started)

  await new Promise((r) => setTimeout(r, 12000))
  const mid = JSON.parse(await snap())
  console.log(`after 12s: recording=${mid.recording}, library=${mid.clips.length}`)

  // Now the defect: stop the BUFFER while recording runs. This is the panel's
  // Stop button, not the toggle hotkey.
  console.log('\nstopping the replay buffer while recording is live...')
  const stopped = await evaluate(
    `window.electronAPI.setReplayBufferActive(false).then(r => JSON.stringify(r)).catch(e => 'THREW: ' + e.message)`,
  )
  check('buffer stop succeeded', String(stopped).includes('"success":true'), stopped)

  // No long wait and no rescan: this is the immediacy claim.
  await new Promise((r) => setTimeout(r, 6000))

  const after = JSON.parse(await snap())
  console.log(`after stop: library=${after.clips.length}, recording=${after.recording}`)

  /*
   * Only a REGISTERED finished recording counts. A raw buffer flush also drops
   * a `Replay *.mp4` into the library root -- the buffer writes there and
   * `saveSegmentToScratch` moves it out afterwards -- so "something appeared"
   * is not evidence. A registered one is `Recording *.mp4` inside a source
   * subfolder, because `stopContinuousRecording` names it via
   * `nextRecordingPath()` and registration moves it with `moveIntoSourceFolder`.
   *
   * Counting a stranded `Replay` file as a pass is how the first run of this
   * probe went green against an unchanged bug.
   */
  const added = after.clips.filter((p) => !before.clips.includes(p))
  /*
   * "In a source subfolder" has to be checked against the configured library
   * root, not by counting path segments -- a parent directory plus a filename is
   * two segments too, so a clip sitting in the library root passes a naive
   * regex. Registration is the only thing that moves it one level deeper.
   */
  const root = await evaluate(
    `window.electronAPI.getOutputPath().then(r => JSON.stringify(r.data)).catch(() => '""')`,
  )
  const libRoot = (JSON.parse(root) || '').replace(/[\\/]+$/, '')
  const registered = added.filter((p) => {
    const rel = p.startsWith(libRoot) ? p.slice(libRoot.length) : p
    const parts = rel.split(/[\\/]/).filter(Boolean)
    // parts[0] is the filename; a real subfolder puts a folder in front of it.
    return /^Recording [^\\/]+\.(mp4|mkv)$/i.test(parts[parts.length - 1] ?? '') && parts.length >= 2
  })
  const stranded = added.filter((p) => !registered.includes(p))
  console.log(`library root: ${libRoot}`)

  check(
    'the finished recording was registered into a source subfolder',
    registered.length > 0,
    registered.length
      ? registered.map((p) => p.replace(/^.*[\\/]Captures[\\/]/, '')).join(', ')
      : added.length
        ? `added files were not registered recordings: ${stranded.map((p) => p.split(/[\\/]/).pop()).join(', ')}`
        : 'nothing added',
  )

  if (registered.length) {
    const info = JSON.parse(
      await evaluate(`window.electronAPI.getSavedClips().then(c => {
         const hit = c.data.find(x => ${JSON.stringify(registered[0])} === x.path)
         return JSON.stringify(hit ? { recordedAt: hit.recordedAt, source: hit.sourceName, size: hit.fileSize } : null)
       })`),
    )
    const sane =
      info &&
      typeof info.recordedAt === 'number' &&
      Number.isFinite(info.recordedAt) &&
      info.recordedAt > 0 &&
      info.recordedAt < Date.now() + 60_000
    check(
      'the registered clip carries real metadata, not a filename-derived guess',
      !!sane,
      info ? `recordedAt=${new Date(info.recordedAt).toISOString()} source=${info.source} size=${info.size}` : 'not found',
    )

    // Registration always writes `source`. An unregistered file keeps the
    // scanner's default, which is null -- that is the clearest single signal
    // that the register-and-move sequence never ran.
    check(
      'the registered clip records its capture source',
      !!info?.source,
      info?.source ? String(info.source) : 'source is null - never registered',
    )

    // A registered recording is stitched from segments, so it must be
    // plausibly long. A ~0 byte file means the stitch produced nothing.
    check('the finished recording actually contains footage', (info?.size ?? 0) > 200_000, `${info?.size ?? 0} bytes`)
  }

  // Leave the buffer as we found it.
  await evaluate(`window.electronAPI.setReplayBufferActive(true).catch(() => 0)`)
  await new Promise((r) => setTimeout(r, 3000))

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
}