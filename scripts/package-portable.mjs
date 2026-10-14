/**
 * Builds the portable zip from the app already packaged in release/win-unpacked.
 *
 * A portable copy is the same tree as the installer, zipped instead of wrapped in
 * NSIS. The one difference is `portable.flag`, written beside Rewind.exe before the
 * zip is made and removed afterwards: the app looks for it next to its own exe and
 * hides the update control, because updating a portable copy would download and run
 * the NSIS installer rather than replace the zip.
 *
 * Usage:
 *   node scripts/package-portable.mjs             build release/Rewind-<v>-portable.zip
 *   node scripts/package-portable.mjs --publish   build and upload to the GitHub release
 *
 * Run `npm run package` first: this does not build the app, only archives it.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const unpacked = path.join(root, 'release', 'win-unpacked')
const flag = path.join(unpacked, 'portable.flag')
const publish = process.argv.includes('--publish')

if (!fs.existsSync(path.join(unpacked, 'Rewind.exe'))) {
  console.error(`No packaged app at ${unpacked}. Run "npm run package" first.`)
  process.exit(1)
}

// A previous run that was killed can leave the marker behind, and a later installer
// build from this same tree would ship it -- every installed copy would then think it
// is portable and hide its updater. Clear it first, and clear it on the way out too.
const removeFlag = () => {
  try {
    fs.rmSync(flag, { force: true })
  } catch {
    /* nothing to remove */
  }
}
removeFlag()
process.on('exit', removeFlag)
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => process.exit(1))

fs.writeFileSync(flag, 'Portable build. Delete this file to let the app update itself.\n')
try {
  const res = spawnSync(
    process.execPath,
    [
      path.join(root, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js'),
      '--win',
      'zip',
      '--prepackaged',
      unpacked,
      '--config',
      path.join(root, 'electron-builder-portable.yml'),
      '--publish',
      publish ? 'always' : 'never',
    ],
    { cwd: root, stdio: 'inherit' },
  )
  if (res.status !== 0) process.exit(res.status ?? 1)
} finally {
  removeFlag()
}

console.log(publish ? 'Portable zip published.' : 'Portable zip written to release/.')
