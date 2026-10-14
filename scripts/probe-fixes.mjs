/**
 * Verification for the settings fixes: storage usage, profile add/duplicate/cap, and
 * the per-app audio window match.
 *
 * Run against a live app on CDP (see AGENTS.md): start Rewind with
 * `--remote-debugging-port=9222`, then
 *
 *   node scripts/cdp.mjs scripts/probe-fixes.mjs
 *
 * `VERIFY_CLIP_BYTES` is the size of the file the harness put in the clips folder; the
 * storage check compares the reported total against it.
 */
export default async function ({ evaluate, drainErrors }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const call = (expr) => evaluate(expr)
  const results = []
  const check = (name, pass, detail = '') => {
    results.push({ name, pass })
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`)
  }

  // -------------------------------------------------------------------------
  // 1. Storage usage
  // -------------------------------------------------------------------------
  const usage = await call(`window.electronAPI.getStorageUsage().then(r => r.success ? r.data : { error: r.error })`)
  const expected = Number(process.env.VERIFY_CLIP_BYTES || 0)

  check('storage usage returns numbers', typeof usage?.replaysBytes === 'number', JSON.stringify(usage))
  if (expected) {
    check(
      'storage usage counts the file on disk',
      usage.replaysBytes === expected,
      `${usage.replaysBytes} bytes vs ${expected} on disk`,
    )
    check('storage usage counts files', usage.replaysFiles === 1, `${usage.replaysFiles} file(s)`)
  }
  check(
    'storage usage reports volume space',
    usage.totalBytes > 0 && usage.freeBytes > 0,
    `${usage.freeBytes} free of ${usage.totalBytes}`,
  )

  await call(`(window.location.hash = '/settings', true)`)
  await sleep(700)
  await call(`document.querySelector('[data-testid="settings-nav-storage"]').click()`)
  await sleep(700)
  const storageText = await call(`document.querySelector('[data-testid="settings-content"]')?.innerText ?? ''`)
  check(
    'Storage section renders the usage rows',
    /Usage/.test(storageText) && /Replays/.test(storageText) && /Free space/.test(storageText),
    storageText.replace(/\s+/g, ' ').slice(0, 120),
  )

  // -------------------------------------------------------------------------
  // 2. Profiles: add / duplicate / remove, capped at four
  // -------------------------------------------------------------------------
  await call(`document.querySelector('[data-testid="settings-nav-profiles"]').click()`)
  await sleep(700)

  const rows = () => call(`document.querySelectorAll('[data-testid^="profile-remove-"]').length`)
  const addDisabled = () => call(`document.querySelector('[data-testid="profile-add"]')?.disabled ?? null`)

  const startRows = await rows()
  const startDisabled = await addDisabled()
  check(
    'profiles: add is disabled at the cap',
    startRows === 4 && startDisabled === true,
    `${startRows} rows, add disabled=${startDisabled}`,
  )
  const dupDisabled = await call(`document.querySelector('[data-testid="profile-duplicate-0"]')?.disabled ?? null`)
  check('profiles: duplicate is disabled at the cap', dupDisabled === true, `disabled=${dupDisabled}`)

  await call(`document.querySelector('[data-testid="profile-remove-1"]').click()`)
  await sleep(900)
  const afterRemove = await rows()
  check(
    'profiles: removing one frees a slot',
    afterRemove === 3 && (await addDisabled()) === false,
    `${afterRemove} rows, add disabled=${await addDisabled()}`,
  )

  await call(`document.querySelector('[data-testid="profile-add"]').click()`)
  await sleep(900)
  const afterAdd = await rows()
  check(
    'profiles: add fills the slot and re-caps',
    afterAdd === 4 && (await addDisabled()) === true,
    `${afterAdd} rows, add disabled=${await addDisabled()}`,
  )

  // -------------------------------------------------------------------------
  // 3. Per-app audio
  // -------------------------------------------------------------------------
  const audio = await call(`(async () => {
    const [w, s] = await Promise.all([window.electronAPI.getWindows(), window.electronAPI.getAudioSessions()])
    return { windows: w.success ? w.data : [], sessions: s.success ? s.data : [] }
  })()`)
  console.log(`WINDOWS ${JSON.stringify(audio.windows).slice(0, 400)}`)
  console.log(`SESSIONS ${JSON.stringify(audio.sessions).slice(0, 400)}`)

  check(
    'audio: sessions carry a capturable flag',
    audio.sessions.every((a) => typeof a.capturable === 'boolean'),
    `${audio.sessions.length} session(s)`,
  )

  // The handler must answer from the mix, not the raw session list: a stored level
  // survives its app closing, which the raw list cannot represent. That is also the
  // path that fills in `capturable`.
  await call(`window.electronAPI.setAppVolume('verifyprobe', 0.5)`)
  const persisted = await call(
    `window.electronAPI.getAudioSessions().then(r => r.data.find(a => a.exe === 'verifyprobe') ?? null)`,
  )
  check(
    'audio: stored per-app levels are listed',
    persisted?.volume === 0.5 && persisted.running === false,
    JSON.stringify(persisted),
  )
  await call(`window.electronAPI.resetAppMix()`)

  // -------------------------------------------------------------------------
  // 4. Renderer errors
  // -------------------------------------------------------------------------
  const errors = drainErrors()
  check('no renderer errors', errors.length === 0, errors.slice(0, 3).join(' | '))

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  return failed.length === 0
}
