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
 * - `EASE_OUT` for larger staged transitions where a spring's overshoot would
 *   read as wobble (dial ring sweeps, titlebar reveals).
 *
 * Mass comes from these curves, never from animating width/height/top/left.
 */
export const SPRING_SOFT: Transition = { type: 'spring', stiffness: 220, damping: 28 }

export const SPRING_SNAPPY: Transition = { type: 'spring', stiffness: 420, damping: 34 }

export const EASE_OUT: [number, number, number, number] = [0.32, 0.72, 0, 1]
