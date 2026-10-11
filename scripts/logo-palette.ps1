# Samples the artwork's palette and reports it in oklch.
#
# The UI accent is warm -- bright orange through red, per the logo's flame. Picking
# those values by eye produces accents that are close to -- and sometimes
# indistinguishable from -- the existing danger red and warn amber, so the
# artwork is sampled instead and the candidates are reported with the distances
# between them.
#
# oklch rather than hex because that is what the design tokens are written in, and
# comparing hue in oklch is meaningful in a way that comparing hex is not.
param(
  [string]$Source = (Join-Path ([Environment]::GetFolderPath('UserProfile')) 'Downloads\Logo for rewind.png')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function To-Linear([double]$c) {
  if ($c -le 0.04045) { return $c / 12.92 }
  return [math]::Pow(($c + 0.055) / 1.055, 2.4)
}

function To-Oklch([int]$r, [int]$g, [int]$b) {
  $linR = To-Linear ($r / 255.0)
  $linG = To-Linear ($g / 255.0)
  $linB = To-Linear ($b / 255.0)
  $lmsL = 0.4122214708*$linR + 0.5363325363*$linG + 0.0514459929*$linB
  $lmsM = 0.2119034982*$linR + 0.6806995451*$linG + 0.1073969566*$linB
  $lmsS = 0.0883024619*$linR + 0.2817188376*$linG + 0.6299787005*$linB
  $rootL = [math]::Pow($lmsL, 1.0/3.0)
  $rootM = [math]::Pow($lmsM, 1.0/3.0)
  $rootS = [math]::Pow($lmsS, 1.0/3.0)
  $okL = 0.2104542553*$rootL + 0.7936177850*$rootM - 0.0040720468*$rootS
  $okA = 1.9779984951*$rootL - 2.4285922050*$rootM + 0.4505937099*$rootS
  $okB = 0.0259040371*$rootL + 0.7827717662*$rootM - 0.8086757660*$rootS
  $okC = [math]::Sqrt($okA*$okA + $okB*$okB)
  $okH = [math]::Atan2($okB, $okA) * 180 / [math]::PI
  if ($okH -lt 0) { $okH += 360 }
  return @{ L = $okL; C = $okC; H = $okH }
}

# Guard against the conversion silently going wrong again. It previously reported
# an orange as hue 0 with a chroma equal to its a-axis, which looked plausible
# enough in a table to be trusted. These three references are hand-checked.
$selftest = @(
  @{ hex = '#FAC16F'; L = 0.846; C = 0.119; H = 75 },   # orange
  @{ hex = '#FFFFFF'; L = 1.000; C = 0.000; H = 0 },    # white
  @{ hex = '#000000'; L = 0.000; C = 0.000; H = 0 }     # black
)
foreach ($t in $selftest) {
  $rr = [Convert]::ToInt32($t.hex.Substring(1,2), 16)
  $gg = [Convert]::ToInt32($t.hex.Substring(3,2), 16)
  $bb = [Convert]::ToInt32($t.hex.Substring(5,2), 16)
  $o = To-Oklch $rr $gg $bb
  $bad = ''
  if ([math]::Abs($o.L - $t.L) -gt 0.01) { $bad += " L expected $($t.L)" }
  if ([math]::Abs($o.C - $t.C) -gt 0.01) { $bad += " C expected $($t.C)" }
  if ($t.C -gt 0.01 -and [math]::Abs($o.H - $t.H) -gt 2) { $bad += " H expected $($t.H)" }
  if ($bad) { throw "oklch conversion self-test failed for $($t.hex):$bad (got L=$($o.L) C=$($o.C) H=$($o.H))" }
}
Write-Output 'oklch self-test passed (orange, white, black)'
Write-Output ''

$img = [System.Drawing.Image]::FromFile($Source)
$bmp = New-Object System.Drawing.Bitmap($img); $img.Dispose()

# Regions are named for where they sit in the artwork. Averaging a patch rather
# than reading one pixel avoids landing on an antialiased edge.
$regions = @(
  @{ name = 'flame - bright orange';   x = 400; y = 250; r = 14 },
  @{ name = 'flame - deep orange';     x = 350; y = 300; r = 12 },
  @{ name = 'flame - red/crimson';     x = 470; y = 285; r = 10 },
  @{ name = 'flame - magenta';         x = 530; y = 305; r = 12 },
  @{ name = 'flame - lower, orange';   x = 590; y = 470; r = 12 },
  @{ name = 'ring - pink/violet';      x = 880; y = 180; r = 12 },
  @{ name = 'ring - blue';             x = 1065; y = 330; r = 12 },
  @{ name = 'ring - cyan';             x = 1035; y = 200; r = 12 },
  @{ name = 'play - centre';           x = 930; y = 330; r = 10 }
)

Write-Output '=== sampled from the artwork ==='
Write-Output ('{0,-24} {1,-9} {2,-30}' -f 'region', 'hex', 'oklch')
$swatches = @()
foreach ($g in $regions) {
  $sr = 0; $sg = 0; $sb = 0; $n = 0
  for ($y = $g.y - $g.r; $y -le $g.y + $g.r; $y++) {
    for ($x = $g.x - $g.r; $x -le $g.x + $g.r; $x++) {
      if ($x -lt 0 -or $y -lt 0 -or $x -ge $bmp.Width -or $y -ge $bmp.Height) { continue }
      $c = $bmp.GetPixel($x, $y)
      $mx = [math]::Max($c.R, [math]::Max($c.G, $c.B))
      $mn = [math]::Min($c.R, [math]::Min($c.G, $c.B))
      if (($mx - $mn) -lt 40) { continue }  # skip the grey checkerboard
      $sr += $c.R; $sg += $c.G; $sb += $c.B; $n++
    }
  }
  if ($n -eq 0) { Write-Output ('{0,-24} {1}' -f $g.name, '(no saturated pixels)'); continue }
  $r = [int][math]::Round($sr / $n); $gg = [int][math]::Round($sg / $n); $b = [int][math]::Round($sb / $n)
  $o = To-Oklch $r $gg $b
  $hex = '#{0:X2}{1:X2}{2:X2}' -f $r, $gg, $b
  Write-Output ('{0,-24} {1,-9} oklch({2:N3} {3:N3} {4:N1})' -f $g.name, $hex, $o.L, $o.C, $o.H)
  $swatches += [pscustomobject]@{ name = $g.name; hex = $hex; L = $o.L; C = $o.C; H = $o.H }
}

Write-Output ''
Write-Output '=== current UI tokens ==='
$tokens = @(
  @{ name = 'accent (cyan)';     L = 0.780; C = 0.135; H = 195 },
  @{ name = 'accent-dim';        L = 0.620; C = 0.105; H = 195 },
  @{ name = 'danger (red)';      L = 0.660; C = 0.170; H = 22 },
  @{ name = 'warn (amber)';      L = 0.800; C = 0.140; H = 80 }
)
foreach ($t in $tokens) {
  Write-Output ('  {0,-18} oklch({1:N3} {2:N3} {3:N1})' -f $t.name, $t.L, $t.C, $t.H)
}

Write-Output ''
Write-Output '=== candidate warm accents vs the tokens they must not collide with ==='
$cands = @(
  @{ name = 'flame bright orange'; L = 0.780; C = 0.170; H = 55 },
  @{ name = 'flame deep orange';   L = 0.720; C = 0.180; H = 42 },
  @{ name = 'flame red/crimson';   L = 0.650; C = 0.190; H = 25 },
  @{ name = 'flame magenta';       L = 0.680; C = 0.200; H = 350 }
)
foreach ($c in $cands) {
  $dDanger = [math]::Abs($c.H - 22); if ($dDanger -gt 180) { $dDanger = 360 - $dDanger }
  $dWarn = [math]::Abs($c.H - 80);  if ($dWarn -gt 180)   { $dWarn = 360 - $dWarn }
  $verdict = if ($dDanger -lt 20 -or $dWarn -lt 20) { 'TOO CLOSE' } else { 'ok' }
  Write-Output ('  {0,-20} oklch({1:N2} {2:N3} {3,3:N0})   vs danger {4,3:N0} deg, vs warn {5,3:N0} deg   {6}' -f `
    $c.name, $c.L, $c.C, $c.H, $dDanger, $dWarn, $verdict)
}
$bmp.Dispose()
