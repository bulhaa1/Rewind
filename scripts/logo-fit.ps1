# Fits the dial's outer ellipse by tracing the outer envelope along rays.
#
# The previous attempt searched for the first opaque band thicker than a few
# pixels, which latches onto tick marks and the play triangle instead of the ring
# and produced radii from 10 to 182. The ring is the outermost feature, so the
# useful signal is simply the furthest opaque pixel on each ray.
#
# The flame overlaps the ring's top-left, so a plain least-squares fit would be
# dragged by it. The fit is therefore robust: fit, discard anything more than a
# few percent off, refit. The centre is searched rather than assumed, because the
# first crop's centre was a guess and a wrong centre makes the ellipse fit bad.
param([string]$Dial = 'assets\logo-dial.png')

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$i = [System.Drawing.Image]::FromFile((Resolve-Path $Dial).Path)
$bmp = New-Object System.Drawing.Bitmap($i); $i.Dispose()
$W = $bmp.Width; $H = $bmp.Height
$maxR = [math]::Min($W, $H) / 2.0

function Opaque($x, $y) {
  # Floor before comparing. PowerShell's cast rounds to nearest, so a ray
  # coordinate of 391.6 passes a "less than Width" test on the float and then
  # indexes 392, which is one past the end.
  $xi = [int][math]::Floor($x)
  $yi = [int][math]::Floor($y)
  if ($xi -lt 0 -or $yi -lt 0 -or $xi -ge $W -or $yi -ge $H) { return $false }
  return ($bmp.GetPixel($xi, $yi).A -gt 100)
}

# Furthest opaque pixel along a ray. The whole ray is scanned rather than
# stopping at the first gap: from the centre the ray crosses the play triangle,
# then the ring's interior, which is a wide transparent gap. Stopping there would
# measure the triangle instead of the ring. Outliers are handled by the robust
# fit downstream, not by truncating here.
function Envelope($cx, $cy, $a) {
  $dx = [math]::Cos($a); $dy = [math]::Sin($a)
  $rMax = 0
  for ($r = 2; $r -lt $maxR; $r += 0.5) {
    if (Opaque ($cx + $dx * $r) ($cy + $dy * $r)) { $rMax = $r }
  }
  return $rMax
}

function FitEllipse($angles, $radii, $tolerance) {
  $pts = @()
  for ($k = 0; $k -lt $angles.Count; $k++) {
    if ($radii[$k] -gt 4) { $pts += [pscustomobject]@{ a = $angles[$k]; r = $radii[$k] } }
  }
  $A = 0; $B = 0
  for ($pass = 0; $pass -lt 6; $pass++) {
    $numA = 0.0; $denA = 0.0; $numB = 0.0; $denB = 0.0; $used = 0
    foreach ($p in $pts) {
      $c = [math]::Cos($p.a); $s = [math]::Sin($p.a)
      $pred = $(if ($pass -eq 0) { $p.r } else { [math]::Sqrt(($A*$c)*($A*$c) + ($B*$s)*($B*$s)) })
      if ($pass -eq 0 -or [math]::Abs($p.r - $pred) -le $tolerance * $pred) {
        $numA += $p.r * $c * $c; $denA += $c * $c
        $numB += $p.r * $s * $s; $denB += $s * $s
        $used++
      }
    }
    if ($denA -gt 0) { $A = $numA / $denA }
    if ($denB -gt 0) { $B = $numB / $denB }
    if ($used -lt 12) { break }
  }
  # Residual after the robust fit: how well an ellipse actually explains this.
  $res = @()
  foreach ($p in $pts) {
    $c = [math]::Cos($p.a); $s = [math]::Sin($p.a)
    $pred = [math]::Sqrt(($A*$c)*($A*$c) + ($B*$s)*($B*$s))
    $res += [math]::Abs($p.r - $pred)
  }
  $sorted = $res | Sort-Object
  return [pscustomobject]@{ A = $A; B = $B; Median = $sorted[[int]($sorted.Count / 2)] }
}

$angles = @(0..71 | ForEach-Object { $_ * 5 * [math]::PI / 180 })

Write-Output "searching centre (image $W x $H)..."
$best = $null
for ($oy = -34; $oy -le 34; $oy += 4) {
  for ($ox = -34; $ox -le 34; $ox += 4) {
    $cx = $W / 2.0 + $ox; $cy = $H / 2.0 + $oy
    $r = @(); foreach ($a in $angles) { $r += (Envelope $cx $cy $a) }
    $f = FitEllipse $angles $r 0.06
    if ($f.A -gt 20 -and $f.B -gt 20 -and ($null -eq $best -or $f.Median -lt $best.fit.Median)) {
      $best = [pscustomobject]@{ cx = $cx; cy = $cy; fit = $f }
    }
  }
}

Write-Output ''
Write-Output '=== fitted dial ==='
Write-Output ("  centre      : {0}, {1}" -f [math]::Round($best.cx,1), [math]::Round($best.cy,1))
Write-Output ("  rx          : {0}" -f [math]::Round($best.fit.A,1))
Write-Output ("  ry          : {0}" -f [math]::Round($best.fit.B,1))
Write-Output ("  rx/ry       : {0}" -f [math]::Round($best.fit.A / $best.fit.B,3))
Write-Output ("  median resid: {0} px" -f [math]::Round($best.fit.Median,2))

Write-Output ''
Write-Output '=== per-angle envelope and where the flame departs from the ellipse ==='
$r = @(); foreach ($a in $angles) { $r += (Envelope $best.cx $best.cy $a) }
foreach ($k in 0..($angles.Count - 1)) {
  $deg = $angles[$k] * 180 / [math]::PI
  $c = [math]::Cos($angles[$k]); $s = [math]::Sin($angles[$k])
  $pred = [math]::Sqrt(($best.fit.A*$c)*($best.fit.A*$c) + ($best.fit.B*$s)*($best.fit.B*$s))
  $d = $r[$k] - $pred
  $flag = if ($d -gt 8) { '  <-- flame' } elseif ($d -lt -8) { '  <-- short' } else { '' }
  if ($flag -or ($k % 3 -eq 0)) {
    '  {0,4} deg  r={1,7}  ellipse={2,7}  diff={3,7}{4}' -f [math]::Round($deg), [math]::Round($r[$k],1), [math]::Round($pred,1), [math]::Round($d,1), $flag
  }
}
$bmp.Dispose()
