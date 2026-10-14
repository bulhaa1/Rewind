import { scope } from './logger.js'
import { getSetting, setSetting } from './store.js'
import { titleWithHotkey } from '@shared/constants.js'
import type { HotkeyAction } from '@shared/types.js'

const log = scope('Hotkey')

export type { HotkeyAction }

interface HotkeySpec {
  setting: 'saveReplayHotkey' | 'quickClipHotkey' | 'screenshotHotkey' | 'toggleRecordHotkey'
  label: string
}

export const HOTKEYS: Record<HotkeyAction, HotkeySpec> = {
  'save-replay': { setting: 'saveReplayHotkey', label: 'Save Replay' },
  'save-quick-clip': { setting: 'quickClipHotkey', label: 'Save Quick Clip' },
  screenshot: { setting: 'screenshotHotkey', label: 'Screenshot' },
  'toggle-record': { setting: 'toggleRecordHotkey', label: 'Start / Stop Recording' },
}

export const ACTIONS: HotkeyAction[] = Object.keys(HOTKEYS) as HotkeyAction[]

/** Normalized modifiers, most-canonical-name-first for matching a pressed combo. */
const MODIFIERS: Record<string, string[]> = {
  ctrl: ['CommandOrControl', 'Control', 'Ctrl'],
  alt: ['Alt', 'Option', 'AltGr'],
  shift: ['Shift'],
  meta: ['Command', 'Cmd', 'Super', 'Meta'],
}

type UiohookKeyName = keyof typeof import('uiohook-napi').UiohookKey

/**
 * Character -> keycode map.
 *
 * US-layout character keys produce a keycode that doesn't match the plain character
 * on some layouts, so each is pinned explicitly rather than derived from charCodeAt.
 */
const CHAR_TO_KEY: Record<string, number> = (() => {
  const K = require('uiohook-napi').UiohookKey as Record<string, number>
  return {
    ';': K.Semicolon, ':': K.Semicolon,
    '=': K.Equal, '+': K.Equal,
    ',': K.Comma, '<': K.Comma,
    '-': K.Minus, _: K.Minus,
    '.': K.Period, '>': K.Period,
    '/': K.Slash, '?': K.Slash,
    '`': K.Backquote, '~': K.Backquote,
    '[': K.BracketLeft, '{': K.BracketLeft,
    '\\': K.Backslash, '|': K.Backslash,
    ']': K.BracketRight, '}': K.BracketRight,
    "'": K.Quote, '"': K.Quote,
    '!': K[1], '@': K[2], '#': K[3], $: K[4],
    '%': K[5], '^': K[6], '&': K[7], '*': K[8],
    '(': K[9], ')': K[0],
  }
})()

interface ParsedHotkey {
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
  keycode: number
}

/** Parses `Alt+1` into modifier flags plus a keycode. Returns null if unsupported. */
export function parseHotkey(spec: string): ParsedHotkey | null {
  const parsed: ParsedHotkey = { ctrl: false, alt: false, shift: false, meta: false, keycode: -1 }
  let keyPart: string | null = null

  for (const raw of spec.split('+').map((s) => s.trim()).filter(Boolean)) {
    const modifier = Object.keys(MODIFIERS).find((m) => MODIFIERS[m].includes(raw))
    if (modifier) {
      parsed[modifier as 'ctrl' | 'alt' | 'shift' | 'meta'] = true
    } else {
      keyPart = raw
    }
  }

  if (keyPart === null) return null

  const uio = require('uiohook-napi').UiohookKey as Record<string, number>
  let keycode: number | undefined = typeof uio[keyPart] === 'number' ? uio[keyPart] : undefined

  if (keycode === undefined) {
    // Electron-style `Key1` names for the number row.
    const digit = /^Key(\d+)$/.exec(keyPart)
    if (digit) keycode = Number(digit[1])
  }
  if (keycode === undefined) keycode = CHAR_TO_KEY[keyPart]
  if (keycode === undefined) return null

  parsed.keycode = keycode
  return parsed
}

/** Modifier keys are held, not pressed; exclude them from capture. */
const MODIFIER_KEYS = (() => {
  const K = require('uiohook-napi').UiohookKey as Record<string, number>
  return new Set([K.Ctrl, K.CtrlRight, K.Alt, K.AltRight, K.Shift, K.ShiftRight, K.Meta, K.MetaRight])
})()

/** Reverse map for rendering a captured key back into a display string. */
const KEY_NAME = (() => {
  const K = require('uiohook-napi').UiohookKey as Record<string, number>
  const map = new Map<number, string>()
  for (const [name, code] of Object.entries(K)) {
    if (MODIFIER_KEYS.has(code)) continue
    map.set(code, name)
  }
  return map
})()

/** Renders a raw uiohook event as an Electron-style accelerator. */
export function formatHotkeyEvent(e: {
  keycode: number
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}): string | null {
  if (MODIFIER_KEYS.has(e.keycode) || e.keycode === require('uiohook-napi').UiohookKey.Escape) return null

  const parts: string[] = []
  if (e.ctrlKey) parts.push('CommandOrControl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (e.metaKey) parts.push('Super')
  parts.push(KEY_NAME.get(e.keycode) ?? `Key${e.keycode}`)
  return parts.join('+')
}

interface Registration {
  accelerator: string
  target: ParsedHotkey
  callback: () => void
  held: boolean
}

const registrations = new Map<HotkeyAction, Registration>()
let started = false
let startedOnce = false
let captureHandler: ((hotkey: string) => void) | null = null

function matches(pressed: ParsedHotkey, target: ParsedHotkey): boolean {
  return (
    pressed.keycode === target.keycode &&
    pressed.ctrl === target.ctrl &&
    pressed.alt === target.alt &&
    pressed.shift === target.shift &&
    pressed.meta === target.meta
  )
}

/** Finds another action already bound to this combination. */
export function conflictingAction(action: HotkeyAction, accelerator: string): HotkeyAction | null {
  const target = parseHotkey(accelerator)
  if (!target) return null
  for (const [other, reg] of registrations) {
    if (other !== action && matches(target, reg.target)) return other
  }
  return null
}

function onKeyDown(e: any): void {
  if (captureHandler) {
    const formatted = formatHotkeyEvent(e)
    if (formatted) captureHandler(formatted)
    return
  }

  const pressed: ParsedHotkey = {
    keycode: e.keycode,
    ctrl: !!e.ctrlKey,
    alt: !!e.altKey,
    shift: !!e.shiftKey,
    meta: !!e.metaKey,
  }

  for (const reg of registrations.values()) {
    // `held` makes the action fire on the initial press, not on auto-repeat.
    if (!matches(pressed, reg.target) || reg.held) continue
    reg.held = true
    reg.callback()
  }
}

function onKeyUp(e: any): void {
  for (const reg of registrations.values()) {
    if (e.keycode === reg.target.keycode) reg.held = false
  }
}

function ensureHookRunning(): void {
  const uio = require('uiohook-napi')

  if (!startedOnce) {
    uio.uIOhook.on('keydown', onKeyDown)
    uio.uIOhook.on('keyup', onKeyUp)
    startedOnce = true
  }

  if (started) return
  try {
    uio.uIOhook.start()
    started = true
  } catch (e) {
    log.error('Failed to start keyboard hook:', e)
  }
}

/**
 * Registers (or re-registers) a hotkey.
 *
 * Rebinding replaces the entry outright rather than diffing, so the uiohook listener
 * stays installed and only the in-process match table changes.
 */
export function registerHotkey(action: HotkeyAction, accelerator: string, callback: () => void): boolean {
  const target = parseHotkey(accelerator)
  if (!target) {
    log.warn(`Unsupported key combination: ${accelerator}`)
    return false
  }
  registrations.set(action, { accelerator, target, callback, held: false })
  ensureHookRunning()
  log.info(`Registered ${action}: ${accelerator}`)
  return true
}

/**
 * Installs the default hotkeys from settings.
 *
 * If the persisted bindings collide (e.g. both actions share a combo), the second is
 * left unbound and cleared so the user sees the conflict instead of one action
 * silently shadowing the other.
 */
export function installDefaultHotkeys(callbacks: Record<HotkeyAction, () => void>): void {
  for (const action of ACTIONS) {
    const accelerator = getSetting(HOTKEYS[action].setting)
    if (!accelerator) continue

    const conflict = conflictingAction(action, accelerator)
    if (conflict) {
      log.warn(
        `Stored ${HOTKEYS[action].label} hotkey (${accelerator}) is already bound to ` +
        `${HOTKEYS[conflict].label}; leaving it unbound`,
      )
      setSetting(HOTKEYS[action].setting, '')
      continue
    }

    registerHotkey(action, accelerator, callbacks[action])
  }
}

export function getHotkeys(): Record<HotkeyAction, string> {
  return Object.fromEntries(ACTIONS.map((a) => [a, getSetting(HOTKEYS[a].setting)])) as Record<HotkeyAction, string>
}

/**
 * A popup title for a hotkey action: `<outcome> — <bound key>`.
 *
 * The binding is read from settings at call time, so a rebind shows in the very
 * next popup. An unbound action still names the outcome.
 */
export function hotkeyTitle(action: HotkeyAction, outcome: string): string {
  return titleWithHotkey(outcome, getSetting(HOTKEYS[action].setting))
}

/** Streams the next key press back to the renderer for the rebind dialog. */
export function startCapture(handler: (hotkey: string) => void): void {
  captureHandler = handler
  ensureHookRunning()
}

export function stopCapture(): void {
  captureHandler = null
  for (const reg of registrations.values()) reg.held = false
}

/** Tears the hook down entirely; call on app exit. */
export function shutdown(): void {
  registrations.clear()
  captureHandler = null
  if (!started) return
  try {
    require('uiohook-napi').uIOhook.stop()
    started = false
    log.info('Keyboard hook stopped')
  } catch (e) {
    log.warn('Failed to stop keyboard hook on shutdown:', e)
  }
}