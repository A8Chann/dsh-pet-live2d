# 多屏跟随的端到端验证：把光标移到每一块屏上，读窗口真实几何，比对期望的工作区。
#
# 判据是**窗口矩形**，不是日志、不是我们的自报字段 —— 只有窗口真的搬过去了，
# 鼠标才能在别的屏幕上"看到她"、跟随与穿透判定才有意义。
#
#   pwsh -File tools/probe-multimonitor.ps1 [-ProcessName DSH桌宠]
param(
  [string]$ProcessName = 'DSH桌宠'
)

Add-Type -Namespace MM -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
[DllImport("user32.dll")] public static extern IntPtr FindWindowW(string cls, string title);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
'@ -ErrorAction SilentlyContinue

Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue

$proc = Get-Process $ProcessName -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) { Write-Host 'FAIL 没找到桌面端进程'; exit 2 }

# 每个显示器取一个"屏内点"（工作区中心），再读窗口矩形。
$screens = [System.Windows.Forms.Screen]::AllScreens
Write-Host ("显示器 " + $screens.Count + " 块")

$results = @()
foreach ($screen in $screens) {
  $wa = $screen.WorkingArea
  $cx = [int]($wa.X + $wa.Width / 2)
  $cy = [int]($wa.Y + $wa.Height / 2)
  [void][MM.Native]::SetCursorPos($cx, $cy)
  Start-Sleep -Milliseconds 900   # 跟随循环 33ms 一轮；给窗口移动与页面重排留余量
  $rect = New-Object MM.Native+RECT
  [void][MM.Native]::GetWindowRect($proc.MainWindowHandle, [ref]$rect)
  $ok = ($rect.Left -eq $wa.X) -and ($rect.Top -eq $wa.Y) `
    -and (($rect.Right - $rect.Left) -eq $wa.Width) -and (($rect.Bottom - $rect.Top) -eq $wa.Height)
  $results += [pscustomobject]@{
    屏 = $screen.DeviceName
    主屏 = $screen.Primary
    光标 = "$cx,$cy"
    期望 = "$($wa.X),$($wa.Y) $($wa.Width)x$($wa.Height)"
    实际 = "$($rect.Left),$($rect.Top) $($rect.Right - $rect.Left)x$($rect.Bottom - $rect.Top)"
    通过 = $ok
  }
}

$results | Format-Table -AutoSize | Out-String | Write-Host
$failed = @($results | Where-Object { -not $_.通过 }).Count
Write-Host ''
if ($failed -eq 0) { Write-Host ("MULTIMONITOR PASS " + $results.Count + "/" + $results.Count) ; exit 0 }
Write-Host ("MULTIMONITOR FAIL " + ($results.Count - $failed) + "/" + $results.Count)
exit 1
