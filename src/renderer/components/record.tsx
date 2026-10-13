import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { api } from '../lib/api'
import { useHotkeyCapture } from './audio-controls'
import { Button, Dialog } from './ui'
import type { HotkeyAction } from '@shared/types.js'

const LABELS: Record<HotkeyAction, string> = {
  'save-replay': 'Save Replay',
  'save-quick-clip': 'Save Quick Clip',
  screenshot: 'Screenshot',
  'toggle-record': 'Start / Stop Recording',
}

/**
 * Hotkey rebinding dialog.
 *
 * Waits for the next global keypress and commits it. The dialog cannot be
 * dismissed while a capture is in flight, so a stray Escape cannot leave the
 * shortcut half-bound.
 */
export function HotkeyDialog({
  action,
  current,
  onClose,
  onSaved,
}: {
  action: HotkeyAction | null
  current: string
  onClose: () => void
  onSaved: (hotkey: string) => void
}) {
  const [value, setValue] = useState(current)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useHotkeyCapture(!!action, (hotkey) => {
    setValue(hotkey)
    setError(null)
  })

  // Re-seed when a different action opens the dialog.
  const [seed, setSeed] = useState(action)
  if (action !== seed) {
    setSeed(action)
    setValue(current)
    setError(null)
  }

  const submit = async () => {
    if (!action || busy) return
    setBusy(true)
    setError(null)
    const res = await api.setHotkey(action, value)
    setBusy(false)

    if (res.success) {
      onSaved(value)
      onClose()
    } else {
      setError(res.error || 'Failed to set hotkey')
    }
  }

  return (
    <Dialog
      open={!!action}
      title="Set hotkey"
      onClose={onClose}
      dismissible={!busy}
      footer={
        <>
          <Button variant="ghost" size="sm" className="flex-1" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" className="flex-1" onClick={() => void submit()} disabled={busy || !value}>
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Save'}
          </Button>
        </>
      }
    >
      <p className="mb-2 text-[13px] text-ink-muted">
        Press a key to bind <span className="text-ink">{action ? LABELS[action] : ''}</span>
      </p>
      <div
        className={
          'flex h-20 w-full items-center justify-center rounded-md border border-dashed px-3 ' +
          (value ? 'border-accent bg-accent-soft' : 'border-line bg-raised')
        }
      >
        <span className="tabular text-center text-base font-medium">
          {value || 'Unbound'}
        </span>
      </div>
      {error ? <p className="mt-1.5 text-[11px] text-danger">{error}</p> : null}
    </Dialog>
  )
}