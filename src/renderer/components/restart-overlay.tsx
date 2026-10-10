import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, RotateCcw } from 'lucide-react'
import { api } from '../lib/api'
import { useObsStatus } from '../lib/context'
import { Button } from './ui'

/**
 * How long the overlay waits before offering a way out.
 *
 * A restart normally takes a few seconds. If it is still going after this, the
 * engine is genuinely stuck, and a screen that only says "loading" forever is a
 * dead end — so a retry appears rather than leaving the app unusable.
 */
const RETRY_AFTER_MS = 20_000

/**
 * Shown while the engine is restarting.
 *
 * Changing a setting like frame rate or output resolution tears OBS down and
 * brings it back, which takes seconds. The old feedback for that was a line of
 * text in the footer of an otherwise fully interactive window: easy to miss, and
 * inviting clicks that land on a pipeline that is not there yet.
 *
 * So this covers the whole surface, takes input while it is up, and names what is
 * happening. It is driven purely by engine status, which means it cannot get stuck
 * on a stale event — and a retry appears if the wait runs long.
 */
export function RestartOverlay() {
  const { status, message } = useObsStatus()
  const [elapsed, setElapsed] = elapsedWhile(status === 'initializing')
  const [target, setTarget] = useState<HTMLElement | null>(null)

  useEffect(() => setTarget(document.body), [])

  if (status !== 'initializing' || !target) return null

  const stalled = elapsed >= RETRY_AFTER_MS
  const reason = message?.trim()

  /*
   * Boot versus restart.
   *
   * Both report `initializing`, but they are very different things to sit through:
   * one happens once at launch, the other is something you just asked for. Every
   * restart path names what it is doing, so the presence of a message is the
   * discriminator: no remembered state, and nothing that can drift out of step
   * with the engine. A bare `initializing` is therefore always the cold boot.
   */
  const booting = !reason

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex flex-col items-center justify-center gap-3 bg-canvas/78 px-8 text-center backdrop-blur-[3px]"
      role="alertdialog"
      aria-modal="true"
      aria-busy="true"
      aria-label={booting ? 'Starting the capture engine' : 'Restarting the capture engine'}
      // Swallow input outright rather than relying on the controls underneath being
      // disabled: they belong to a pipeline that is mid-restart and cannot answer.
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <Loader2 className="h-5 w-5 animate-spin text-accent" aria-hidden />

      <p className="text-[13px] font-medium">{booting ? 'Starting up' : 'Restarting the capture engine'}</p>

      <p className="max-w-[26ch] text-[11px] leading-snug text-ink-muted">
        {booting
          ? 'Getting the engine and your display ready.'
          : (reason ??
            'Applying your change. Anything you do now would be lost, so the app is paused until the engine is back.')}
      </p>

      {stalled && !booting ? (
        <>
          <p className="max-w-[30ch] text-[11px] leading-snug text-warn">
            Taking longer than usual. If it does not finish on its own, the engine can be restarted.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-1"
            onClick={() => {
              void api.retryOBSInit()
            }}
          >
            <RotateCcw className="h-3 w-3" />
            Restart engine
          </Button>
        </>
      ) : null}

      {/* Announces the state change rather than only showing it. */}
      <span className="sr-only" role="status" aria-live="assertive">
        {booting ? 'Starting the capture engine.' : `Restarting the capture engine.${reason ? ` ${reason}` : ''}`}
      </span>
    </div>,
    target,
  )
}

/** Ticks once a second while `active`, and resets the moment it turns false. */
function elapsedWhile(active: boolean): [number, (n: number) => void] {
  const [n, setN] = useState(0)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (timer.current) {
      clearInterval(timer.current)
      timer.current = null
    }
    if (!active) {
      setN(0)
      return
    }

    setN(0)
    timer.current = setInterval(() => setN((v) => v + 1), 1000)
    return () => {
      if (timer.current) clearInterval(timer.current)
      timer.current = null
    }
  }, [active])

  return [n * 1000, setN]
}
