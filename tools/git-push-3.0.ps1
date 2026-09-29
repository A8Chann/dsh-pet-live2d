# Push main + v3.0.0 to GitHub without touching the (broken) credential helper.
#
# Approach: add a TEMPORARY remote whose URL embeds the token, push, then delete that remote.
# Why not a credential helper: this machine's git 2.38.1.windows.1 rejects
# `helper = store --file=<path>` outright ("fatal: bad config line 2" -- reproduced in
# isolation), and plain `store` did not pick up a HOME-redirected .git-credentials either.
# The system-level `manager-core` helper is stale ("Invalid username or token"), and masking
# only the global config is not enough because the system one is consulted too.
#
# The token is read from OUTSIDE the repo (%USERPROFILE%\.dsh\github-token.txt). It is not
# printed here, but note it DOES appear in the temporary remote URL, so:
#   * the remote is removed in a `finally` block (also on failure);
#   * `git remote -v` output is deliberately not shown.
# This script is ASCII-only and is NOT committed.
#
# Usage:  & tools/git-push-3.0.ps1 [-DryRun]
param([switch]$DryRun)
$ErrorActionPreference = 'Stop'

$tokenPath = Join-Path $env:USERPROFILE '.dsh\github-token.txt'
if (-not (Test-Path $tokenPath)) { throw "no token file at $tokenPath" }
$token = (Get-Content $tokenPath -Raw).Trim()
if ($token.Length -lt 20) { throw 'token file looks too short' }

$root = Join-Path $PSScriptRoot '..'
$remote = 'dsh-push-tmp'
# http knobs: this line to GitHub is slow enough to trip the default low-speed threshold when
# pushing a few MB ("Failed to connect to github.com port 443 after 21074 ms").
# `http.proxy=` (empty) CLEARS any configured proxy: one run had git trying 127.0.0.1:7890
# (a local proxy that was not running) and failing with "Connection refused".
$gitCfg = @(
  '-c', 'http.version=HTTP/1.1',
  '-c', 'http.lowSpeedLimit=1000',
  '-c', 'http.lowSpeedTime=900',
  '-c', 'http.proxy=',
  '-c', 'https.proxy='
)

function Invoke-Git([string[]]$gitArgs, [switch]$Quiet) {
  $saved = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & git @gitArgs 2>&1 | Out-String
    if (-not $Quiet) { $out | Write-Host }
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $saved
  }
}

$env:GIT_TERMINAL_PROMPT = '0'
try {
  Push-Location $root
  # Clean up any leftover from an earlier failed run.
  Invoke-Git @('remote', 'remove', $remote) -Quiet | Out-Null
  $code = Invoke-Git (@('remote', 'add', $remote, "https://A8Chann:$token@github.com/A8Chann/dsh-pet-live2d.git"))
  if ($code -ne 0) { throw "adding the temporary remote failed (exit $code)" }

  $flags = @()
  if ($DryRun) { $flags += '--dry-run' }
  Write-Host '--- push main'
  $code = Invoke-Git (@($gitCfg) + @('push') + $flags + @($remote, 'main:main'))
  if ($code -ne 0) { throw "push main failed (exit $code)" }
  Write-Host '--- push tag v3.0.0'
  $code = Invoke-Git (@($gitCfg) + @('push') + $flags + @($remote, 'refs/tags/v3.0.0:refs/tags/v3.0.0'))
  if ($code -ne 0) { throw "push tag failed (exit $code)" }
  Write-Host 'PUSH_OK'
} finally {
  Invoke-Git @('remote', 'remove', $remote) -Quiet | Out-Null
  Pop-Location
  Remove-Item Env:\GIT_TERMINAL_PROMPT -ErrorAction SilentlyContinue
}
