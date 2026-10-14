import { ALLOWED_FPS, BUFFER_DURATION_MAX, BUFFER_DURATION_MIN, DEFAULT_PROFILES, VISUAL_QUALITIES } from '@shared/constants.js'
import { getSetting, setSetting } from './store.js'
import { scope } from './logger.js'
import type { Profile } from '@shared/types.js'

const log = scope('Profiles')

/**
 * How much of the pipeline a switch has to rebuild.
 *
 * Ordered by cost: `duration` restarts the chain, `chain` rebuilds it, `full` takes
 * OBS down and back up (about ten seconds). A switch only ever pays the heaviest tier
 * its change needs, which is why the settings are diffed before anything is applied.
 */
export type ProfileTier = 'none' | 'duration' | 'chain' | 'full'

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(Math.round(value), min), max)

/** A stored profile, clamped and completed from the defaults. */
export function clampProfile(stored: Partial<Profile> | undefined): Profile {
  const fallback = DEFAULT_PROFILES[0]
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

/** The stored profiles (never empty), plus which one the live settings belong to. */
export function getProfiles(): { profiles: Profile[]; activeProfile: number } {
  const stored = getSetting('profiles') as Partial<Profile>[] | undefined
  const profiles = Array.isArray(stored) && stored.length ? stored.map(clampProfile) : DEFAULT_PROFILES.map((p) => ({ ...p }))
  const active = getSetting('activeProfile')
  return {
    profiles,
    activeProfile: Number.isInteger(active) && active >= 0 && active < profiles.length ? active : 0,
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
 * are what the user just changed. The panel's "Save current settings" button calls the
 * same path explicitly.
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
  const merged = clampProfile({ ...profiles[index], ...patch })
  profiles[index] = merged
  setSetting('profiles', profiles)
  return merged
}

/** Appends a profile with the default values and a free name. */
export function addProfile(): { profiles: Profile[]; activeProfile: number } {
  const { profiles } = getProfiles()
  const base = 'Profile'
  const taken = new Set(profiles.map((p) => p.name))
  let name = base
  for (let n = profiles.length + 1; taken.has(name); n++) name = `${base} ${n}`
  profiles.push(clampProfile({ ...DEFAULT_PROFILES[0], name }))
  setSetting('profiles', profiles)
  return { profiles, activeProfile: getProfiles().activeProfile }
}

/** Inserts a copy of a profile right after it. The copy is never the active one. */
export function duplicateProfile(index: number): { profiles: Profile[]; activeProfile: number } {
  const { profiles, activeProfile } = getProfiles()
  const source = profiles[index]
  const base = `${source.name} copy`
  // Inserting above the active entry shifts it up; the stored index must follow.
  const nextActive = index + 1 <= activeProfile ? activeProfile + 1 : activeProfile
  profiles.splice(index + 1, 0, clampProfile({ ...source, name: base }))
  setSetting('profiles', profiles)
  setSetting('activeProfile', nextActive)
  return { profiles, activeProfile: nextActive }
}

/**
 * Removes a profile.
 *
 * The active one is refused, not silently remapped: the live settings are its values,
 * and re-pointing `activeProfile` at a neighbour would make the store claim settings
 * the engine is not running. One profile is also refused, so the list never empties.
 * Removing a profile above the active one shifts the indices down, so the stored
 * `activeProfile` moves with them.
 */
export function removeProfile(index: number): { profiles: Profile[]; activeProfile: number } | string {
  const { profiles, activeProfile } = getProfiles()
  if (profiles.length <= 1) return 'Cannot remove the only profile'
  if (index === activeProfile) return 'Switch to another profile before removing it'
  if (!profiles[index]) return 'Invalid profile'
  profiles.splice(index, 1)
  const nextActive = index < activeProfile ? activeProfile - 1 : activeProfile
  setSetting('profiles', profiles)
  setSetting('activeProfile', nextActive)
  return { profiles, activeProfile: nextActive }
}
