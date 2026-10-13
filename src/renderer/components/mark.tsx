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
