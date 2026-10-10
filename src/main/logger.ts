import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

type Level = 'info' | 'warn' | 'error'

/**
 * Minimal append-only logger writing to `<userData>/logs/main.log`.
 *
 * Deliberately dependency-free: Reflect has no telemetry, and a self-contained
 * logger keeps that guarantee structural rather than a matter of configuration.
 */
class Logger {
  private file: string | null = null
  private mirrorToConsole = false

  init(): void {
    try {
      const dir = path.join(app.getPath('userData'), 'logs')
      fs.mkdirSync(dir, { recursive: true })
      this.file = path.join(dir, 'main.log')
      this.mirrorToConsole = !app.isPackaged
      // Rotate when the file gets large so a long session can't fill the disk.
      const st = fs.existsSync(this.file) ? fs.statSync(this.file) : null
      if (st && st.size > 16 * 1024 * 1024) {
        fs.renameSync(this.file, `${this.file}.1`)
      }
    } catch {
      this.file = null
    }
  }

  write(scope: string, level: Level, args: unknown[]): void {
    const line = `[${stamp()}] [${level}] [${scope}] ${args.map(fmt).join(' ')}\n`
    if (this.mirrorToConsole) {
      const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
      fn(line.trimEnd())
    }
    if (!this.file) return
    try {
      fs.appendFileSync(this.file, line, 'utf8')
    } catch {
      /* logging must never throw into the caller's control flow */
    }
  }
}

function stamp(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ` +
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

function fmt(v: unknown): string {
  if (typeof v === 'string') return v
  if (v instanceof Error) return v.stack ?? `${v.name}: ${v.message}`
  if (v === undefined) return 'undefined'
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

export const log = new Logger()

/** Returns a scoped logger, e.g. `const log = scope('ReplayBuffer')`. */
export function scope(name: string) {
  return {
    info: (...a: unknown[]) => log.write(name, 'info', a),
    warn: (...a: unknown[]) => log.write(name, 'warn', a),
    error: (...a: unknown[]) => log.write(name, 'error', a),
  }
}

export type ScopedLog = ReturnType<typeof scope>