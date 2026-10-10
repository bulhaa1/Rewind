/*
 * Rewind mark.
 *
 * The dial from the brand artwork: a ring with a play triangle, which is what the
 * app actually does -- it holds the last few seconds and hands them back.
 *
 * This used to be an inline arc-and-dot drawn in currentColor. Three copies of
 * that shape had drifted apart (this file, assets/logo.svg, and the icon
 * generator each defined their own gap and dot), and the header showed a
 * different glyph from the installed app icon. An asset has one definition.
 *
 * icon-32 rather than a 24px render: the header draws this at 18px, and a 32px
 * source keeps it sharp on a high-DPI display. It is the reduced mark -- ring and
 * play, no tick marks -- because at that size the ticks are noise.
 */
import markUrl from '@assets/icon/icon-32.png'

export function RewindMark({ className = 'h-6 w-6' }: { className?: string }) {
  return <img src={markUrl} alt="" aria-hidden className={className} draggable={false} />
}

/**
 * The buffer sweep.
 *
 * A 300 degree arc that fills clockwise as the rolling buffer accumulates, with a
 * tick at the limit. This is the app's one signature element: nothing else in a
 * capture utility is time-shaped, so it is immediately legible as "how much past
 * is safe to save".
 */
export function BufferArc({
  progress,
  active,
  size = 76,
}: {
  /** 0..1 of the buffer filled. */
  progress: number
  active: boolean
  size?: number
}) {
  const stroke = 5
  const r = 40
  const circumference = 2 * Math.PI * r
  // 300 degree sweep, leaving a gap at the bottom for the readout.
  const track = circumference * (300 / 360)

  return (
    <svg width={size} height={size} viewBox="0 0 100 100" className="-rotate-[90deg]" aria-hidden>
      <circle
        cx="50"
        cy="50"
        r={r}
        fill="none"
        strokeWidth={stroke}
        className="stroke-line"
        strokeLinecap="round"
        strokeDasharray={`${track} ${circumference}`}
      />
      {active ? (
        <circle
          cx="50"
          cy="50"
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          // Transitions between ticks rather than stepping once a second, so the
          // sweep advances continuously instead of ticking along the ring.
          className="stroke-accent transition-[stroke-dasharray] duration-1000 ease-linear motion-reduce:transition-none"
          strokeDasharray={`${track * Math.max(0.02, Math.min(1, progress))} ${circumference}`}
        />
      ) : (
        <circle
          cx="50"
          cy="50"
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          className="stroke-line-strong"
          strokeDasharray={`${track * 0.02} ${circumference}`}
        />
      )}
    </svg>
  )
}