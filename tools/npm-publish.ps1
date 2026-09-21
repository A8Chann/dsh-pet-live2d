# 发布到 npm。token 从仓库外的文件读，**不写进 .npmrc**（用 ${NPM_TOKEN} 占位 + 环境变量）。
# 用法： pwsh tools/npm-publish.ps1 [-DryRun]
param([switch]$DryRun)
$ErrorActionPreference = 'Stop'
$tokenPath = Join-Path $env:USERPROFILE '.dsh\npm-token.txt'
if (-not (Test-Path $tokenPath)) { Write-Error "读不到 token：$tokenPath`n先放一份：Set-Content -Path ""$tokenPath"" -Value ""npm_xxx"" -NoNewline -Encoding ascii"; exit 2 }
$token = (Get-Content $tokenPath -Raw).Trim()
if ($token.Length -lt 20) { Write-Error 'token 文件内容太短，确认只放了一行'; exit 2 }

$pkg = Join-Path $PSScriptRoot '..\dsh-live2d-pet'
$name = (Get-Content (Join-Path $pkg 'package.json') -Raw | ConvertFrom-Json).name
$ver = (Get-Content (Join-Path $pkg 'package.json') -Raw | ConvertFrom-Json).version
Write-Host "包：$name@$ver"

# .npmrc 里只放占位符，真 token 走环境变量 —— 磁盘上不留密钥。
$rc = Join-Path $env:TEMP 'dsh-npmrc'
Set-Content -Path $rc -Value '//registry.npmjs.org/:_authToken=${NPM_TOKEN}' -Encoding ascii
$env:NPM_TOKEN = $token
try {
  Push-Location $pkg
  $who = (npm whoami --userconfig $rc 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { Write-Error "token 不可用（npm whoami 失败）：$who"; exit 1 }
  Write-Host "账号：$who"
  if ($DryRun) { npm publish --dry-run --userconfig $rc; exit $LASTEXITCODE }
  npm publish --userconfig $rc
  $code = $LASTEXITCODE
  Pop-Location
  if ($code -eq 0) { Write-Host "已发布：https://www.npmjs.com/package/$name" }
  exit $code
} finally {
  Remove-Item $rc -ErrorAction SilentlyContinue
  Remove-Item Env:\NPM_TOKEN -ErrorAction SilentlyContinue
}
