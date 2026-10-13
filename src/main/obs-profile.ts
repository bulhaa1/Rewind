import fs from 'node:fs'
import path from 'node:path'
/**
 * Writes the frame rate and output size into the OBS profile on disk.
 *
 * OBS's runtime settings API silently discards changes to `[Video]`: the write
 * reports success and the values read straight back unchanged, so the capture rate
 * stays at whatever the profile already said. The profile file is the only place the
 * setting actually takes, and OBS reads it while starting up — so this has to run
 * before `startup()`, which means a frame-rate change needs a full engine restart
 * rather than a live update.
 *
 * Always writes an explicit `FPSNum`/`FPSDen` pair and never relies on OBS's "common
 * values" shortcut. That shortcut stores an enum index (0 = highest, 1 = 30,
 * 2 = 60) whose meaning has shifted between OBS versions - a profile asking for 60
 * through it silently produced 30 fps here. Spelling the rate out with `FPSType=1`
 * is one path that behaves the same on every version, and it is the path verified to
 * produce a genuine 120 fps output.
 *
 * Every wanted key is ensured, not only the ones already present. The previous
 * version rewrote existing lines and left missing keys missing while still
 * reporting success — a profile without `FPSInt` stayed without it, OBS fell back
 * to its 30 fps default, and the caller logged "Profile written for 60 fps"
 * anyway. That is how a user can set 60 fps and record 30.
 *
 * @returns whether the profile file exists and was written.
 */
export function writeProfileVideoSettings(
  dir: string,
  out: { width: number; height: number },
  fps: number,
): boolean {
  const file = path.join(dir, 'basic.ini')
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return false
  }

  const whole = Math.max(1, Math.round(fps))
  const wanted: Record<string, string> = {
    BaseCX: String(out.width),
    BaseCY: String(out.height),
    OutputCX: String(out.width),
    OutputCY: String(out.height),
    // 1 = "Integer FPS Value": FPSNum and FPSDen are read literally.
    FPSType: '1',
    FPSInt: String(whole),
    FPSNum: String(whole),
    FPSDen: '1',
    // Rewritten even though this path ignores it. Leaving a stale enum index behind
    // gives OBS a second, contradictory answer to pick from on the next start.
    FPSCommon: '0',
  }

  const lines = text.split(/\r?\n/)

  // Locate the [Video] section. When the profile has none (a fresh or foreign
  // profile), one is appended so the frame rate can still be written.
  let videoStart = -1
  let videoEnd = lines.length
  for (let i = 0; i < lines.length; i++) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(lines[i])
    if (!header) continue
    if (videoStart === -1 && header[1].trim().toLowerCase() === 'video') {
      videoStart = i
      continue
    }
    if (videoStart !== -1) {
      videoEnd = i
      break
    }
  }
  if (videoStart === -1) {
    if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('')
    videoStart = lines.length
    lines.push('[Video]')
    videoEnd = lines.length
  }

  const seen = new Set<string>()
  for (let i = videoStart + 1; i < videoEnd; i++) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=/.exec(lines[i])
    if (!m) continue
    const key = m[1]
    if (!(key in wanted)) continue
    seen.add(key)
    lines[i] = `${key}=${wanted[key]}`
  }

  const missing = Object.keys(wanted).filter((k) => !seen.has(k))
  if (missing.length) {
    lines.splice(videoEnd, 0, ...missing.map((k) => `${k}=${wanted[k]}`))
  }

  try {
    fs.writeFileSync(file, lines.join('\n'), 'utf8')
    return true
  } catch {
    return false
  }
}
