import type { Transition } from 'motion/react'

/**
 * Shared motion presets.
 *
 * Two springs and one ease curve, so every surface moves like one machine:
 *
 * - `SPRING_SOFT` for things that change place — section swaps, pane moves,
 *   list layout shifts. Slow enough to read as weight, not as lag.
 * - `SPRING_SNAPPY` for things that answer a press: button release, card
 *   insert, a value settling. Fast, barely overshooting.
 *
 * Mass comes from these curves, never from animating width/height/top/left.
 */
export const SPRING_SOFT: Transition = { type: 'spring', stiffness: 220, damping: 28 }

export const SPRING_SNAPPY: Transition = { type: 'spring', stiffness: 420, damping: 34 }
