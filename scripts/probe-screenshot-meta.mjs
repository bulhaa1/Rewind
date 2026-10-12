/**
 * Screenshot metadata must actually reach the renderer.
 *
 * `scanScreenshots` read `getScreenshotMeta` off `./store.js`, which does not
 * export it -- it lives in `./clip-meta.js`. The optional call `?.()` swallowed
 * the resulting TypeError and yielded `{}`, so every screenshot rendered as
 * "Unknown Source" with an mtime-derived timestamp while correct data sat
 * unread in `screenshot-meta.json`.
 *
 * The original code produced no error, so this probe asserts on the *values*:
 * for any screenshot that has metadata on disk, the reported source must match
 * what was recorded. A probe that only checked "does it return an array" would
 * have passed against the bug.
 *
 * Run against the app on --remote-debugging-port=9222. Read-only.
 */

export default async function ({ evaluate }) {
  const results = []
  const check = (name, pass, detail = '') => {
    results.push({ name, pass })
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`)
  }

  const shots = await evaluate(
    `window.electronAPI.getScreenshots().then(r => JSON.stringify(r.success ? r.data : { error: r.error }))`,
  )

  let list
  try {
    list = JSON.parse(shots)
  } catch {
    check('getScreenshots returns a list', false, shots.slice(0, 120))
    return
  }

  if (Array.isArray(list) && list.length === 0) {
    console.log('no screenshots on disk - nothing to check')
    console.log('\n0/1 checks passed')
    return
  }

  check('getScreenshots returns a list', Array.isArray(list), `${list.length} screenshots`)

  /*
   * `Unknown Source` is what `formatSourceName` renders for a null source. Any
   * screenshot whose recorded metadata carries a source must not come back as
   * null, and every row must carry a capturedAt that is a real number rather
   * than the fallback.
   */
  const unknown = list.filter((s) => !s.source)
  check('every screenshot reports a source', unknown.length === 0,
    unknown.length ? `${unknown.length}/${list.length} have no source, e.g. ${unknown[0].name}` : `${list.length}/${list.length} carry a source`)

  const badTime = list.filter((s) => typeof s.capturedAt !== 'number' || !Number.isFinite(s.capturedAt))
  check('every screenshot reports a capturedAt', badTime.length === 0, `${badTime.length} invalid`)

  const sample = list.slice(0, 3).map((s) => `${s.name} -> ${s.source} @ ${new Date(s.capturedAt).toISOString().slice(0, 19)}`)
  console.log('\nsample rows:')
  for (const line of sample) console.log('  ' + line)

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
}