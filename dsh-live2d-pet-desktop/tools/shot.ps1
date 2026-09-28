# Capture a screen region to a PNG, so the "is it really transparent on the desktop"
# question is answered by a picture rather than by our own state file.
#
# Pure ASCII on purpose (see .dsh/skills/docs-and-workflow: Windows PowerShell reads
# .ps1 as ANSI/GBK without a BOM, and non-ASCII comments break the parser).
#
# Usage:
#   pwsh -File tools/shot.ps1 -X 3000 -Y 1000 -W 500 -H 400 -Out shots/pet.png
param(
  [Parameter(Mandatory = $true)][int]$X,
  [Parameter(Mandatory = $true)][int]$Y,
  [Parameter(Mandatory = $true)][int]$W,
  [Parameter(Mandatory = $true)][int]$H,
  [Parameter(Mandatory = $true)][string]$Out
)

Add-Type -AssemblyName System.Drawing
# Resolve the output path BEFORE creating the bitmap: GDI+ reports a generic error when
# handed a path whose directory does not exist yet, which reads like a capture failure
# rather than a missing-folder problem.
$full = [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $Out))
$dir = [System.IO.Path]::GetDirectoryName($full)
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

$bmp = New-Object System.Drawing.Bitmap($W, $H)
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$gfx.CopyFromScreen($X, $Y, 0, 0, (New-Object System.Drawing.Size($W, $H)))
$bmp.Save($full, [System.Drawing.Imaging.ImageFormat]::Png)
$gfx.Dispose()
$bmp.Dispose()
Write-Output ("SHOT_OK " + $full + " " + $W + "x" + $H)
