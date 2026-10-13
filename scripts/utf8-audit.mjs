/**
 * Two separate checks that a naive UTF-8 validation cannot make.
 *
 * **Invalid UTF-8** -- bytes that do not decode. Handled with a fatal
 * TextDecoder, unchanged.
 *
 * **Mojibake** -- text that IS valid UTF-8 but has been double-encoded: a real
 * em-dash (U+2014) written as Windows-1252 bytes and then read back as UTF-8
 * becomes three perfectly legal characters, U+00E2 U+20AC U+201D. A validity
 * check passes it, and a user sees `â€”` in the interface.
 *
 * Three strings shipped that way in 1.0.1 -- two status labels and a source
 * placeholder -- and the existing audit reported zero problems, because it was
 * only ever looking for the first kind.
 *
 * This file necessarily contains the byte sequences it detects, so it excludes
 * itself; otherwise it fails permanently on its own detector.
 */
import fs from 'node:fs'
import path from 'node:path'

const roots = ['src', 'scripts']
const SELF = 'utf8-audit.mjs'

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(d, e.name)
  return e.isDirectory() ? walk(p) : /\.(ts|tsx|mjs|js|css|html|md)$/.test(e.name) ? [p] : []
})

const decoder = new TextDecoder('utf-8', { fatal: true })
const invalid = []
const mojibake = []

/*
 * U+00C3 followed by U+0080..U+00BF is UTF-8 read as Latin-1 -- the Ã© shape.
 * U+00E2 followed by U+20AC or U+0080 is the em-dash/ellipsis family, the
 * exact sequence this project shipped by accident.
 */
const MOJIBAKE = /\u00E2\u20AC|\u00E2\u0080|\u00C3[\u0080-\u00BF]/g

for (const root of roots) {
  for (const file of walk(root)) {
    if (path.basename(file) === SELF) continue

    const buf = fs.readFileSync(file)
    try {
      decoder.decode(buf)
    } catch {
      invalid.push(file)
      continue
    }

    const lines = buf.toString('utf8').split(/\r?\n/)
    lines.forEach((line, i) => {
      MOJIBAKE.lastIndex = 0
      if (MOJIBAKE.test(line)) {
        const at = line.search(MOJIBAKE)
        mojibake.push({
          file,
          line: i + 1,
          found: line.slice(Math.max(0, at - 20), at + 20).trim(),
        })
      }
    })
  }
}

// Show what the corruption actually looks like, not just that it exists.
for (const { file, line, found } of mojibake) {
  const codes = [...found]
    .map((c) => c.codePointAt(0))
    .filter((c) => c > 0x7f)
    .map((c) => 'U+' + c.toString(16).toUpperCase().padStart(4, '0'))
  console.log(`${file}:${line}  ${JSON.stringify(found)}  ${codes.join(' ')}`)
}

if (invalid.length) {
  for (const f of invalid) console.log(`${f}: (byte-level corruption, not valid UTF-8)`)
}

console.log(`\n${invalid.length} file(s) with invalid UTF-8`)
console.log(`${mojibake.length} line(s) with mojibake`)

if (invalid.length || mojibake.length) process.exit(1)