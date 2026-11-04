# 拖动：**拖宠物 = 挪窗口**（跨屏就靠这一条，见 skill: desktop-shell）。
#
# 判据（真实光标 + 真实按键 + 壳的读口，不看截图、不看自报"我拖了"）：
#
#   1. 光标停在她身上时，壳的判定是 `interactive=true` 且 `lastReason=pet`
#      —— 说明这一点**真的按得到她**（否则后面按下去等于点桌面）；
#   2. 按住左键把她拖 240px：**窗口矩形跟着挪了同样的距离**（±12px）；
#   3. 拖动过程中壳报告 `dragging=true`；松手后回到 false，且窗口**停住不动**。
#
# 为什么不用 CDP：这条验的是"页面 → 壳 → 窗口"整条链，而"按下"必须是**真鼠标事件**
# （合成事件不会让页面的 pointerdown 走真路径）。壳的 `/__desktop/shell` 读口够用了。
#
#   powershell -File tools/probe-drag.ps1 [-ProcessName <名字>]
#
# 进程名不写就**挨个试**：npm 子包里那份叫 `dsh-pet-live2d-desktop`，`dist/` 打出来的
# 叫 `DSH桌宠` —— 默认只认一个的话，换个安装方式跑就变成"FAIL 没找到桌面端进程"
# （2026-11 换成本地构建的时候就撞了这一下）。
param(
  [string]$ProcessName = ''
)

Add-Type -Namespace DG -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, uint e);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
'@ -ErrorAction SilentlyContinue

$LEFTDOWN = 0x0002
$LEFTUP = 0x0004

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

function Get-Rect($handle) {
  $rect = New-Object DG.Native+RECT
  [void][DG.Native]::GetWindowRect($handle, [ref]$rect)
  return $rect
}

# ---------------------------------------------------------------- 壳的读口
#
# 端口是壳每次启动随机开的，进程表里问不出来（`Get-NetTCPConnection -OwningProcess`
# 在部分环境下返回空）。用 netstat 把**这个 pid** 的监听端口抓出来，再逐个问一句
# `/__desktop/shell` —— 答得上来（有 interactive 字段）的那个就是壳。

function Get-ShellPort([int]$pidValue) {
  $ports = @()
  foreach ($line in (netstat -ano | Select-String 'LISTENING')) {
    $parts = @($line.ToString().Trim() -split '\s+' | Where-Object { $_ -ne '' })
    if ($parts.Count -lt 5) { continue }
    if ($parts[4] -ne [string]$pidValue) { continue }
    $address = $parts[1]
    $at = $address.LastIndexOf(':')
    if ($at -le 0) { continue }
    $port = 0
    if (-not [int]::TryParse($address.Substring($at + 1), [ref]$port)) { continue }
    $ports += $port
  }
  foreach ($port in ($ports | Sort-Object -Unique)) {
    try {
      $state = Invoke-RestMethod -Uri ("http://127.0.0.1:" + $port + "/__desktop/shell") -TimeoutSec 2
      if ($null -ne $state -and $null -ne $state.lastReason) { return $port }
    } catch { }
  }
  return 0
}

$port = Get-ShellPort $proc.Id
if ($port -eq 0) { Write-Host 'FAIL 找不到壳的 HTTP 读口（netstat 里这个 pid 没有能答 /__desktop/shell 的端口）'; exit 2 }
Write-Host ("壳的读口：127.0.0.1:" + $port)

function Get-ShellState {
  try { return Invoke-RestMethod -Uri ("http://127.0.0.1:" + $port + "/__desktop/shell") -TimeoutSec 2 } catch { return $null }
}

$rect = Get-Rect $proc.MainWindowHandle
Write-Host ("窗口：" + $rect.Left + "," + $rect.Top + "  " + ($rect.Right - $rect.Left) + "x" + ($rect.Bottom - $rect.Top))

$state = Get-ShellState
if ($null -eq $state) { Write-Host 'FAIL 读不到壳状态'; exit 2 }
$scale = 1.0
if ($null -ne $state.scale -and $state.scale -gt 0) { $scale = [double]$state.scale }

# 她在窗口的**右下角**（`lib/client.js` 默认 `right:24, bottom:0`、默认 300px）。
# 候选点从她的中心往几个常见实心位置试：正中心、偏下（身体/尾巴）、偏上（头）。
$size = 300.0 * $scale
$marginX = 24.0 * $scale
$petRight = [double]$rect.Right - $marginX
$petBottom = [double]$rect.Bottom
$candidates = @(
  @{ x = $petRight - $size * 0.50; y = $petBottom - $size * 0.50 },
  @{ x = $petRight - $size * 0.50; y = $petBottom - $size * 0.30 },
  @{ x = $petRight - $size * 0.50; y = $petBottom - $size * 0.68 },
  @{ x = $petRight - $size * 0.70; y = $petBottom - $size * 0.40 }
)

# 1) 找到一个**按得到她**的点：壳的判定必须变成 reason=pet。
$hit = $null
foreach ($candidate in $candidates) {
  $x = [int][Math]::Round($candidate.x)
  $y = [int][Math]::Round($candidate.y)
  [void][DG.Native]::SetCursorPos($x, $y)
  $deadline = (Get-Date).AddMilliseconds(1600)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 120
    $now = Get-ShellState
    if ($null -eq $now) { break }
    if ($now.interactive -eq $true -and $now.lastReason -eq 'pet') { $hit = @{ x = $x; y = $y }; break }
  }
  if ($null -ne $hit) { break }
}
if ($null -eq $hit) {
  Write-Host 'FAIL 试了 4 个候选点都没落在她身上（interactive/reason 一直不是 pet）—— 她没在显示？'
  exit 1
}
Write-Host ("PASS 找到可拖动的点：" + $hit.x + "," + $hit.y + "（壳判定 reason=pet）")

# 2) 真按下去、拖 240px 往**左上**（往屏幕里拖：往右下会把光标推出屏幕）。
$dx = -240
$dy = -120
$before = Get-Rect $proc.MainWindowHandle
[void][DG.Native]::SetCursorPos($hit.x, $hit.y)
Start-Sleep -Milliseconds 150
[DG.Native]::mouse_event($LEFTDOWN, 0, 0, 0, 0)
Start-Sleep -Milliseconds 180

$dragging = $false
$deadline = (Get-Date).AddMilliseconds(1200)
while ((Get-Date) -lt $deadline) {
  $now = Get-ShellState
  if ($null -ne $now -and $now.dragging -eq $true) { $dragging = $true; break }
  Start-Sleep -Milliseconds 80
}

# 分 6 步挪过去，模拟真实的手（一步跳完也能过，但分步更像真拖动、也顺便验了连续跟随）。
for ($step = 1; $step -le 6; $step++) {
  $nx = $hit.x + [int]($dx * $step / 6)
  $ny = $hit.y + [int]($dy * $step / 6)
  [void][DG.Native]::SetCursorPos($nx, $ny)
  Start-Sleep -Milliseconds 40
}
Start-Sleep -Milliseconds 200
[DG.Native]::mouse_event($LEFTUP, 0, 0, 0, 0)
Start-Sleep -Milliseconds 350
$after = Get-Rect $proc.MainWindowHandle

$movedX = $after.Left - $before.Left
$movedY = $after.Top - $before.Top

if ($dragging) {
  Write-Host 'PASS 拖动过程中壳报告 dragging=true'
} else {
  Write-Host 'FAIL 拖动过程中壳一直没报 dragging=true（页面没把 pointerdown 投给壳？）'
}

# 3) 窗口跟着挪了同样的距离。
#   容差 12px：壳每 8ms 追一次光标，最后一步可能差一两像素；DPI 缩放的取整也在里面。
$tolerance = 12
$okX = [Math]::Abs($movedX - $dx) -le $tolerance
$okY = [Math]::Abs($movedY - $dy) -le $tolerance
if ($okX -and $okY) {
  Write-Host ("PASS 窗口跟着挪了 " + $movedX + "," + $movedY + "（期望 " + $dx + "," + $dy + "）")
} else {
  Write-Host ("FAIL 窗口只挪了 " + $movedX + "," + $movedY + "（期望 " + $dx + "," + $dy + "，容差 " + $tolerance + "）")
}

# 4) 松手之后必须停住：再等 400ms，矩形不许再变（否则就是"按键松了还在跟鼠标"）。
Start-Sleep -Milliseconds 400
$rest = Get-Rect $proc.MainWindowHandle
$still = ($rest.Left -eq $after.Left) -and ($rest.Top -eq $after.Top)
if ($still) {
  Write-Host 'PASS 松手后窗口停住了'
} else {
  Write-Host ("FAIL 松手后窗口还在动：" + $rest.Left + "," + $rest.Top + " → " + $after.Left + "," + $after.Top)
}

$final = Get-ShellState
if ($null -ne $final -and $final.dragging -eq $false) {
  Write-Host 'PASS 壳的 dragging 已回到 false'
} else {
  Write-Host 'FAIL 壳的 dragging 还停在 true（松手没被观察到）'
}

Write-Host ''
if ($dragging -and $okX -and $okY -and $still) {
  Write-Host 'DRAG PASS 拖宠物 = 挪窗口，窗口按屏幕坐标跟着走'
  exit 0
}
Write-Host 'DRAG FAIL 见上面每一条'
exit 1
