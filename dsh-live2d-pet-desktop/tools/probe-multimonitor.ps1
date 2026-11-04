# 多屏：**她不会被鼠标带走**（换屏只能由用户**拖动**她）。
#
# 判据（都是读真实几何，不看日志、不看自报字段）：
#
#   1. 窗口**压在某一块屏上**（不是整个虚拟桌面、也不是屏幕外）。注意 2026-11 起拖动
#      是"拖宠物 = 挪窗口"，所以拖过之后窗口**不一定**正好等于哪块屏的工作区 —— 那
#      是正常状态，这里只报"正不正"作为信息，不当判据；
#   2. 把光标依次移到**每一块**屏上，窗口矩形**一个像素都不变** ——
#      她属于她自己，位置不该由鼠标决定（用户报过"我鼠标在不同屏幕上宠物居然会跟随
#      我的鼠标所在的屏幕"）。这一条才是硬判据。
#
#   powershell -File tools/probe-multimonitor.ps1 [-ProcessName <名字>]
#
# 进程名不写就挨个试（npm 子包里那份叫 `dsh-pet-live2d-desktop`，`dist/` 打出来的叫
# `DSH桌宠`）—— 默认只认一个的话，换个安装方式跑就变成"没找到进程"。
param(
  [string]$ProcessName = ''
)

Add-Type -Namespace MM -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
'@ -ErrorAction SilentlyContinue

Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue

$proc = $null
if ($ProcessName -ne '') {
  $proc = Get-Process $ProcessName -ErrorAction SilentlyContinue | Select-Object -First 1
} else {
  foreach ($name in @('dsh-pet-live2d-desktop', 'DSH桌宠', 'DSH-pet')) {
    $proc = Get-Process $name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($proc) { break }
  }
}
if (-not $proc) { Write-Host 'FAIL 没找到桌面端进程（试过 dsh-pet-live2d-desktop / DSH桌宠 / DSH-pet）'; exit 2 }

function Get-RectText($handle) {
  $rect = New-Object MM.Native+RECT
  [void][MM.Native]::GetWindowRect($handle, [ref]$rect)
  return "$($rect.Left),$($rect.Top) $($rect.Right - $rect.Left)x$($rect.Bottom - $rect.Top)"
}

$screens = [System.Windows.Forms.Screen]::AllScreens
Write-Host ("显示器 " + $screens.Count + " 块")

# 1) 窗口得**压在某一块屏上**（不是整个虚拟桌面、也不是跑到屏幕外）。
# 变量别叫 $home —— 那是 PowerShell 的**只读内置变量**，赋值会报错并留空（踩过：整轮结果
# 都变成 "C:\Users\..." 那种家目录字符串）。
$homeRect = Get-RectText $proc.MainWindowHandle
$rect = New-Object MM.Native+RECT
[void][MM.Native]::GetWindowRect($proc.MainWindowHandle, [ref]$rect)

$exact = $null
$onScreen = $null
$best = 0
$bestW = 0
$bestH = 0
foreach ($screen in $screens) {
  $wa = $screen.WorkingArea
  if ($homeRect -eq "$($wa.X),$($wa.Y) $($wa.Width)x$($wa.Height)") { $exact = $screen }
  $w = [Math]::Min($rect.Right, $wa.Right) - [Math]::Max($rect.Left, $wa.X)
  $h = [Math]::Min($rect.Bottom, $wa.Bottom) - [Math]::Max($rect.Top, $wa.Y)
  if (($w -ge 200) -and ($h -ge 200) -and (($w * $h) -gt $best)) {
    $best = $w * $h
    $bestW = $w
    $bestH = $h
    $onScreen = $screen
  }
}
if ($onScreen) {
  Write-Host ("PASS 她压在某块屏上：" + $onScreen.DeviceName + "  可见 " + $bestW + "x" + $bestH + "  " + $homeRect)
} else {
  Write-Host ("FAIL 窗口完全跑到屏幕外了：" + $homeRect)
}
# 拖过之后窗口通常不再等于任何一块屏的工作区 —— 那是**正常状态**（拖宠物 = 挪窗口），
# 只作为信息打一行，不当判据。
if ($exact) {
  Write-Host ("（窗口正好等于这块屏的工作区：" + $exact.DeviceName + "）")
} else {
  Write-Host "（窗口不是任何一块屏的工作区的原尺寸 —— 拖过之后这是正常的）"
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
if ($onScreen -and ($moved -eq 0)) {
  Write-Host ("MULTIMONITOR PASS 光标走遍 " + $screens.Count + " 块屏，她一步没动")
  exit 0
}
Write-Host ("MULTIMONITOR FAIL 在某块屏上=" + [bool]$onScreen + "  被光标带走的次数=" + $moved)
exit 1
