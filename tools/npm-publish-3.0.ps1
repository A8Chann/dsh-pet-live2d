# Publish BOTH packages of this project to the official npm registry.
#
# Why not plain `npm publish` (or tools/npm-publish.ps1, which only does the main package):
#
#   * There are TWO packages: the main one `dsh-pet-live2d` and the platform sub-package
#     `dsh-pet-live2d-desktop-win32-x64` (referenced from the main package through
#     optionalDependencies). **The sub-package must go first**, otherwise installing the
#     main package 404s on that optional dependency (npm silently skips it => the desktop
#     app disappears for the user).
#   * This machine's `npm config get registry` points at the npmmirror mirror. Mirrors can
#     serve reads but NOT writes, so publishing must target the official registry
#     explicitly: `--registry https://registry.npmjs.org/`.
#
# Credentials are read from a file outside the repo and passed only through an environment
# variable (never printed, never on the command line: process lists are visible).
#
# ASCII-ONLY ON PURPOSE: Windows PowerShell reads .ps1 as ANSI unless the file has a UTF-8
# BOM. Non-ASCII comments then turn into mojibake and can break the parser -- sometimes by
# swallowing a line, which reports a parse error somewhere else entirely. Hit that twice.
#
# Usage:
#   & tools/npm-publish-3.0.ps1 -Scope sub     # sub-package only
#   & tools/npm-publish-3.0.ps1 -Scope main    # main package only
#   & tools/npm-publish-3.0.ps1                # both (sub-package first)
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
  # Read as UTF-8 explicitly: package.json carries Chinese, an ANSI read breaks the JSON.
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
  # `npm whoami` also returns the account name; when the token is dead npm prints
  # "npm error code E401 ..." instead, which is NOT empty. Checking emptiness alone once
  # let a dead token walk all the way to publish (three E401/E404 lines before it stopped),
  # so the name must also look like an account name.
  $who = (Invoke-Npm @('whoami', '--userconfig', $rc, '--registry', $REGISTRY) | Out-String).Trim()
  Pop-Location
  if ($who -notmatch '\S') { throw 'token rejected (empty whoami)' }
  if ($who -match 'E401|E403|npm error|Unauthorized') { throw "token rejected by npm whoami: $who" }
  if ($who -notmatch '^[A-Za-z0-9._-]+$') { throw "unexpected whoami output: $who" }
  Write-Host "account: $who"

  # Sub-package FIRST: the main package's optionalDependencies point at it.
  if ($Scope -eq 'both' -or $Scope -eq 'sub') { Publish-One $sub 'npm-sub' }
  if ($Scope -eq 'both' -or $Scope -eq 'main') { Publish-One $main 'npm-main' }
} finally {
  Remove-Item $rc -ErrorAction SilentlyContinue
  Remove-Item Env:\NPM_TOKEN -ErrorAction SilentlyContinue
}
