/**
 * Removes exported symbols that nothing imports.
 *
 * Operates on the source text rather than a full parse because the project is
 * plain TypeScript with no build-time transform: find the declaration, walk back
 * over an attached doc comment, then match braces to find where it ends. Anything
 * that cannot be removed unambiguously is reported instead of guessed at.
 *
 *   node scripts/prune-dead-exports.mjs [--dry]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')
const dry = process.argv.includes('--dry')

const NAMES = [
  'defaultDeviceName', 'deleteClipMeta', 'ffmpegThreads', 'obsPath', 'readProfileVideo',
  'uniqueScreenshotPath', 'isString', 'hotkeyString', 'isBool', 'intGE0', 'validBufferDuration',
  'pathExists', 'pathExistsSync', 'ensureDir', 'fileSizeMB', 'AddButton', 'Divider', 'hasBridge',
  'formatTime', 'formatDate', 'truncatePath', 'useFocusGuard', 'useInterval', 'audioSessionsQuery',
  'audioLevelsQuery', 'appVersionQuery', 'AUTO_GAME_CAPTURE', 'OBS_PIPE_PREFIX', 'VENDOR_LABELS',
  'WINDOW_LIST_TTL_MS',
]

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name)
    return e.isDirectory() ? walk(full) : /\.tsx?$/.test(e.name) ? [full] : []
  })
}

/** Removes `name` from `text`, returning the new text or null if not removable. */
function removeDeclaration(text, name) {
  const declRe = new RegExp(
    `^export\\s+(?:default\\s+)?(?:async\\s+)?(?:function|const|class|let)\\s+${name}\\b`,
    'm',
  )
  const m = declRe.exec(text)
  if (!m) return null

  const start = m.index

  // Walk backwards over an attached block comment and the blank line before it.
  let head = text.slice(0, start)
  const commentEnd = head.lastIndexOf('*/')
  if (commentEnd !== -1 && !head.slice(commentEnd).includes('\n\n')) {
    const commentStart = head.lastIndexOf('/**', commentEnd)
    if (commentStart !== -1) head = head.slice(0, commentStart)
  }
  head = head.replace(/\n[ \t]*$/, '')

  // Find where the declaration ends.
  const body = text.slice(start)
  const braceAt = body.indexOf('{')
  const lineEnd = body.indexOf('\n')
  let end
  if (braceAt !== -1 && (lineEnd === -1 || braceAt < lineEnd)) {
    let depth = 0
    let i = braceAt
    for (; i < body.length; i++) {
      if (body[i] === '{') depth++
      else if (body[i] === '}') {
        depth--
        if (depth === 0) { i++; break }
      }
    }
    end = start + i
  } else {
    end = start + (lineEnd === -1 ? body.length : lineEnd)
  }

  // Swallow one trailing newline so the file does not gain a gap.
  while (text[end] === '\n') end++

  return head + text.slice(end)
}

const files = walk(root)
let removed = 0
const failures = []

for (const file of files) {
  const original = fs.readFileSync(file, 'utf8')
  let text = original

  for (const name of NAMES) {
    const next = removeDeclaration(text, name)
    if (next !== null) {
      text = next
      removed++
      console.log(`removed ${name} from ${path.relative(root, file)}`)
    }
  }

  if (text !== original) {
    if (!dry) fs.writeFileSync(file, text, 'utf8')
  }
}

// Anything that survived was never found, which means the list is stale.
const all = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n')
for (const name of NAMES) {
  if ((all.match(new RegExp(`\\b${name}\\b`, 'g')) || []).length > 0) failures.push(name)
}

console.log(`\n${removed} declaration(s) removed${dry ? ' (dry run, nothing written)' : ''}`)
if (failures.length) console.log(`still present: ${failures.join(', ')}`)