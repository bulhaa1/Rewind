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
 * The capture scanner.
 *
 * Concentric rings with a sweep rotating while the engine is capturing. It
 * replaces a 300-degree arc that filled as the buffer accumulated.
 *
 * The change was not only aesthetic. A filling arc is a *quantity*, and it had to
 * be fed a quantity to work: the panel ran a one-second timer purely so the arc
 * would re-render, and that timer existed only because the arc could not move
 * without it. A rotation expresses no amount, so it needs no data and no timer --
 * one less thing running while the panel is open.
 *
 * It also echoes the dial in the brand mark, so the status indicator and the logo
 * are the same object rather than two unrelated graphics.
 *
 * The motion is decoration and is honestly so: it says the engine is live, not
 * how much is buffered. Anything shaped like a meter has to be careful about that
 * distinction -- the previous arc briefly derived its fill from `Date.now()` and
 * showed a plausible level that meant nothing, which is worse than showing none.
 */
export function ScannerSweep({
  active,
  size = 72,
}: {
  /** The engine is capturing. Motion stops when this is false. */
  active: boolean
  size?: number
}) {
  const c = 32

  /** An arc on the circle of radius `r`, from `from` to `to` degrees. */
  const arc = (r: number, from: number, to: number) => {
    const p = (deg: number) => [
      c + r * Math.cos((deg * Math.PI) / 180),
      c + r * Math.sin((deg * Math.PI) / 180),
    ]
    const [x1, y1] = p(from)
    const [x2, y2] = p(to)
    const large = Math.abs(to - from) > 180 ? 1 : 0
    return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`
  }

  const R = 30
  // A bright leading edge with three segments fading out behind it.
  const tail = [
    { from: 0, to: -7, opacity: 0.95 },
    { from: -9.5, to: -16.5, opacity: 0.5 },
    { from: -19, to: -26, opacity: 0.28 },
    { from: -28.5, to: -35.5, opacity: 0.14 },
  ]

  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden className="block">
      {/* Track rings. Concentric, so rotating them is invisible -- they stay put
          while the sweep moves across them. */}
      <g fill="none" stroke="currentColor">
        <circle cx={c} cy={c} r={R} strokeOpacity={0.12} strokeWidth={1} />
        <circle cx={c} cy={c} r={R - 8} strokeOpacity={0.08} strokeWidth={1} />
        <circle cx={c} cy={c} r={R - 16} strokeOpacity={0.05} strokeWidth={1} />
      </g>

      <g className={active ? 'rewind-scanner' : undefined}>
        <g fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
          {tail.map((s) => (
            <path key={s.from} d={arc(R, s.from, s.to)} strokeOpacity={active ? s.opacity : 0.12} />
          ))}
        </g>
        <circle cx={c} cy={c} r={1.8} fill="currentColor" fillOpacity={active ? 0.75 : 0.25} />
      </g>
    </svg>
  )
}