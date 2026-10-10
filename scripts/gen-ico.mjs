/**
 * Packs the rendered PNGs into a Windows .ico.
 *
 * The previous icon was a single 256px entry. That is why small renderings looked
 * soft: `nativeImage.createFromPath` has one image to work with, so the tray's
 * 16px is a downscale of the 256 rather than its own artwork. A real multi-entry
 * ICO lets Windows pick the exact size it wants.
 *
 * Entries are stored as PNG, which Windows has accepted for icons since Vista and
 * which avoids re-encoding. Every size below is present rather than a convenient
 * range, because those are the sizes Windows actually asks for: 16/20/24 for the
 * tray at 100/125/150% scaling, 32 for the shell at high DPI, 48 for the taskbar
 * and title bar, and 256 for the desktop and installer.
 */
import fs from 'node:fs'
import path from 'node:path'

const SIZES = [16, 20, 24, 32, 48, 64, 128, 256]
const ICON_DIR = 'assets/icon'
const OUT = 'assets/favicon.ico'

const images = SIZES.map((size) => {
  const file = path.join(ICON_DIR, `icon-${size}.png`)
  if (!fs.existsSync(file)) {
    throw new Error(`missing ${file} - run scripts/logo-sizes.ps1 first`)
  }
  return { size, data: fs.readFileSync(file) }
})

// A PNG signature where the directory entry expects raw pixels is the one case
// worth catching: it produces a file Windows silently refuses rather than errors.
for (const img of images) {
  const isPng =
    img.data[0] === 0x89 && img.data[1] === 0x50 && img.data[2] === 0x4e && img.data[3] === 0x47
  if (!isPng) throw new Error(`icon-${img.size}.png is not a PNG`)
}

const HEADER = 6
const ENTRY = 16
let offset = HEADER + ENTRY * images.length

const header = Buffer.alloc(HEADER)
header.writeUInt16LE(0, 0) // reserved
header.writeUInt16LE(1, 2) // type: icon
header.writeUInt16LE(images.length, 4)

const directory = Buffer.alloc(ENTRY * images.length)
images.forEach((img, i) => {
  const at = i * ENTRY
  // 256 is encoded as 0; the field is a single byte and 256 does not fit.
  directory.writeUInt8(img.size >= 256 ? 0 : img.size, at + 0)
  directory.writeUInt8(img.size >= 256 ? 0 : img.size, at + 1)
  directory.writeUInt8(0, at + 2) // palette size; 0 for truecolour
  directory.writeUInt8(0, at + 3) // reserved
  directory.writeUInt16LE(1, at + 4) // colour planes
  directory.writeUInt16LE(32, at + 6) // bits per pixel
  directory.writeUInt32LE(img.data.length, at + 8)
  directory.writeUInt32LE(offset, at + 12)
  offset += img.data.length
})

fs.writeFileSync(OUT, Buffer.concat([header, directory, ...images.map((i) => i.data)]))

const bytes = fs.statSync(OUT).size
console.log(`${OUT}: ${images.length} entries (${SIZES.join(', ')}), ${(bytes / 1024).toFixed(1)} KB`)

// Read the header back rather than trusting the write. A truncated or malformed
// icon does not throw at load time -- Windows just falls back to a blank glyph,
// which is exactly the failure this file exists to prevent.
const back = fs.readFileSync(OUT)
if (back.readUInt16LE(0) !== 0 || back.readUInt16LE(2) !== 1) {
  throw new Error('written header is not an icon')
}
if (back.readUInt16LE(4) !== images.length) {
  throw new Error('entry count mismatch')
}
for (let i = 0; i < images.length; i++) {
  const at = 6 + i * ENTRY
  const declared = back.readUInt32LE(at + 8)
  const start = back.readUInt32LE(at + 12)
  if (start + declared > back.length) {
    throw new Error(`entry ${i} points past the end of the file`)
  }
}
console.log('verified: header, entry count and every offset')
