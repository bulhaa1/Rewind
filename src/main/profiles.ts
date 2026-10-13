import { ALLOWED_FPS, BUFFER_DURATION_MAX, BUFFER_DURATION_MIN, DEFAULT_PROFILES, VISUAL_QUALITIES } from '@shared/constants.js'
import { getSetting, setSetting } from './store.js'
import { scope } from './logger.js'
import type { Profile } from '@shared/types.js'

const log = scope('Profiles')

/** Four, like the numbered slots this is modelled on. */
export const PROFILE_COUNT = DEFAULT_PROFILES.length

/**
 * How much of the pipeline a switch has to rebuild.
 *
 * Ordered by cost: `duration` restarts the chain, `chain` rebuilds it, `full` takes
 * OBS down and back up (about ten seconds). A switch only ever pays the heaviest tier
 * its change needs, which is why the settings are diffed before anything is applied.
 */
export type ProfileTier = 'none' | 'duration' | 'chain' | 'full'

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(Math.round(value), min), max)

/** A stored profile, clamped and completed from the default for its slot. */
export function clampProfile(stored: Partial<Profile> | undefined, index: number): Profile {
  const fallback = DEFAULT_PROFILES[index] ?? DEFAULT_PROFILES[0]
  const name = typeof stored?.name === 'string' && stored.name.trim() ? stored.name.trim().slice(0, 24) : fallback.name
  const fps = ALLOWED_FPS.includes(stored?.fps as (typeof ALLOWED_FPS)[number]) ? (stored!.fps as number) : fallback.fps
  const visualQuality = VISUAL_QUALITIES.includes(stored?.visualQuality as never)
    ? stored!.visualQuality!
    : fallback.visualQuality
  const bufferDuration =
    typeof stored?.bufferDuration === 'number'
      ? clamp(stored.bufferDuration, BUFFER_DURATION_MIN, BUFFER_DURATION_MAX)
      : fallback.bufferDuration
  return { name, bufferDuration, fps, visualQuality }
}

/** The stored profiles, padded to four, plus which one the live settings belong to. */
export function getProfiles(): { profiles: Profile[]; activeProfile: number } {
  const stored = getSetting('profiles') as Partial<Profile>[] | undefined
  const profiles = Array.from({ length: PROFILE_COUNT }, (_, i) => clampProfile(stored?.[i], i))
  const active = getSetting('activeProfile')
  return {
    profiles,
    activeProfile: Number.isInteger(active) && active >= 0 && active < PROFILE_COUNT ? active : 0,
  }
}

/** Which tier a switch from `current` to `target` needs. Pure, so the test can pin it. */
export function planProfileChange(
  current: { fps: number; visualQuality: string; bufferDuration: number },
  target: Profile,
): ProfileTier {
  if (current.fps !== target.fps) return 'full'
  if (current.visualQuality !== target.visualQuality) return 'chain'
  if (current.bufferDuration !== target.bufferDuration) return 'duration'
  return 'none'
}

/**
 * Copies the live settings back into the active profile.
 *
 * Without this, editing the buffer length in Settings and then switching away and back
 * would silently undo the edit: the profile is a stored value, and the live settings
 * are what the user just changed.
 */
export function captureActiveProfileValues(): void {
  const { profiles, activeProfile } = getProfiles()
  const next = { ...profiles[activeProfile] }
  next.bufferDuration = getSetting('bufferDuration')
  next.fps = getSetting('fps')
  next.visualQuality = getSetting('visualQuality')
  const before = profiles[activeProfile]
  if (
    before.bufferDuration === next.bufferDuration &&
    before.fps === next.fps &&
    before.visualQuality === next.visualQuality
  ) {
    return
  }
  profiles[activeProfile] = next
  setSetting('profiles', profiles)
  log.info(`Profile ${activeProfile} (${next.name}) updated from the live settings`)
}

/** Writes one profile's fields. `patch` is already validated by the caller. */
export function writeProfileValues(index: number, patch: Partial<Profile>): Profile {
  const { profiles } = getProfiles()
  const merged = clampProfile({ ...profiles[index], ...patch }, index)
  profiles[index] = merged
  setSetting('profiles', profiles)
  return merged
}
