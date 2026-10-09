# Make the DSH plugin-page icon from the desktop tray artwork.
#
# The tray source (src-tauri/icons/icon.png) is a 1323x1154 trimmed screenshot with
# transparent margins and is 573 KB -- over the host's 256 KiB icon cap, so it must be
# cropped and resized. This script emits a few square crops so a human can pick the one
# that still reads at the 36x36 size the plugin card renders.
#
# A face close-up usually reads better than the whole figure at 36px; the full-figure
# version is kept for comparison.
#
# ASCII-ONLY ON PURPOSE: Windows PowerShell reads .ps1 as ANSI unless the file has a
# UTF-8 BOM.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File make-plugin-icon.ps1 `
#     -In <icon.png> -OutDir <dir> [-Size 256]
param(
  [Parameter(Mandatory = $true)][string]$In,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [int]$Size = 256,
  # Which variant to install into the plugin package (e.g. -Pick face-l3). Empty = just render.
  # 2026-10-09: the chosen one is **face-l3** (crop window at 40% of the ink box) -- the head
  # fills the 36px card and nothing important is cut. face-l2 is the slightly roomier runner-up.
  [string]$Pick = ''
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

if (-not (Test-Path $In)) { throw "no source image at $In" }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$source = New-Object System.Drawing.Bitmap($In)

# ---- alpha bounding box: the trimmed screenshot still carries transparent margins ----
$rect = New-Object System.Drawing.Rectangle(0, 0, $source.Width, $source.Height)
$data = $source.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly,
  [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$bytes = New-Object byte[] ($data.Stride * $data.Height)
[System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
$source.UnlockBits($data)

$minX = $source.Width; $minY = $source.Height; $maxX = -1; $maxY = -1
for ($y = 0; $y -lt $source.Height; $y++) {
  $row = $y * $data.Stride
  for ($x = 0; $x -lt $source.Width; $x++) {
    # BGRA order; alpha is the 4th byte. 8 is a hair above "almost nothing".
    if ($bytes[$row + $x * 4 + 3] -gt 8) {
      if ($x -lt $minX) { $minX = $x }
      if ($x -gt $maxX) { $maxX = $x }
      if ($y -lt $minY) { $minY = $y }
      if ($y -gt $maxY) { $maxY = $y }
    }
  }
}
if ($maxX -lt 0) { throw 'the source image is fully transparent' }
$boxW = $maxX - $minX + 1
$boxH = $maxY - $minY + 1
Write-Host "[icon] source $($source.Width)x$($source.Height) -> ink box ${boxW}x${boxH} at $minX,$minY"

# ---- square crop helper: source rect stays square, so nothing is stretched ----
function Save-Crop([string]$name, [int]$cx, [int]$cy, [int]$side) {
  $half = [int]($side / 2)
  $x = $cx - $half
  $y = $cy - $half
  # Keep the window inside the image (shift instead of shrinking, so `side` is exact).
  if ($x -lt 0) { $x = 0 }
  if ($y -lt 0) { $y = 0 }
  if ($x + $side -gt $source.Width) { $x = $source.Width - $side }
  if ($y + $side -gt $source.Height) { $y = $source.Height - $side }
  if ($x -lt 0 -or $y -lt 0) { throw "crop $name does not fit (side=$side)" }

  $dst = New-Object System.Drawing.Bitmap($Size, $Size)
  $g = [System.Drawing.Graphics]::FromImage($dst)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $srcRect = New-Object System.Drawing.Rectangle($x, $y, $side, $side)
  $dstRect = New-Object System.Drawing.Rectangle(0, 0, $Size, $Size)
  $g.DrawImage($source, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
  $g.Dispose()

  $path = Join-Path $OutDir ($name + '.png')
  $dst.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $dst.Dispose()

  # A 36px copy: the plugin card renders exactly this size, so eyeball that one.
  $small = New-Object System.Drawing.Bitmap(36, 36)
  $sg = [System.Drawing.Graphics]::FromImage($small)
  $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $sg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $sg.Clear([System.Drawing.Color]::Transparent)
  $sg.DrawImage($source, (New-Object System.Drawing.Rectangle(0, 0, 36, 36)), $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
  $sg.Dispose()
  $smallPath = Join-Path $OutDir ($name + '-36.png')
  $small.Save($smallPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $small.Dispose()

  $kb = [math]::Round((Get-Item $path).Length / 1024, 1)
  Write-Host ("[icon] {0,-10} crop {1},{2} {3}x{3} -> {4} KB" -f $name, $x, $y, $side, $kb)
  return $path
}

# 1) face close-ups: the card renders a 36px square, so the frame has to sit on her head.
#    Where exactly is a taste call -- emit a few horizontal shifts and let a human pick
#    (the whale tail on the right eats the frame if you centre on the ink box).
$faceSide = [int]($boxH * 0.72)
$faceCy = [int]($minY + $boxH * 0.30)
$shifts = @(
  @{ name = 'face'; cx = 0.52 },
  @{ name = 'face-l1'; cx = 0.48 },
  @{ name = 'face-l2'; cx = 0.44 },
  @{ name = 'face-l3'; cx = 0.40 },
  @{ name = 'face-r1'; cx = 0.56 },
  @{ name = 'face-r2'; cx = 0.60 }
)
foreach ($shift in $shifts) {
  Save-Crop $shift.name ([int]($minX + $boxW * $shift.cx)) $faceCy $faceSide | Out-Null
}

# 2) upper body: head + arms + the whale tail, still square
Save-Crop 'upper' ([int]($minX + $boxW * 0.5)) ([int]($minY + $boxH * 0.42)) ([int]($boxH * 0.95))

# 3) whole figure: the ink box scaled into a square with transparent padding.
#    (It cannot be a crop -- the ink box is 1274x1105, taller than it is wide.)
function Save-Fit([string]$name, [int]$x, [int]$y, [int]$w, [int]$h, [double]$fill) {
  $side = [Math]::Max($w, $h)
  $dst = New-Object System.Drawing.Bitmap($Size, $Size)
  $g = [System.Drawing.Graphics]::FromImage($dst)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $target = [int]($Size * $fill)
  $scale = $target / $side
  $dw = [int]($w * $scale)
  $dh = [int]($h * $scale)
  $dx = [int](($Size - $dw) / 2)
  $dy = [int](($Size - $dh) / 2)
  $srcRect = New-Object System.Drawing.Rectangle($x, $y, $w, $h)
  $dstRect = New-Object System.Drawing.Rectangle($dx, $dy, $dw, $dh)
  $g.DrawImage($source, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
  $g.Dispose()
  $path = Join-Path $OutDir ($name + '.png')
  $dst.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $dst.Dispose()

  $small = New-Object System.Drawing.Bitmap(36, 36)
  $sg = [System.Drawing.Graphics]::FromImage($small)
  $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $sg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $sg.Clear([System.Drawing.Color]::Transparent)
  $sdx = [int](($36 - $dw * 36 / $Size) / 2)
  $sdy = [int](($36 - $dh * 36 / $Size) / 2)
  $sg.DrawImage($source, (New-Object System.Drawing.Rectangle($sdx, $sdy, [int]($dw * 36 / $Size), [int]($dh * 36 / $Size))), $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
  $sg.Dispose()
  $small.Save((Join-Path $OutDir ($name + '-36.png')), [System.Drawing.Imaging.ImageFormat]::Png)
  $small.Dispose()

  $kb = [math]::Round((Get-Item $path).Length / 1024, 1)
  Write-Host ("[icon] {0,-10} fit {1}x{2} at {3},{4} -> {5} KB" -f $name, $w, $h, $x, $y, $kb)
}
Save-Fit 'full' $minX $minY $boxW $boxH 0.94

# Contact sheet: the 256px crop and the real 36px rendering of every face shift, side by
# side, so the taste call is one look instead of six. Labels stay ASCII (PS 5.1 reads .ps1
# as ANSI without a BOM).
function Save-Sheet([string]$name, [string[]]$variants) {
  $cell = 170
  $small = 44
  $w = $cell * $variants.Count
  $h = $cell + 30 + $small + 12
  $sheet = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($sheet)
  $g.Clear([System.Drawing.Color]::White)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $font = New-Object System.Drawing.Font('Segoe UI', 9)
  $brush = [System.Drawing.Brushes]::Black
  # Precompute every rectangle: a bare `$a - 12` inside `New-Object T(...)` is parsed as a
  # command argument (and blows up with "Object[] does not contain op_Subtraction").
  $inner = $cell - 12
  $tinyX = [int](($cell - $small) / 2)
  for ($i = 0; $i -lt $variants.Count; $i++) {
    $big = [System.Drawing.Image]::FromFile((Join-Path $OutDir ($variants[$i] + '.png')))
    $tiny = [System.Drawing.Image]::FromFile((Join-Path $OutDir ($variants[$i] + '-36.png')))
    $x = $i * $cell + 6
    $bigRect = New-Object System.Drawing.Rectangle($x, 6, $inner, $inner)
    $tinyRect = New-Object System.Drawing.Rectangle(($x + $tinyX), ($cell + 26), $small, $small)
    $g.DrawImage($big, $bigRect)
    $g.DrawString($variants[$i], $font, $brush, $x, ($cell + 4))
    $g.DrawImage($tiny, $tinyRect)
    $big.Dispose(); $tiny.Dispose()
  }
  $g.Dispose()
  $path = Join-Path $OutDir ($name + '.png')
  $sheet.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $sheet.Dispose()
  Write-Host ('[icon] ' + $name + ' -> ' + $path)
}
Save-Sheet 'sheet-face' @('face-l3', 'face-l2', 'face-l1', 'face', 'face-r1', 'face-r2')

# Install one variant as the package icon (`dsh-live2d-pet/icon.png`) -- the plugin package
# has to carry the file itself: the host refuses an icon outside the package directory.
if ($Pick -ne '') {
  $chosen = Join-Path $OutDir ($Pick + '.png')
  if (-not (Test-Path $chosen)) { throw "no variant named '$Pick' in $OutDir" }
  $installed = Join-Path $PSScriptRoot '..\..\dsh-live2d-pet\icon.png'
  Copy-Item $chosen $installed -Force
  $kb = [math]::Round((Get-Item $installed).Length / 1024, 1)
  Write-Host ("[icon] installed {0} -> {1}  {2} KB" -f $Pick, (Resolve-Path $installed), $kb)
}

$source.Dispose()
Write-Host 'PLUGIN_ICON_OK'
