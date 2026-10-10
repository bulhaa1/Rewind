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
 * @returns whether the profile was found and updated.
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
  let inVideo = false
  const seen = new Set<string>()

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*\[/.test(line)) {
      inVideo = line.trim().toLowerCase() === '[video]'
      continue
    }
    if (!inVideo) continue

    const m = /^\s*([A-Za-z0-9_]+)\s*=/.exec(line)
    if (!m) continue
    const key = m[1]
    if (!(key in wanted)) continue
    seen.add(key)
    lines[i] = `${key}=${wanted[key]}`
  }

  // A profile without the keys we expect would silently ignore everything, so report
  // that rather than pretending the write worked.
  if (!seen.size) return false

  try {
    fs.writeFileSync(file, lines.join('\n'), 'utf8')
    return true
  } catch {
    return false
  }
}