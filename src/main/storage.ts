import fs from 'node:fs'
import path from 'node:path'

/**
 * Disk usage for the Storage settings section.
 *
 * Deliberately separate from `scanClips`: that one runs an ffmpeg probe per clip
 * whose metadata is missing or stale, which is the right cost for a library view and
 * the wrong one for a size readout. This walks the tree and stats files only.
 */

/** Bytes and file count under `dir`, recursively. A missing or unreadable path is 0. */
export async function dirUsage(dir: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0
  let files = 0

  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return { bytes, files }
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const inner = await dirUsage(full)
      bytes += inner.bytes
      files += inner.files
    } else if (entry.isFile()) {
      try {
        bytes += (await fs.promises.stat(full)).size
        files++
      } catch {
        /* vanished mid-scan; nothing to count */
      }
    }
  }

  return { bytes, files }
}

/** Free and total bytes on the volume holding `dir`. */
export async function volumeSpace(dir: string): Promise<{ freeBytes: number; totalBytes: number }> {
  try {
    const st = await fs.promises.statfs(dir)
    return { freeBytes: st.bavail * st.bsize, totalBytes: st.blocks * st.bsize }
  } catch {
    return { freeBytes: 0, totalBytes: 0 }
  }
}
