/**
 * Verifies the packaged executable carries Rewind's identity.
 *
 * This is the check that makes the stamp worth having. Without it, a build can
 * succeed end to end and still ship an exe that Task Manager renders as
 * "Electron" with Electron's icon, because that identity lives in the PE version
 * resource rather than in anything the app controls at runtime.
 *
 * The original bug was exactly this: packaging reported success, the installer
 * installed and ran correctly, and nothing anywhere complained -- but the process
 * was indistinguishable from any other Electron app in Task Manager.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
// Optional argument: the unpacked directory of an out-of-tree build. Defaults to the
// one `npm run package` produces.
const UNPACKED = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'release', 'win-unpacked')

function findAppExe() {
  if (!fs.existsSync(UNPACKED)) return null
  const exes = fs
    .readdirSync(UNPACKED)
    .filter((f) => f.toLowerCase().endsWith('.exe'))
    .filter((f) => !/^uninstall/i.test(f))
  return exes.length === 1 ? path.join(UNPACKED, exes[0]) : null
}

const exe = findAppExe()
if (!exe) {
  console.error('verify-exe: no packaged app executable found - run `npm run package` first')
  process.exit(1)
}

// PowerShell is the only thing on the box that reads a PE version resource.
// Joined with newlines: a semicolon before the first key makes `@{;` a syntax
// error, so the statement list has to be line-separated inside the hashtable.
const ps = [
  `$v = (Get-Item '${exe.replace(/'/g, "''")}').VersionInfo`,
  '[PSCustomObject]@{',
  '  FileDescription  = $v.FileDescription',
  '  ProductName      = $v.ProductName',
  '  CompanyName      = $v.CompanyName',
  '  FileVersion      = $v.FileVersion',
  '  OriginalFilename = $v.OriginalFilename',
  '} | ConvertTo-Json -Compress',
].join('\n')

const info = JSON.parse(execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }))
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

console.log(`verify-exe: ${path.basename(exe)}`)
for (const [k, v] of Object.entries(info)) console.log(`  ${k.padEnd(17)} ${v}`)

const expected = {
  ProductName: 'Rewind',
  CompanyName: 'Rewind',
  FileVersion: pkg.version,
  OriginalFilename: 'Rewind.exe',
}

const bad = []
if (info.ProductName !== expected.ProductName) {
  bad.push(`ProductName is "${info.ProductName}", expected "${expected.ProductName}"`)
}
if (info.CompanyName !== expected.CompanyName) {
  bad.push(`CompanyName is "${info.CompanyName}", expected "${expected.CompanyName}"`)
}
if (!String(info.FileVersion).startsWith(expected.FileVersion)) {
  bad.push(`FileVersion is "${info.FileVersion}", expected ${expected.FileVersion}`)
}
if (info.OriginalFilename && info.OriginalFilename !== expected.OriginalFilename) {
  bad.push(`OriginalFilename is "${info.OriginalFilename}", expected "${expected.OriginalFilename}"`)
}

if (bad.length) {
  console.error('\nverify-exe: FAILED - the executable still identifies as something else:')
  for (const b of bad) console.error(`  - ${b}`)
  console.error('\n  Task Manager will show this app under the wrong name and icon.')
  console.error('  Run `npm run package` (which now stamps before rebuilding the installer).')
  process.exit(1)
}

console.log('\nverify-exe: OK - Task Manager will show Rewind with the brand icon')
