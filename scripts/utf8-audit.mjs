import fs from 'node:fs'
import path from 'node:path'

const roots = ['src', 'scripts']
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(d, e.name)
  return e.isDirectory() ? walk(p) : /\.(ts|tsx|mjs|js|css|html)$/.test(e.name) ? [p] : []
})

const decoder = new TextDecoder('utf-8', { fatal: true })
const bad = []
for (const r of roots) for (const f of walk(r)) {
  const buf = fs.readFileSync(f)
  try { decoder.decode(buf) } catch { bad.push(f) }
}

// Show what the corruption actually looks like, not just that it exists.
for (const f of bad) {
  const text = fs.readFileSync(f, 'utf8')
  const hits = [...text.matchAll(/[\uFFFD]|â€.|Ã./g)].slice(0, 3)
  console.log(`${f}: ${hits.map(h => JSON.stringify(h[0])).join(' ') || '(byte-level corruption)'}`)
}
console.log(`\n${bad.length} file(s) with invalid UTF-8`)
