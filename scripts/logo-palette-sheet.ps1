# Renders the proposed palette in context, for approval before it is applied.
#
# A table of oklch numbers cannot answer the question that matters here: whether a
# red record button still reads as "recording" when the accent next to it is
# orange. So this renders the actual semantic swatches on the app's real canvas
# colour, current set beside proposed.
param([string]$Out = 'assets\icon\_palette-sheet.png')

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function Oklch-To-Rgb([double]$L, [double]$C, [double]$H) {
  $hRad = $H * [math]::PI / 180
  $a = $C * [math]::Cos($hRad)
  $b = $C * [math]::Sin($hRad)
  $l_ = $L + 0.3963377774*$a + 0.2158037573*$b
  $m_ = $L - 0.1055613458*$a - 0.0638541728*$b
  $s_ = $L - 0.0894841775*$a - 1.2914855480*$b
  $l = $l_*$l_*$l_; $m = $m_*$m_*$m_; $s = $s_*$s_*$s_
  $lr =  4.0767416621*$l - 3.3077115913*$m + 0.2309699292*$s
  $lg = -1.2684380046*$l + 2.6097574011*$m - 0.3413193965*$s
  $lb = -0.0041960863*$l - 0.7034186147*$m + 1.7076147010*$s
  $toSrgb = {
    param($v)
    $v = [math]::Max(0.0, [math]::Min(1.0, $v))
    if ($v -le 0.0031308) { return [int][math]::Round($v * 12.92 * 255) }
    return [int][math]::Round((1.055 * [math]::Pow($v, 1/2.4) - 0.055) * 255)
  }
  return @{ R = (& $toSrgb $lr); G = (& $toSrgb $lg); B = (& $toSrgb $lb) }
}

function Hex([double]$L, [double]$C, [double]$H) {
  # Note the result variable must not be called $c: PowerShell variable names are
  # case-insensitive, so $c here is the [double]$C parameter and assigning to it
  # fails to convert the returned hashtable.
  $rgb = Oklch-To-Rgb $L $C $H
  return [System.Drawing.Color]::FromArgb(255, $rgb.R, $rgb.G, $rgb.B)
}

# The app's own canvas and ink, so this is judged against the real background.
$CANVAS = [System.Drawing.Color]::FromArgb(255, 0x16, 0x15, 0x1a)
$SURFACE = [System.Drawing.Color]::FromArgb(255, 0x22, 0x21, 0x27)
$LINE = [System.Drawing.Color]::FromArgb(255, 0x3a, 0x39, 0x42)
$INK = [System.Drawing.Color]::FromArgb(255, 0xf5, 0xf5, 0xf7)
$INK_MUTED = [System.Drawing.Color]::FromArgb(255, 0x9a, 0x98, 0xa3)

$current = @(
  @{ n = 'accent';  L = 0.780; C = 0.135; H = 195 }
  @{ n = 'danger';  L = 0.660; C = 0.170; H = 22 }
  @{ n = 'warn';    L = 0.800; C = 0.140; H = 80 }
)
$proposed = @(
  @{ n = 'accent';       L = 0.780; C = 0.160; H = 55;  note = 'flame deep orange' }
  @{ n = 'accent-dim';   L = 0.630; C = 0.140; H = 55;  note = '' }
  @{ n = 'danger';       L = 0.620; C = 0.200; H = 22;  note = 'deepened to separate' }
  @{ n = 'warn';         L = 0.840; C = 0.150; H = 95;  note = 'amber -> yellow' }
)

$W = 1060; $H = 620
$sheet = New-Object System.Drawing.Bitmap $W, $H, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($sheet)
$g.Clear($CANVAS)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
$fontTitle = New-Object System.Drawing.Font 'Segoe UI', 13, ([System.Drawing.FontStyle]::Bold)
$fontBody = New-Object System.Drawing.Font 'Segoe UI', 9
$fontMono = New-Object System.Drawing.Font 'Consolas', 8
$bTitle = New-Object System.Drawing.SolidBrush $INK
$bMuted = New-Object System.Drawing.SolidBrush $INK_MUTED

$g.DrawString('Rewind - proposed palette, drawn on the app canvas', $fontTitle, $bTitle, 28, 24)

function Draw-Row($x, $y, $label, $swatches, $width) {
  $g.DrawString($label, $fontBody, $bMuted, $x, ($y - 18))
  $cx = $x
  foreach ($s in $swatches) {
    $col = Hex $s.L $s.C $s.H
    $br = New-Object System.Drawing.SolidBrush $col
    $g.FillEllipse($br, $cx, $y, 46, 46)
    $pen = New-Object System.Drawing.Pen $LINE, 1
    $g.DrawEllipse($pen, $cx, $y, 46, 46)
    $g.DrawString($s.n, $fontBody, $bTitle, $cx - 4, ($y + 52))
    $g.DrawString(('oklch({0:N2} {1:N3} {2:N0})' -f $s.L, $s.C, $s.H), $fontMono, $bMuted, $cx - 6, ($y + 66))
    $br.Dispose(); $pen.Dispose()
    $cx += $width
  }
}

Draw-Row 28 74 'current' $current 190
Draw-Row 28 214 'proposed' $proposed 150

# --- the question that matters: does red still read as "recording"? -----------
$g.DrawString('in context - record button, active control, and a warning', $fontBody, $bMuted, 700, 74)

function Draw-Record($x, $y, $fill, $caption) {
  $br = New-Object System.Drawing.SolidBrush $fill
  $g.FillEllipse($br, $x, $y, 56, 56)
  # The glyph inside is what carries "record" independently of hue.
  $inner = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(30, 0, 0, 0))
  $r = 11
  $g.FillEllipse($inner, ($x + 28 - $r), ($y + 28 - $r), ($r*2), ($r*2))
  $g.DrawString($caption, $fontBody, $bMuted, $x - 4, ($y + 62))
  $br.Dispose(); $inner.Dispose()
}

$recCur = Hex 0.660 0.170 22
$recNew = Hex 0.620 0.200 22
$accCur = Hex 0.780 0.135 195
$accNew = Hex 0.780 0.160 55
$warnCur = Hex 0.800 0.140 80
$warnNew = Hex 0.840 0.150 95

$g.DrawString('current', $fontMono, $bMuted, 700, 108)
Draw-Record 700 128 $recCur 'record'
Draw-Record 790 128 $accCur 'accent'

$g.DrawString('proposed', $fontMono, $bMuted, 700, 226)
Draw-Record 700 246 $recNew 'record'
Draw-Record 790 246 $accNew 'accent'

# A pill and a warning chip, which is where accent and warn sit next to each other.
function Draw-Pill($x, $y, $fill, $text) {
  $br = New-Object System.Drawing.SolidBrush $fill
  $g.FillRectangle($br, $x, $y, 78, 24)
  $tb = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 0x14, 0x13, 0x18))
  $g.DrawString($text, $fontBody, $tb, ($x + 8), ($y + 5))
  $br.Dispose(); $tb.Dispose()
}
Draw-Pill 700 330 $accCur 'accent'
Draw-Pill 700 372 $warnCur 'warn'
Draw-Pill 790 330 $accNew 'accent'
Draw-Pill 790 372 $warnNew 'warn'

# Hue separation is the objective measure behind the choice.
$g.DrawString('hue separation', $fontBody, $bMuted, 28, 420)
$rows = @(
  @{ n = 'current  accent 195 vs danger 22';  d = 173 },
  @{ n = 'current  accent 195 vs warn 80';    d = 115 },
  @{ n = 'proposed accent 55 vs danger 22';   d = 33 },
  @{ n = 'proposed accent 55 vs warn 95';     d = 40 }
)
$y = 444
foreach ($r in $rows) {
  $g.DrawString($r.n, $fontMono, $bMuted, 28, $y)
  $barW = [int]([math]::Min(360, $r.d * 2))
  $col = if ($r.d -lt 40) { [System.Drawing.Color]::FromArgb(255, 0xe0, 0x6c, 0x5a) } else { Hex 0.78 0.16 55 }
  $br = New-Object System.Drawing.SolidBrush $col
  $g.FillRectangle($br, 400, $y, 40, 12)
  if ($r.d -lt 360) { $g.FillRectangle($br, 440, $y, $barW, 12) }
  $g.DrawString("$($r.d) deg", $fontMono, $bMuted, 420, $y + 16)
  $br.Dispose()
  $y += 40
}

$g.Dispose()
$sheet.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$sheet.Dispose()
Write-Output "wrote $Out"
