# Emits every icon size the app needs from the extracted dial.
#
# Two marks, because one mark cannot serve both. The full dial carries twelve tick
# marks around its inner edge; at 32px and below they are roughly one pixel each,
# which does not read as ticks -- it reads as noise, and it muddies the ring the
# play triangle has to stand out against. So the small sizes get a reduced mark
# with the ticks dropped and the play triangle kept.
#
# Sizes are chosen to be the ones Windows actually asks for rather than a
# convenient range: 16/20/24 for the tray at 100/125/150% DPI, 48 for the taskbar
# and title bar, and 256 for the shell icon and installer.
param(
  [string]$MarkPath = 'assets\logo-mark.png',
  [string]$OutDir = 'assets\icon',
  # Fraction of the canvas the mark occupies. Windows expects a little breathing
  # room; a mark that bleeds to the edge looks cramped next to other pinned apps.
  [double]$Fill = 0.90,
  # Lightness floor for the small mark, see below. 0 disables it.
  [double]$MinLightness = 0.42,
  # How far to thicken the small mark, in source pixels. See below.
  [int]$Dilation = 12
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }

$img = [System.Drawing.Image]::FromFile((Resolve-Path $MarkPath).Path)
$mark = New-Object System.Drawing.Bitmap($img); $img.Dispose()

function Alpha($x, $y) { $mark.GetPixel($x, $y).A }

# --- build the reduced mark: keep only the ring and the play triangle ---------
# The play triangle is the largest component inside the ring by a wide margin
# (about 4500px against roughly 250-480 for a tick), so "largest interior
# component" identifies it without hard-coding a size threshold.
function Get-Components([System.Drawing.Bitmap]$bmp) {
  $w = $bmp.Width; $h = $bmp.Height
  $label = New-Object 'int[,]' $w, $h
  $stack = New-Object System.Collections.Generic.Stack[object]
  $comps = @(); $next = 0
  for ($sy = 0; $sy -lt $h; $sy++) {
    for ($sx = 0; $sx -lt $w; $sx++) {
      if ($label[$sy, $sx] -ne 0) { continue }
      if ($bmp.GetPixel($sx, $sy).A -lt 100) { $label[$sy, $sx] = -1; continue }
      $next++; $label[$sy, $sx] = $next
      $stack.Push(@($sx, $sy)); $count = 0
      while ($stack.Count -gt 0) {
        $p = $stack.Pop(); $count++
        foreach ($d in @(@(1,0),@(-1,0),@(0,1),@(0,-1))) {
          $nx = $p[0] + $d[0]; $ny = $p[1] + $d[1]
          if ($nx -lt 0 -or $ny -lt 0 -or $nx -ge $w -or $ny -ge $h) { continue }
          if ($label[$ny, $nx] -ne 0) { continue }
          if ($bmp.GetPixel($nx, $ny).A -lt 100) { $label[$ny, $nx] = -1; continue }
          $label[$ny, $nx] = $next
          $stack.Push(@($nx, $ny))
        }
      }
      $comps += [pscustomobject]@{ id = $next; px = $count }
    }
  }
  return @($label, $comps)
}

Write-Output 'building reduced mark (ring + play, ticks removed)'
$parts = Get-Components $mark
$label = $parts[0]
$comps = $parts[1]
$ring = $comps | Sort-Object px -Descending | Select-Object -First 1
$inner = $comps | Where-Object { $_.id -ne $ring.id } | Sort-Object px -Descending | Select-Object -First 1
Write-Output ("  ring {0} px, largest interior {1} px (id {2}) - the play triangle" -f $ring.px, $inner.px, $inner.id)

$reduced = New-Object System.Drawing.Bitmap($mark.Width, $mark.Height, $mark.PixelFormat)
for ($y = 0; $y -lt $mark.Height; $y++) {
  for ($x = 0; $x -lt $mark.Width; $x++) {
    $id = $label[$y, $x]
    if ($id -eq $ring.id -or $id -eq $inner.id) { $reduced.SetPixel($x, $y, $mark.GetPixel($x, $y)) }
  }
}

# --- lift the dark end for small sizes ---------------------------------------
# Measured on the contact sheet: at 16px and 20px the ring's top-left arc -- the
# dark purple end of the gradient -- has almost no contrast against the app's
# canvas, so the ring reads as a broken "C" and the play triangle as a blob. It
# is fine from 32px up, where the gradient survives.
#
# The fix is in the artwork rather than in the background: at 16px there are no
# pixels spare for subtle shading, so the gradient's dark end is lifted to a
# lightness that clears the canvas. Hue is preserved by working in HSL, and only
# the small mark is touched, so the large icon keeps the artwork as drawn.
# --- thicken, then lift, for small sizes --------------------------------------
# Measured at 16px: only 44 pixels survive the downscale with enough alpha to
# draw at all, so whole segments of the ring disappear and it reads as a broken
# "C". The colour is not the problem -- every surviving pixel clears the canvas
# comfortably -- it is coverage. The ring is about 25px wide in a 360px source,
# which lands on almost exactly one pixel after scaling to 14px, so every ring
# pixel is a partial-coverage blend with the background and most fall below the
# alpha threshold.
#
# The fix is to make the stroke bolder for small sizes only. The large mark keeps
# the artwork as drawn, because at 48px and up the ring has nothing to prove.
function Dilate([System.Drawing.Bitmap]$bmp, [int]$passes) {
  $w = $bmp.Width; $h = $bmp.Height
  for ($p = 0; $p -lt $passes; $p++) {
    $next = New-Object 'int[,]' $w, $h
    # Which neighbour supplied the winning alpha. Needed because the colour has
    # to travel with it: raising a transparent pixel's alpha while leaving its own
    # RGB alone turns it opaque black, which shows up as a dark halo around the
    # ring rather than as a thicker ring.
    $pick = New-Object 'int[,]' $w, $h
    for ($y = 0; $y -lt $h; $y++) {
      for ($x = 0; $x -lt $w; $x++) {
        $best = -1; $bx = $x; $by = $y
        for ($dy = -1; $dy -le 1; $dy++) {
          for ($dx = -1; $dx -le 1; $dx++) {
            $nx = $x + $dx; $ny = $y + $dy
            if ($nx -lt 0 -or $ny -lt 0 -or $nx -ge $w -or $ny -ge $h) { continue }
            $a = $bmp.GetPixel($nx, $ny).A
            if ($a -gt $best) { $best = $a; $bx = $nx; $by = $ny }
          }
        }
        $next[$y, $x] = $best
        $pick[$y, $x] = ($by * $w) + $bx
      }
    }
    for ($y = 0; $y -lt $h; $y++) {
      for ($x = 0; $x -lt $w; $x++) {
        $na = $next[$y, $x]
        if ($na -lt 1) { continue }
        $c = $bmp.GetPixel($x, $y)
        if ($na -eq $c.A) { continue }
        $idx = $pick[$y, $x]
        $src = $bmp.GetPixel(($idx % $w), [int][math]::Floor($idx / $w))
        # Fade the borrowed colour toward it across the feathered band, so the
        # new edge is not a hard step.
        $t = if ($c.A -gt 0) { $c.A / [double]$na } else { 0 }
        $bmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb($na,
          [int][math]::Round($c.R + ($src.R - $c.R) * $t),
          [int][math]::Round($c.G + ($src.G - $c.G) * $t),
          [int][math]::Round($c.B + ($src.B - $c.B) * $t)))
      }
    }
  }
}

if ($Dilation -gt 0) {
  Dilate $reduced $Dilation
  Write-Output ("  thickened the small mark by {0}px" -f $Dilation)
}

function Lift-Lightness([System.Drawing.Bitmap]$bmp, [double]$floor) {
  $changed = 0
  for ($y = 0; $y -lt $bmp.Height; $y++) {
    for ($x = 0; $x -lt $bmp.Width; $x++) {
      $c = $bmp.GetPixel($x, $y)
      if ($c.A -lt 8) { continue }
      $r = $c.R / 255.0; $g = $c.G / 255.0; $b = $c.B / 255.0
      $mx = [math]::Max($r, [math]::Max($g, $b))
      $mn = [math]::Min($r, [math]::Min($g, $b))
      $l = ($mx + $mn) / 2.0
      if ($l -ge $floor) { continue }
      $d = $mx - $mn
      if ($d -lt 0.0001) { continue }
      # Recover hue and saturation from the untouched channels, then re-emit at
      # the floor lightness. Working per-channel would shift hue toward grey.
      $s = $(if ($l -gt 0.5) { $d / (2.0 - $mx - $mn) } else { $d / ($mx + $mn) })
      $h = 0.0
      if ($d -gt 0.0001) {
        if ($mx -eq $r) { $h = ($g - $b) / $d + $(if ($g -lt $b) { 6 } else { 0 }) }
        elseif ($mx -eq $g) { $h = ($b - $r) / $d + 2 }
        else { $h = ($r - $g) / $d + 4 }
        $h /= 6.0
      }
      $q = $(if ($l -lt 0.5) { $l * (1 + $s) } else { $l + $s - $l * $s })
      $p = 2.0 * $l - $q
      $hue2rgb = {
        param($t)
        if ($t -lt 0) { $t += 1 }
        if ($t -gt 1) { $t -= 1 }
        if ($t -lt 1.0/6) { return $p + ($q - $p) * 6 * $t }
        if ($t -lt 0.5) { return $q }
        if ($t -lt 2.0/3) { return $p + ($q - $p) * (2.0/3 - $t) * 6 }
        return $p
      }
      $nr = & $hue2rgb ($h + 1.0/3)
      $ng = & $hue2rgb $h
      $nb = & $hue2rgb ($h - 1.0/3)
      $bmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb($c.A,
        [int][math]::Round($nr * 255), [int][math]::Round($ng * 255), [int][math]::Round($nb * 255)))
      $changed++
    }
  }
  return $changed
}

if ($MinLightness -gt 0) {
  $lifted = Lift-Lightness $reduced $MinLightness
  Write-Output ("  lifted {0} px below lightness {1}" -f $lifted, $MinLightness)
}
$reduced.Save((Join-Path $OutDir 'mark-reduced.png'), [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output ("  wrote mark-reduced.png ({0}x{1})" -f $reduced.Width, $reduced.Height)

# --- render each size ---------------------------------------------------------
function Render-Square([System.Drawing.Bitmap]$src, [int]$size) {
  $out = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($out)
  $g.Clear([System.Drawing.Color]::FromArgb(0, 0, 0, 0))
  $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  # Fit the source inside the canvas, preserving aspect, then centre it. The
  # source is already square so this is uniform scaling, but going through the
  # min keeps it correct if the crop ever changes shape.
  $m = [math]::Min($size * $Fill, [math]::Min($src.Width, $src.Height))
  $mi = [int][math]::Round($m)
  $dx = [int][math]::Round(($size - $mi) / 2)
  $dy = [int][math]::Round(($size - $mi) / 2)
  $g.DrawImage($src, (New-Object System.Drawing.Rectangle($dx, $dy, $mi, $mi)))
  $g.Dispose()
  return $out
}

# Ticks survive to 32px and go below that. See the header for why.
$plan = @(
  @{ size = 16;  mark = 'reduced' },
  @{ size = 20;  mark = 'reduced' },
  @{ size = 24;  mark = 'reduced' },
  @{ size = 32;  mark = 'reduced' },
  @{ size = 48;  mark = 'full' },
  @{ size = 64;  mark = 'full' },
  @{ size = 128; mark = 'full' },
  @{ size = 256; mark = 'full' }
)

Write-Output ''
Write-Output 'rendering sizes'
foreach ($p in $plan) {
  $src = if ($p.mark -eq 'full') { $mark } else { $reduced }
  $bmp = Render-Square $src $p.size
  $name = 'icon-{0}.png' -f $p.size
  $bmp.Save((Join-Path $OutDir $name), [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Output ("  {0,-14} {1,4}px  from {2}" -f $name, $p.size, $p.mark)
  $bmp.Dispose()
}

$mark.Dispose(); $reduced.Dispose()
Write-Output ''
Write-Output 'sizes complete'
