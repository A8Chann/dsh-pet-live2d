# Publish this package to npm.
#
# The token is read from a file OUTSIDE the repo (%USERPROFILE%\.dsh\npm-token.txt) and passed
# via the NPM_TOKEN environment variable: the .npmrc we generate only holds the ${NPM_TOKEN}
# placeholder, so no secret is ever written to disk.
#
# ASCII-ONLY ON PURPOSE: Windows PowerShell reads .ps1 as ANSI unless the file has a UTF-8 BOM,
# so non-ASCII comments here would turn into mojibake and break the parser (hit that once).
#
# Usage:  & tools/npm-publish.ps1 [-DryRun]
param([switch]$DryRun)
$ErrorActionPreference = 'Stop'

$tokenPath = Join-Path $env:USERPROFILE '.dsh\npm-token.txt'
if (-not (Test-Path $tokenPath)) { throw "no token file at $tokenPath (put one line, no quotes)" }
$token = (Get-Content $tokenPath -Raw).Trim()
if ($token.Length -lt 20) { throw 'token file looks too short; expected a single-line token' }

$pkg = Join-Path $PSScriptRoot '..\dsh-live2d-pet'
# Read as UTF-8 explicitly: package.json carries Chinese and the default ANSI read breaks JSON.
$meta = [System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes((Join-Path $pkg 'package.json'))) | ConvertFrom-Json
Write-Host "package: $($meta.name)@$($meta.version)"

$rc = Join-Path $PSScriptRoot '.npmrc-publish'
Set-Content -Path $rc -Value '//registry.npmjs.org/:_authToken=${NPM_TOKEN}' -Encoding ascii
$env:NPM_TOKEN = $token
try {
  Push-Location $pkg
  $who = (npm whoami --userconfig $rc 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { throw "token rejected by npm whoami: $who" }
  Write-Host "account: $who"
  if ($DryRun) {
    npm publish --dry-run --userconfig $rc
    if ($LASTEXITCODE -ne 0) { throw "dry-run failed (exit $LASTEXITCODE)" }
    Write-Host 'DRYRUN_OK'
    return
  }
  npm publish --userconfig $rc
  $code = $LASTEXITCODE
  if ($code -ne 0) { throw "npm publish failed (exit $code)" }
  Write-Host "PUBLISH_OK https://www.npmjs.com/package/$($meta.name)"
} finally {
  Pop-Location
  Remove-Item $rc -ErrorAction SilentlyContinue
  Remove-Item Env:\NPM_TOKEN -ErrorAction SilentlyContinue
}
