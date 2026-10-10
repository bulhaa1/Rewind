/**
 * Repairs UTF-8 that was corrupted by a shell round-trip.
 *
 * `Set-Content` in Windows PowerShell writes the console's ANSI encoding, so an
 * em dash went into the file as the single byte 0x97, and a file that had already
 * been through it twice held the double-encoded form E2 80 94. Both render as
 * garbage and both make the file invalid UTF-8, which is what the design
 * detector reported.
 *
 * This rewrites those byte sequences as real UTF-8 rather than swapping the
 * encoding wholesale, so the surrounding text is untouched.
 */
import fs from 'node:fs'

const EM_DASH = '—'.repeat(1)

const files = process.argv.slice(2)
if (!files.length) {
  console.error('usage: node scripts/utf8-repair.mjs <file...>')
  process.exit(2)
}

for (const file of files) {
  const before = fs.readFileSync(file)
  const chunks = []
  let fixed = 0

  for (let i = 0; i < before.length; i++) {
    const b = before[i]

    // E2 80 94: the UTF-8 em dash after one lossy ANSI round-trip.
    if (b === 0xe2 && before[i + 1] === 0x80 && before[i + 2] === 0x94) {
      chunks.push(Buffer.from(EM_DASH, 'utf8'))
      i += 2
      fixed++
      continue
    }

    // 0x97: the em dash as Windows-1252 stores it.
    if (b === 0x97) {
      chunks.push(Buffer.from(EM_DASH, 'utf8'))
      fixed++
      continue
    }

    chunks.push(before.subarray(i, i + 1))
  }

  if (!fixed) {
    console.log(`${file}: nothing to repair`)
    continue
  }

  const after = Buffer.concat(chunks)

  // Never write something that is still not valid UTF-8.
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(after)
  } catch (e) {
    console.error(`${file}: still invalid after repair, not writing`)
    process.exitCode = 1
    continue
  }

  fs.writeFileSync(file, after)
  console.log(`${file}: repaired ${fixed} character(s)`)
}