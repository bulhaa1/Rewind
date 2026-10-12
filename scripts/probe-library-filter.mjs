/**
 * The library filter must show editor copies and hide trim temporaries.
 *
 * Two defects with the same root, both in `shouldInclude`
 * (`src/main/clip-manager.ts:133`):
 *
 *  - `isEditorCopy` returns true for every `-edit` file, so the early return
 *    hides exactly what the editor's "Save as Copy" produces. The user saves a
 *    copy and can never see it again.
 *  - nothing excludes `.trim-<timestamp>.mp4`, which the editor writes into the
 *    library folder while ffmpeg is working (`editor.ts:381`). Those files start
 *    with the `Replay` prefix, so line 139 waves them straight through.
 *
 * This probe asserts on the library the renderer actually receives. Asserting
 * on the filter function itself would pass against either defect, because both
 * are "returns the wrong boolean", and only the resulting list distinguishes
 * a copy you can find from a temporary you cannot.
 *
 * Run against the app on --remote-debugging-port=9222. Read-only.
 */

import fs from 'node:fs'
import path from 'node:path'

/** Recursively finds files under the configured clip output root. */
function findOnDisk(re) {
  const settings = path.join(process.env.APPDATA, 'Rewind', 'settings.json')
  let root = 'Z:\\Apps\\Captures\\REWIND'
  try {
    root = JSON.parse(fs.readFileSync(settings, 'utf8')).outputPath || root
  } catch {
    /* fall back to the default above */
  }
  const hits = []
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (re.test(e.name)) hits.push(full)
    }
  }
  walk(root)
  return hits
}

export default async function ({ evaluate }) {
  const results = []
  const check = (name, pass, detail = '') => {
    results.push({ name, pass })
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`)
  }

  const raw = await evaluate(
    `window.electronAPI.getSavedClips().then(r => JSON.stringify(r.success ? r.data.map(c => c.filename) : { error: r.error }))`,
  )

  let names
  try {
    names = JSON.parse(raw)
  } catch {
    check('getSavedClips returns a list', false, String(raw).slice(0, 140))
    return
  }
  if (!Array.isArray(names)) {
    check('getSavedClips returns a list', false, JSON.stringify(names).slice(0, 140))
    return
  }

  console.log(`library holds ${names.length} clips`)

  // 1. Trim temporaries must never surface. They exist only mid-save.
  const temps = names.filter((n) => n.includes('.trim-'))
  check('no trim temporary is listed', temps.length === 0,
    temps.length ? `listed: ${temps.join(', ')}` : 'none present')

  // 2. Editor copies must surface, or "Save as Copy" writes a file the user can
  //    never open again. The probe runs in node, so it can look at the disk
  //    directly and tell "correctly absent" apart from "present but filtered
  //    out" -- otherwise this check passes vacuously against the bug.
  const listed = new Set(names)
  const onDisk = findOnDisk(/-edit(-\d+)?\.(mp4|mkv)$/i)
  if (onDisk.length === 0) {
    console.log('SKIP  editor copies are listed when present  -> no -edit file on disk')
  } else {
    const missing = onDisk.filter((f) => !listed.has(path.basename(f)))
    check('editor copies are listed when present', missing.length === 0,
      missing.length
        ? `${missing.length}/${onDisk.length} filtered out, e.g. ${path.basename(missing[0])}`
        : `${onDisk.length} on disk, all listed`)
  }

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
}