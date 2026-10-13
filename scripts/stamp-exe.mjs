/**
 * Stamps the packaged executable with Rewind's icon and version resource.
 *
 * Why this is a separate step rather than electron-builder's job:
 * `win.signAndEditExecutable` has to be false on this machine, because the tool
 * that performs the edit (winCodeSign) ships an archive containing macOS dylib
 * symlinks, and Windows refuses to create symlinks without Developer Mode or an
 * elevated shell. The extraction then retries into a fresh directory every time
 * and packaging never completes.
 *
 * But that failure is partial, and the part we need is not the part that fails.
 * `rcedit-x64.exe` extracts cleanly; only the darwin symlinks error out. So we run
 * the same tool ourselves, by hand, on the finished executable.
 *
 * Without this, Task Manager shows the packaged app as "Electron" with Electron's
 * icon and Electron's version, because all three come from the PE version
 * resource rather than from anything at runtime.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
// An out-of-tree build (`-c.directories.output=<dir>`, which is how a build is made
// while something holds release/) passes its unpacked directory. The default is what
// `npm run package` produces.
const UNPACKED = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'release', 'win-unpacked')
const ICON = path.join(root, 'assets', 'favicon.ico')

if (!fs.existsSync(UNPACKED)) {
  console.error(`stamp-exe: ${UNPACKED} not found - run the packaging step first`)
  process.exit(1)
}
if (!fs.existsSync(ICON)) {
  console.error(`stamp-exe: ${ICON} not found`)
  process.exit(1)
}

/**
 * The app executable, excluding the uninstaller.
 *
 * Located rather than hard-coded to `Rewind.exe`: the packaged tree also holds
 * `Uninstall <name>.exe`, and the app exe is named after whatever productName was
 * in effect when it was built -- which is not necessarily the current one.
 */
function findAppExe() {
  const exes = fs
    .readdirSync(UNPACKED)
    .filter((f) => f.toLowerCase().endsWith('.exe'))
    .filter((f) => !/^uninstall/i.test(f))
  if (exes.length !== 1) return null
  return path.join(UNPACKED, exes[0])
}

const EXE = findAppExe()
if (!EXE) {
  console.error(`stamp-exe: could not identify a single app executable in ${UNPACKED}`)
  process.exit(1)
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const name = 'Rewind'

/**
 * Finds rcedit in electron-builder's cache.
 *
 * The cache directory name is a hash the builder chooses, so every directory is
 * searched rather than one being assumed.
 */
function findRcedit() {
  const cacheRoot = path.join(
    process.env.LOCALAPPDATA || '',
    'electron-builder',
    'Cache',
    'winCodeSign',
  )
  if (!fs.existsSync(cacheRoot)) return null
  const stack = [cacheRoot]
  while (stack.length) {
    const dir = stack.pop()
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.name === 'rcedit-x64.exe') return full
    }
  }
  return null
}

const rcedit = findRcedit()
if (!rcedit) {
  console.error(
    'stamp-exe: rcedit-x64.exe was not found in the electron-builder cache.\n' +
      "  Run a packaging attempt once to populate it, or set win.signAndEditExecutable\n" +
      '  back to true and enable Developer Mode instead of using this script.',
  )
  process.exit(1)
}

console.log(`stamp-exe: using ${rcedit}`)

const args = [
  EXE,
  '--set-icon', ICON,
  '--set-version-string', 'FileDescription', `${name} - instant replay capture`,
  '--set-version-string', 'ProductName', name,
  '--set-version-string', 'CompanyName', name,
  '--set-version-string', 'LegalCopyright', `Copyright (c) ${new Date().getFullYear()} ${name}`,
  '--set-version-string', 'InternalName', name,
  '--set-version-string', 'OriginalFilename', `${name}.exe`,
  '--set-file-version', pkg.version,
  '--set-product-version', pkg.version,
]

try {
  execFileSync(rcedit, args, { stdio: 'pipe' })
} catch (e) {
  const detail = [e.stdout, e.stderr].filter(Boolean).map(String).join('\n').trim()
  console.error(`stamp-exe: rcedit failed${detail ? `:\n${detail}` : ''}`)
  process.exit(1)
}

// rcedit reporting success is not proof: the observable result is the PE version
// resource, which is what Task Manager reads. `scripts/verify-exe.mjs` checks it,
// and is run by `npm run package:verify-exe`.
console.log(
  `stamp-exe: set the ${name} icon, product name and version ${pkg.version} on ${path.basename(EXE)}`,
)
