# Click-through probe: move the OS cursor to a screen point, then read the WINDOW's
# extended style.
#
# Why the extended style and not the shell's own boolean: WS_EX_TRANSPARENT (0x20)
# is the bit the OS hit-testing actually looks at. The shell's `ignored` field is
# only our intent; this bit is the authority on whether a click at that point
# reaches the desktop or the pet. They must agree.
#
# NOTE: this script is deliberately pure ASCII -- Windows PowerShell reads .ps1 as
# ANSI/GBK unless the file has a UTF-8 BOM, and non-ASCII comments then break the
# parser with wrong line numbers (see .dsh/skills/docs-and-workflow).
#
# Usage:
#   pwsh -File tools/probe-through.ps1 -X 150 -Y 320 -Label empty
#   pwsh -File tools/probe-through.ps1 -X 500 -Y 400 -Label pet
param(
  [Parameter(Mandatory = $true)][int]$X,
  [Parameter(Mandatory = $true)][int]$Y,
  [string]$Label = 'probe',
  [int]$WaitMs = 600,
  [string]$ProcessName = 'dsh-pet-live2d-desktop'
)

Add-Type -Namespace Win -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
[DllImport("user32.dll")] public static extern int GetWindowLong(System.IntPtr hWnd, int nIndex);
[DllImport("user32.dll")] public static extern System.IntPtr WindowFromPoint(POINT p);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint pid);
public struct POINT { public int X; public int Y; }
'@

$proc = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) { Write-Output "PROBE_FAIL no-process $ProcessName"; exit 2 }
$hwnd = $proc.MainWindowHandle

[void][Win.Native]::SetCursorPos($X, $Y)
Start-Sleep -Milliseconds $WaitMs

$ex = [Win.Native]::GetWindowLong($hwnd, -20)
$transparent = ($ex -band 0x20) -ne 0
$layered = ($ex -band 0x80000) -ne 0
$tool = ($ex -band 0x80) -ne 0

$point = New-Object Win.Native+POINT
[void][Win.Native]::GetCursorPos([ref]$point)

# WindowFromPoint skips our layer entirely while it ignores cursor events, so this
# is the same question asked from the OS side: "who owns the pixel under the cursor?"
$under = [Win.Native]::WindowFromPoint($point)
$underIsUs = ($under -eq $hwnd)
$underPid = 0
if ($under -ne [System.IntPtr]::Zero) {
  [void][Win.Native]::GetWindowThreadProcessId($under, [ref]$underPid)
}

$result = [ordered]@{
  label           = $Label
  cursor          = @($point.X, $point.Y)
  hwnd            = $hwnd.ToInt64()
  exStyle         = ('0x{0:X}' -f $ex)
  wsExTransparent = $transparent
  wsExLayered     = $layered
  wsExToolWindow  = $tool
  windowFromPoint = $(if ($underIsUs) { 'us' } else { 'other-pid-' + $underPid })
  underIsUs       = $underIsUs
}
Write-Output ('PROBE ' + ($result | ConvertTo-Json -Compress))
