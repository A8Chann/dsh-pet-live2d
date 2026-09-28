# 发布这个项目的两个包到 **官方 npm**。
#
# 为什么不用 `npm publish` 直接发（`tools/npm-publish.ps1` 那份也行，但它只发主包）：
#
#   * 本项目有**两份包**：主包 `dsh-pet-live2d` + 平台子包
#     `dsh-pet-live2d-desktop-win32-x64`（主包通过 optionalDependencies 引用它）。
#     **子包必须先发**，否则用户装主包时那个可选依赖 404（会被静默跳过 ⇒ 桌面端消失）。
#   * 本机 `npm config get registry` 是 **npmmirror 镜像**。镜像能装（读），但发布（写）
#     必须打官方源 —— 镜像自己会去同步官方，反过来不行。所以这里显式
#     `--registry https://registry.npmjs.org/`，不依赖本机配置。
#
# 凭据只从仓库外的文件读、只经环境变量传（不打印、不进命令行：进程列表可见）。
#
# ASCII-ONLY ON PURPOSE: Windows PowerShell 读 .ps1 按 ANSI，非 ASCII 注释会变成乱码
# 并可能让解析器崩掉（这个项目踩过一次）。
#
# 用法：
#   & tools/npm-publish-3.0.ps1 -Scope sub     只发平台子包
#   & tools/npm-publish-3.0.ps1 -Scope main    只发主包
#   & tools/npm-publish-3.0.ps1                两个都发（**子包先**）
param(
  [ValidateSet('both', 'sub', 'main')][string]$Scope = 'both',
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

$REGISTRY = 'https://registry.npmjs.org/'
$tokenPath = Join-Path $env:USERPROFILE '.dsh\npm-token.txt'
if (-not (Test-Path $tokenPath)) { throw "no token file at $tokenPath" }
$token = (Get-Content $tokenPath -Raw).Trim()
if ($token.Length -lt 20) { throw 'token file looks too short' }

$root = Join-Path $PSScriptRoot '..'
$sub = Join-Path $root 'dsh-live2d-pet-desktop\npm\desktop-win32-x64'
$main = Join-Path $root 'dsh-live2d-pet'

$rc = Join-Path $PSScriptRoot '.npmrc-publish-3.0'
Set-Content -Path $rc -Value '//registry.npmjs.org/:_authToken=${NPM_TOKEN}' -Encoding ascii
$env:NPM_TOKEN = $token

function Invoke-Npm([string[]]$npmArgs) {
  # Call npm with ErrorActionPreference temporarily relaxed: npm writes `warn`/`notice`
  # lines to stderr (e.g. "This command requires you to be logged in ... (dry-run)"),
  # and with ErrorActionPreference=Stop PowerShell turns that into a TERMINATING error
  # even when npm succeeded. Judge by exit code only.
  # (The older npm-publish.ps1 hit the same class of bug through `| Out-String`.)
  $saved = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & npm @npmArgs 2>&1 | Out-String | Write-Host
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $saved
  }
}

function Publish-One([string]$dir, [string]$label) {
  # Read as UTF-8 explicitly: package.json carries Chinese, ANSI read breaks JSON.
  $meta = [System.Text.Encoding]::UTF8.GetString(
    [System.IO.File]::ReadAllBytes((Join-Path $dir 'package.json'))) | ConvertFrom-Json
  Write-Host "[$label] $($meta.name)@$($meta.version)  ->  $REGISTRY"
  Push-Location $dir
  try {
    $args = @('publish', '--userconfig', $rc, '--registry', $REGISTRY)
    if ($DryRun) { $args += '--dry-run' }
    $code = Invoke-Npm $args
    if ($code -ne 0) { throw "[$label] publish failed (exit $code)" }
    Write-Host "[$label] OK"
  } finally {
    Pop-Location
  }
}

try {
  Push-Location $root
  $who = (Invoke-Npm @('whoami', '--userconfig', $rc, '--registry', $REGISTRY) | Out-String).Trim()
  Pop-Location
  if ($who -notmatch '\S') { throw 'token rejected (empty whoami)' }
  Write-Host "account: $who"

  # **子包先**：主包的 optionalDependencies 指的就是它。
  if ($Scope -eq 'both' -or $Scope -eq 'sub') { Publish-One $sub 'npm-sub' }
  if ($Scope -eq 'both' -or $Scope -eq 'main') { Publish-One $main 'npm-main' }
} finally {
  Remove-Item $rc -ErrorAction SilentlyContinue
  Remove-Item Env:\NPM_TOKEN -ErrorAction SilentlyContinue
}
