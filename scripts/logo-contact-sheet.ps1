# Renders a contact sheet for judging the mark at real sizes.
#
# Viewing a 16px icon scaled up with smooth interpolation flatters it. What the
# user actually gets is the raw pixel grid, so the magnified row here uses
# nearest-neighbour on purpose: every block is one real pixel, and if the ring
# closes up or the play triangle fills in, that is what gets shown.
param(
  [string]$IconDir = 'assets\icon',
  [string]$Out = 'assets\icon\_contact-sheet.png'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

# The app's own canvas colour, so contrast is judged against the real background
# rather than against white.
$CANVAS = [System.Drawing.Color]::FromArgb(255, 0x16, 0x15, 0x1a)
$INK = [System.Drawing.Color]::FromArgb(255, 0xB4, 0xB2, 0xBA)
$INK_DIM = [System.Drawing.Color]::FromArgb(255, 0x6E, 0x6C, 0x76)

function Load-Png($p) {
  $i = [System.Drawing.Image]::FromFile((Resolve-Path $p).Path)
  $b = New-Object System.Drawing.Bitmap($i); $i.Dispose(); return $b
}

$sizes = @(16, 20, 24, 32, 48, 64)
$zoom = 8
$pad = 16
$labelH = 18

# Top row: true size. Bottom row: nearest-neighbour magnification.
$trueW = ($sizes | Measure-Object -Sum).Sum + $pad * ($sizes.Count + 1)
$magW = 0
foreach ($s in $sizes) { if ($s -le 32) { $magW += $s * $zoom + $pad } }
$magW += $pad
$biggest = 256

$W = [math]::Max($trueW, $magW + 300)
$H = 40 + $labelH + 16 + $labelH + 16 + $biggest + 40

$sheet = New-Object System.Drawing.Bitmap $W, $H, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($sheet)
$g.Clear($CANVAS)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
$font = New-Object System.Drawing.Font 'Consolas', 9
$fontBig = New-Object System.Drawing.Font 'Consolas', 11
$brush = New-Object System.Drawing.SolidBrush $INK
$brushDim = New-Object System.Drawing.SolidBrush $INK_DIM

$g.DrawString('actual size, on the app canvas', $fontBig, $brush, $pad, 16)
$x = $pad
$y = 44
foreach ($s in $sizes) {
  $b = Load-Png (Join-Path $IconDir ("icon-{0}.png" -f $s))
  $g.DrawImage($b, $x, $y, $s, $s)
  $g.DrawString("$s", $font, $brushDim, $x, $y + $s + 3)
  $x += $s + $pad
  $b.Dispose()
}

$g.DrawString('nearest-neighbour, one block = one real pixel', $fontBig, $brush, $pad, ($y + 72))
$x = $pad
$y2 = $y + 100
foreach ($s in @(16, 20, 24, 32)) {
  $b = Load-Png (Join-Path $IconDir ("icon-{0}.png" -f $s))
  $g.DrawImage($b, $x, $y2, ($s * $zoom), ($s * $zoom))
  $g.DrawString("$s", $font, $brushDim, $x, $y2 + ($s * $zoom) + 3)
  $x += ($s * $zoom) + $pad
  $b.Dispose()
}

$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.DrawString('48 / 64 / 128 / 256', $fontBig, $brush, $x + 20, $y2)
$bx = $x + 20
$by = $y2 + 24
foreach ($s in @(48, 64, 128)) {
  $b = Load-Png (Join-Path $IconDir ("icon-{0}.png" -f $s))
  $g.DrawImage($b, $bx, $by, $s, $s)
  $g.DrawString("$s", $font, $brushDim, $bx, $by + $s + 3)
  $bx += $s + 16
  $b.Dispose()
}
$b = Load-Png (Join-Path $IconDir 'icon-256.png')
$g.DrawImage($b, $bx, $by, 256, 256)
$g.DrawString('256', $font, $brushDim, $bx, $by + 256 + 3)
$b.Dispose()

$g.Dispose()
$sheet.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$sheet.Dispose()
Write-Output ("wrote $Out")
