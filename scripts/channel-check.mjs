/**
 * Fails when an IPC channel is declared but never handled.
 *
 * The gap this exists to catch: `set-mic-gain` shipped in 1.0.1 with the channel
 * declared in `shared/ipc.ts`, exposed on the preload bridge, typed in the renderer
 * API and called from Settings -- and no `ipcMain` handler. The slider threw "No
 * handler registered" on every drag. It typechecked, it built, and every existing
 * check passed, because nothing in this project compared the declared set against
 * the handled set.
 *
 * Three registration shapes are recognised, because the codebase uses all three:
 *
 *   handle(IPC.name, ...)                 the envelope used by almost every channel
 *   ipcMain.handle(IPC.name, ...)         a few bypass the envelope
 *   toggle(IPC.getName, IPC.setName, ...) one call registering a PAIR of channels
 *
 * The `toggle()` pattern is not optional. Omitting it reports six false positives
 * for channels that are correctly registered through the helper at `ipc.ts:1091`,
 * and a check that cries wolf gets deleted.
 *
 * Exits 0 when every declared channel is handled, 1 with the list when not.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const shared = fs.readFileSync(path.join(root, 'src/shared/ipc.ts'), 'utf8')

/** Every `name: 'channel'` entry in the IPC object literal. */
const declared = new Map()
for (const m of shared.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*'([^']+)'/g)) {
  declared.set(m[1], m[2])
}

const mainDir = path.join(root, 'src/main')
const handled = new Set()
for (const file of fs.readdirSync(mainDir).filter((f) => f.endsWith('.ts'))) {
  const text = fs.readFileSync(path.join(mainDir, file), 'utf8')

  // handle(IPC.x, ...) and ipcMain.handle(IPC.x, ...)
  for (const m of text.matchAll(/(?:ipcMain\.)?handle\(\s*IPC\.([A-Za-z_$][\w$]*)/g)) {
    handled.add(m[1])
  }

  // toggle(IPC.getX, IPC.setX, ...) -- registers both from one call. The arguments
  // span lines in the launchOnStartup case, so the whitespace class must include
  // newlines (it does: \s matches \n in JavaScript regex).
  for (const m of text.matchAll(/toggle\(\s*IPC\.([A-Za-z_$][\w$]*)\s*,\s*IPC\.([A-Za-z_$][\w$]*)/g)) {
    handled.add(m[1])
    handled.add(m[2])
  }
}

const missing = [...declared.entries()].filter(([name]) => !handled.has(name))

console.log(`channels declared: ${declared.size}  handled: ${handled.size}`)

if (missing.length) {
  console.log(`\nDECLARED BUT NEVER HANDLED (${missing.length}):`)
  for (const [name, channel] of missing) console.log(`  IPC.${name} -> '${channel}'`)
  process.exit(1)
}

console.log('all declared channels have a handler')