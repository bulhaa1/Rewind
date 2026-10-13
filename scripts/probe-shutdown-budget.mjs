#!/usr/bin/env node
/**
 * A recording in flight must get a longer teardown budget than a plain quit.
 *
 * The stitch runs inside `withTimeout(obsCore.shutdown(), budget)`; a recording is
 * joined segment by segment on the way out (one remux plus one probe per segment),
 * so the 8-second plain budget is not enough for a long one and the file is
 * orphaned when it fires. This pins the rule the wiring then uses: the budget is
 * chosen by whether a recording is running.
 *
 * The full quit is not automatable here (no IPC reaches `app.quit()`), so this
 * pins the decision, and the wiring is three lines reviewed with it.
 */
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const out = path.join(root, 'node_modules', '.cache', 'rewind-probe', 'shutdown-budget.cjs')
fs.mkdirSync(path.dirname(out), { recursive: true })
await build({
  entryPoints: [path.join(root, 'src/shared/constants.ts')],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
})

const { TIMING, shutdownBudgetMs } = require(out)

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`)
  if (!ok) failures++
}

/** Guards the calls so a missing export fails the checks rather than throwing. */
const budget = (recording) => (typeof shutdownBudgetMs === 'function' ? shutdownBudgetMs(recording) : NaN)

check('a plain shutdown keeps the existing budget', budget(false) === TIMING.SHUTDOWN, `${budget(false)} vs ${TIMING.SHUTDOWN}`)
check('a recording gets longer than a plain shutdown', budget(true) > budget(false), `${budget(true)} vs ${budget(false)}`)
check('a recording gets at least a minute', budget(true) >= 60_000, `${budget(true)}ms`)

console.log(`\n${failures ? `${failures} check(s) failed` : 'all checks passed'}`)
process.exit(failures ? 1 : 0)
