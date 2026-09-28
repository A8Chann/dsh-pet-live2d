# 多屏：**她待在自己那块屏上，不跟着鼠标跑**。
#
# 判据（都是读真实几何，不看日志、不看自报字段）：
#
#   1. 窗口正好覆盖**某一块**屏的工作区（不是整个虚拟桌面、也不是别的位置）；
#   2. 把光标依次移到**每一块**屏上，窗口矩形**一个像素都不变** ——
#      她属于她自己那块屏，位置不该由鼠标决定（用户报过"我鼠标在不同屏幕上宠物居然会
#      跟随我的鼠标所在的屏幕"）。
#
#   powershell -File tools/probe-multimonitor.ps1 [-ProcessName DSH桌宠]
param(
  [string]$ProcessName = 'DSH桌宠'
)

Add-Type -Namespace MM -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
'@ -ErrorAction SilentlyContinue

Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue

$proc = Get-Process $ProcessName -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) { Write-Host 'FAIL 没找到桌面端进程'; exit 2 }

function Get-RectText($handle) {
  $rect = New-Object MM.Native+RECT
  [void][MM.Native]::GetWindowRect($handle, [ref]$rect)
  return "$($rect.Left),$($rect.Top) $($rect.Right - $rect.Left)x$($rect.Bottom - $rect.Top)"
}

$screens = [System.Windows.Forms.Screen]::AllScreens
Write-Host ("显示器 " + $screens.Count + " 块")

# 1) 窗口应当**正好**落在某一块屏的工作区上。
# 变量别叫 $home —— 那是 PowerShell 的**只读内置变量**，赋值会报错并留空（踩过：整轮结果
# 都变成 "C:\Users\..." 那种家目录字符串）。
$homeRect = Get-RectText $proc.MainWindowHandle
$matched = $null
foreach ($screen in $screens) {
  $wa = $screen.WorkingArea
  if ($homeRect -eq "$($wa.X),$($wa.Y) $($wa.Width)x$($wa.Height)") { $matched = $screen; break }
}
if ($matched) {
  Write-Host ("PASS 她待在某一块屏的工作区上：" + $matched.DeviceName + "  " + $homeRect)
} else {
  Write-Host ("FAIL 窗口不在任何一块屏的工作区上：" + $homeRect)
}

# 2) 光标移到每一块屏，窗口**不许动**。
$rows = @()
foreach ($screen in $screens) {
  $wa = $screen.WorkingArea
  [void][MM.Native]::SetCursorPos([int]($wa.X + $wa.Width / 2), [int]($wa.Y + $wa.Height / 2))
  Start-Sleep -Milliseconds 800
  $now = Get-RectText $proc.MainWindowHandle
  $rows += [pscustomobject]@{
    光标移到 = $screen.DeviceName
    窗口 = $now
    没动 = ($now -eq $homeRect)
  }
}
$rows | Format-Table -AutoSize | Out-String | Write-Host

$moved = @($rows | Where-Object { -not $_.没动 }).Count
Write-Host ''
if ($matched -and $moved -eq 0) {
  Write-Host ("MULTIMONITOR PASS 光标走遍 " + $screens.Count + " 块屏，她一步没动")
  exit 0
}
Write-Host ("MULTIMONITOR FAIL 待在自己屏上=" + [bool]$matched + "  被光标带走的次数=" + $moved)
exit 1
