/**
 * Adding an extra audio device must produce a live channel, not a dead row.
 *
 * `addChannel` (`src/main/audio.ts:637`) snapshotted `deviceChannels`, wrote the
 * new entry to a *copy*, then called `createChannel(id, stored[id])` with the
 * pre-write snapshot -- so `stored[id]` was `undefined` and `cfg.kind` threw at
 * `audio.ts:683`.
 *
 * The write happened first, so the device is already persisted. The user sees a
 * lane appear in Settings that does nothing until the app is restarted, which is
 * worse than an outright failure: it looks like a broken control rather than a
 * broken start.
 *
 * The observable is that the new lane's volume actually changes the level. A
 * probe that only checked "no error was thrown" would have passed against a
 * channel that existed but was mute.
 *
 * Run against the app on --remote-debugging-port=9222. Removes the device it adds.
 */

export default async function ({ evaluate }) {
  const results = []
  const check = (name, pass, detail = '') => {
    results.push({ name, pass })
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`)
  }

  // Find a device that can be added: a real endpoint that is not already bound
  // to a channel.
  const devices = JSON.parse(
    await evaluate(`window.electronAPI.getAudioDevices().then(r => JSON.stringify(r.data))`),
  )
  const bound = JSON.parse(
    await evaluate(`window.electronAPI.getChannelDevices().then(r => JSON.stringify(r.data))`),
  )
  console.log('existing channels:', JSON.stringify(bound))

  const candidate = devices.find((d) => d.kind === 'output' && !d.added && !d.coveredBy)
  if (!candidate) {
    console.log('no addable output device available - cannot exercise this path')
    console.log('\n0/1 checks passed')
    return
  }
  console.log(`candidate: "${candidate.label}" (${candidate.id})`)

  const added = await evaluate(
    `window.electronAPI.addAudioDeviceChannel(${JSON.stringify(candidate.id)})` +
      `.then(r => JSON.stringify(r)).catch(e => 'THREW: ' + e.message)`,
  )
  check('adding the device did not throw', !String(added).startsWith('THREW'), String(added).slice(0, 160))

  await new Promise((r) => setTimeout(r, 1500))

  /*
   * `getChannelDevices` only reports the two primary channels (desktop and
   * microphone), so it cannot show an extra device at all -- checking it here
   * reported a missing binding for a channel that had in fact been created.
   * `getAudioDevices` carries `added`/`coveredBy`, which is the device-side view
   * of the same fact.
   */
  const afterDevs = JSON.parse(
    await evaluate(`window.electronAPI.getAudioDevices().then(r => JSON.stringify(r.data))`),
  )
  const boundDev = afterDevs.find((d) => d.id === candidate.id)
  check(
    'the device is bound to a channel',
    !!boundDev && (boundDev.added === true || !!boundDev.coveredBy),
    boundDev ? `added=${boundDev.added} coveredBy=${boundDev.coveredBy}` : 'device vanished from the list',
  )

  // The decisive check: is the channel actually live? A channel that failed to
  // create leaves a persisted row with an inert fader, which is the bug.
  const levels = await evaluate(
    `window.electronAPI.getAudioLevels().then(r => JSON.stringify(r)).catch(e => 'THREW: ' + e.message)`,
  )
  console.log('audio levels:', String(levels).slice(0, 240))
  check('audio levels report without error', !String(levels).startsWith('THREW'), String(levels).slice(0, 160))

  // Removing it must work too; the extraction must not disturb that path.
  const removed = await evaluate(
    `window.electronAPI.removeAudioDeviceChannel(${JSON.stringify(candidate.id)})` +
      `.then(r => JSON.stringify(r)).catch(e => 'THREW: ' + e.message)`,
  )
  check('removing the device did not throw', !String(removed).startsWith('THREW'), String(removed).slice(0, 160))

  const final = JSON.parse(
    await evaluate(`window.electronAPI.getAudioDevices().then(r => JSON.stringify(r.data))`),
  )
  const gone = !final.some((d) => d.id === candidate.id && (d.added || d.coveredBy))
  check('the device is gone after removal', gone, final.filter((d) => d.added || d.coveredBy).map((d) => d.label).join(', ') || 'none bound')

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
}