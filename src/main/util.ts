import path from 'node:path'
import fs, { accessSync } from 'node:fs'

// Small helpers shared across the main process. Everything here is deliberately
// dependency-free and synchronous: these run inside IPC handlers and teardown
// paths where a promise would only add ways to leave an operation half-done.

/** Narrows untrusted IPC input to a non-empty string, trimming as it goes. */
export function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

/** Narrows untrusted IPC input to a bounded, non-empty string. */
export function shortString(v: unknown, max = 200): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max
}

/** True when `child` is `parent` or lives underneath it. Guards every file-handling IPC. */
export function isInside(child: string, parent: string): boolean {
  const a = path.normalize(path.resolve(child))
  const b = path.normalize(path.resolve(parent))
  return a === b || a.startsWith(b + path.sep)
}

/** Windows reserved device names; blocks the same renames the original rejected. */
const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i

export function isReservedDeviceName(name: string): boolean {
  return RESERVED.test(name)
}

/** Whether a path can actually be written to, checked without disturbing it. */
export function isWritable(p: string): boolean {
  try {
    accessSync(p, fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}
