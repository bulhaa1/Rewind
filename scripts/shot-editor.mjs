/**
 * Screenshot of the editor window, for a look-and-fix pass.
 *
 * Runs through the shared CDP driver (so CDP_PORT is honoured) and writes a PNG to
 * %TEMP%/rewind-shots/. The editor window must already be open.
 *
 * Run: node scripts/cdp.mjs scripts/shot-editor.mjs editor=1 [name]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export default async function ({ send, url }) {
  const out = path.join(os.tmpdir(), 'rewind-shots')
  fs.mkdirSync(out, { recursive: true })
  const name = process.argv[4] ?? 'editor'
  // A backgrounded window is not composited, so the surface capture would hang.
  await send('Page.bringToFront')
  const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: false })
  const file = path.join(out, `${name}.png`)
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
  console.log(`attached to: ${(url || '').slice(0, 60)}`)
  console.log(`screenshot: ${file}`)
}
