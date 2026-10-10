# Extracts the app's marks from the source artwork.
#
# The source is a 1407x768 PNG whose "transparency" is a checkerboard painted into
# the pixels: alpha is 255 everywhere, and the background sits at saturation 0-3
# while every sampled pixel of the artwork sits at 52 or above. That wide, flat
# gap is what makes the keying reliable without eating the pale highlights inside
# the logo.
#
# Four things are handled here that are not obvious:
#
#   - The checkerboard is composited *under* the artwork, so edge pixels are the
#     logo colour lifted toward grey. It is two flat greys on a fixed 16px
#     lattice, so the background under any pixel is known exactly and the edge
#     colour can be solved for. That is what keeps the edges from carrying a grey
#     halo.
#
#   - Format32bppArgb stores bytes as B, G, R, A in memory. Writing RGBA swaps
#     red and blue, and because the grey background is symmetric under a swap the
#     alpha mask still comes out perfect -- so the fault stays hidden until
#     someone looks at the colour.
#
#   - The dial is very slightly elliptical (rx/ry 0.94), so it is cropped square
#     and masked with a fitted ellipse rather than scaled square, which would
#     stretch it by about 6%.
#
#   - The flame is fused to the ring's upper-left arc, so no geometric mask can
#     separate them; any ellipse drawn around the dial slices the flame and
#     leaves a hard-edged wedge. Components are used instead: keep the ring and
#     whatever sits wholly inside it, drop whatever crosses it.
param(
  [string]$Source = 'C:\Users\user\Downloads\Logo for rewind.png',
  [string]$OutDir = 'assets',
  [double]$DialCx = 932,
  [double]$DialCy = 343,
  [double]$DialRx = 166,
  [double]$DialRy = 176
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

# Measured from the source: empty background is flat grey at these two levels,
# alternating on a 16px lattice.
$BG_LIGHT = 235
$BG_DARK = 189
$LATTICE = 16

# Alpha ramp. The flat background also carries faint tinted noise up to about 9,
# so the ramp starts at 12; the artwork's measured floor is 52, so ending at 34
# stays clear of it.
$SAT_ZERO = 12
$SAT_FULL = 34

# Content is bounded on pixels that are actually visible. Artwork is near-opaque,
# so anything under this is a stray that must not stretch the trim.
$BOX_MIN_ALPHA = 96

Write-Output "reading $Source"
$img = [System.Drawing.Image]::FromFile($Source)
$src = New-Object System.Drawing.Bitmap($img)
$W = $src.Width
$H = $src.Height

# --- pass 1: alpha from saturation, colour un-composited off the lattice ------
$argb = [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
$work = New-Object System.Drawing.Bitmap($W, $H, $argb)
$dst = New-Object System.Drawing.Rectangle 0, 0, $W, $H
$write = [System.Drawing.Imaging.ImageLockMode]::WriteOnly
$locked = $work.LockBits($dst, $write, $argb)
$stride = $locked.Stride
$bytes = New-Object byte[] ($stride * $H)

for ($y = 0; $y -lt $H; $y++) {
  for ($x = 0; $x -lt $W; $x++) {
    $c = $src.GetPixel($x, $y)
    $mx = [math]::Max($c.R, [math]::Max($c.G, $c.B))
    $mn = [math]::Min($c.R, [math]::Min($c.G, $c.B))
    $sat = $mx - $mn

    $i = $y * $stride + $x * 4
    if ($sat -le $SAT_ZERO) {
      $bytes[$i] = 0; $bytes[$i+1] = 0; $bytes[$i+2] = 0; $bytes[$i+3] = 0
      continue
    }
    if ($sat -ge $SAT_FULL) { $a = 255 }
    else { $a = [int](255 * ($sat - $SAT_ZERO) / ($SAT_FULL - $SAT_ZERO)) }

    # Solve C_obs = a*C_logo + (1-a)*C_bg for the logo colour.
    $parity = ([math]::Floor($x / $LATTICE) + [math]::Floor($y / $LATTICE)) % 2
    $bg = if ($parity -eq 0) { $BG_LIGHT } else { $BG_DARK }
    $af = $a / 255.0
    $inv = 1.0 - $af
    if ($inv -lt 0.02) { $inv = 0.02 }

    $bytes[$i]   = [byte][math]::Max(0, [math]::Min(255, [int](($c.B - $inv * $bg) / $af)))
    $bytes[$i+1] = [byte][math]::Max(0, [math]::Min(255, [int](($c.G - $inv * $bg) / $af)))
    $bytes[$i+2] = [byte][math]::Max(0, [math]::Min(255, [int](($c.R - $inv * $bg) / $af)))
    $bytes[$i+3] = [byte]$a
  }
  if ($y % 200 -eq 0) { Write-Output "  keyed $y/$H" }
}
[System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $locked.Scan0, $bytes.Length)
$work.UnlockBits($locked)
$src.Dispose(); $img.Dispose()
Write-Output 'keying done'

function Get-ContentBox([System.Drawing.Bitmap]$bmp) {
  $minX = $bmp.Width; $minY = $bmp.Height; $maxX = -1; $maxY = -1
  for ($y = 0; $y -lt $bmp.Height; $y += 2) {
    for ($x = 0; $x -lt $bmp.Width; $x += 2) {
      if ($bmp.GetPixel($x, $y).A -gt $BOX_MIN_ALPHA) {
        if ($x -lt $minX) { $minX = $x }
        if ($x -gt $maxX) { $maxX = $x }
        if ($y -lt $minY) { $minY = $y }
        if ($y -gt $maxY) { $maxY = $y }
      }
    }
  }
  return [pscustomobject]@{ X = $minX; Y = $minY; W = ($maxX - $minX + 1); H = ($maxY - $minY + 1) }
}

function Save-Png([System.Drawing.Bitmap]$bmp, [string]$path) {
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Output ("  wrote {0}  ({1}x{2}, {3} KB)" -f (Split-Path $path -Leaf), $bmp.Width, $bmp.Height, [math]::Round((Get-Item $path).Length / 1KB, 1))
}

# --- full mark ---------------------------------------------------------------
$box = Get-ContentBox $work
Write-Output ("full mark content box: x {0} y {1}  {2}x{3}" -f $box.X, $box.Y, $box.W, $box.H)
$fullRect = New-Object System.Drawing.Rectangle $box.X, $box.Y, $box.W, $box.H
$fullMark = $work.Clone($fullRect, $work.PixelFormat)
Save-Png $fullMark (Join-Path $OutDir 'logo-full.png')

# --- dial: square crop, elliptical mask, flame removed ------------------------
$side = [int]([math]::Max($DialRx, $DialRy) * 2 + 8)
$cropRect = New-Object System.Drawing.Rectangle `
  ([int]$DialCx - [int]($side / 2)), ([int]$DialCy - [int]($side / 2)), $side, $side
Write-Output ("dial crop rect: {0},{1}  {2}x{2}" -f $cropRect.X, $cropRect.Y, $side)
$dial = $work.Clone($cropRect, $work.PixelFormat)

$ccx = $side / 2.0
$ccy = $side / 2.0
for ($y = 0; $y -lt $side; $y++) {
  for ($x = 0; $x -lt $side; $x++) {
    $nx = ($x + 0.5 - $ccx) / $DialRx
    $ny = ($y + 0.5 - $ccy) / $DialRy
    $d = [math]::Sqrt($nx * $nx + $ny * $ny)
    if ($d -gt 1.0) {
      $dial.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(0, 0, 0, 0))
    } elseif ($d -gt 0.985) {
      $p = $dial.GetPixel($x, $y)
      $k = (1.0 - $d) / 0.015
      $dial.SetPixel($x, $y, [System.Drawing.Color]::FromArgb([int]($p.A * $k), $p.R, $p.G, $p.B))
    }
  }
}
Save-Png $dial (Join-Path $OutDir 'logo-dial.png')

# --- connected components, then drop whatever crosses the ring ---------------
$label = New-Object 'int[,]' $side, $side
$stack = New-Object System.Collections.Generic.Stack[object]
$comps = @()
$next = 0
for ($sy = 0; $sy -lt $side; $sy++) {
  for ($sx = 0; $sx -lt $side; $sx++) {
    if ($label[$sy, $sx] -ne 0) { continue }
    if ($dial.GetPixel($sx, $sy).A -lt 100) { $label[$sy, $sx] = -1; continue }
    $next++
    $label[$sy, $sx] = $next
    $stack.Push(@($sx, $sy))
    $count = 0; $minX = $side; $maxX = -1; $minY = $side; $maxY = -1
    while ($stack.Count -gt 0) {
      $p = $stack.Pop()
      $px = $p[0]; $py = $p[1]
      $count++
      if ($px -lt $minX) { $minX = $px }
      if ($px -gt $maxX) { $maxX = $px }
      if ($py -lt $minY) { $minY = $py }
      if ($py -gt $maxY) { $maxY = $py }
      foreach ($d in @(@(1, 0), @(-1, 0), @(0, 1), @(-0, -1))) {
        $nx = $px + $d[0]; $ny = $py + $d[1]
        if ($nx -lt 0 -or $ny -lt 0 -or $nx -ge $side -or $ny -ge $side) { continue }
        if ($label[$ny, $nx] -ne 0) { continue }
        if ($dial.GetPixel($nx, $ny).A -lt 100) { $label[$ny, $nx] = -1; continue }
        $label[$ny, $nx] = $next
        $stack.Push(@($nx, $ny))
      }
    }
    $comps += [pscustomobject]@{ id = $next; px = $count; x1 = $minX; x2 = $maxX; y1 = $minY; y2 = $maxY }
  }
}
Write-Output ("components: {0}" -f $comps.Count)

# The ring holds the rightmost opaque pixel: that side is clean and the flame
# never reaches it.
$ringId = 0
for ($x = $side - 1; $x -ge 0 -and $ringId -eq 0; $x--) {
  for ($y = 0; $y -lt $side; $y++) {
    if ($dial.GetPixel($x, $y).A -ge 100) { $ringId = $label[$y, $x]; break }
  }
}
$ring = $comps | Where-Object { $_.id -eq $ringId }
Write-Output ("  ring  id {0}: {1} px, bbox {2},{3}..{4},{5}" -f $ring.id, $ring.px, $ring.x1, $ring.y1, $ring.x2, $ring.y2)

# Keep anything wholly inside the ring's interior; drop anything crossing it.
#
# The interior ellipse has to clear the tick marks, which sit just inside the
# ring's inner edge. Measured: the topmost tick reaches 132px from centre against
# a 176px outer radius, so anything below about 0.80 rejects real artwork. At
# 0.85 the topmost tick lands at 0.89 and the flame's nearest corner still
# measures 1.50, so the two are comfortably separated.
$INTERIOR = 0.85
$innerRx = $DialRx * $INTERIOR
$innerRy = $DialRy * $INTERIOR
$dropped = 0
$kept = 0
foreach ($c in $comps) {
  if ($c.id -eq $ringId) { continue }
  $outside = $false
  for ($py = $c.y1; $py -le $c.y2 -and -not $outside; $py++) {
    for ($px = $c.x1; $px -le $c.x2; $px++) {
      if ($label[$py, $px] -ne $c.id) { continue }
      $nx = ($px + 0.5 - $ccx) / $innerRx
      $ny = ($py + 0.5 - $ccy) / $innerRy
      if ([math]::Sqrt($nx * $nx + $ny * $ny) -gt 1.0) { $outside = $true; break }
    }
  }
  if ($outside) {
    Write-Output ("  drop  id {0}: {1} px, bbox {2},{3}..{4},{5} - crosses the ring" -f $c.id, $c.px, $c.x1, $c.y1, $c.x2, $c.y2)
    for ($py = $c.y1; $py -le $c.y2; $py++) {
      for ($px = $c.x1; $px -le $c.x2; $px++) {
        if ($label[$py, $px] -eq $c.id) { $dial.SetPixel($px, $py, [System.Drawing.Color]::FromArgb(0, 0, 0, 0)); $dropped++ }
      }
    }
  } else { $kept++ }
}
Write-Output ("  kept {0} interior components, dropped {1} px of flame" -f $kept, $dropped)
Save-Png $dial (Join-Path $OutDir 'logo-mark.png')

$work.Dispose()
Write-Output 'extract complete'
