# Create Synapse test accounts for the twin test system, prefixed `aitester-`
# to avoid confusing real colleagues. Each account gets a token printed in
# COLLEAGUE_TOKENS format (ready to paste into test-system\.env).
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\create-aitesters.ps1
#     [-Users @("zhang","li","wang","zhao")]
#     [-Home "https://im-ipm.ict.cmcc"] [-Password "Synapse@2026!Demo"]
#
# Output: one line per account:  OK @aitester-zhang:server:syt_xxx
#         and a final COLLEAGUE_TOKENS=... line for .env
param(
  [string[]]$Users = @("zhang", "li", "wang", "zhao"),
  [string]$HomeUrl = "https://im-ipm.ict.cmcc",
  [string]$Password = "Synapse@2026!Demo"
)
$ErrorActionPreference = "Stop"
$regUri = "$HomeUrl/_matrix/client/v3/register?kind=user"
$loginUri = "$HomeUrl/_matrix/client/v3/login"

# NOTE: Invoke-WebRequest on Windows PowerShell 5.1 returns an EMPTY body stream for
# non-2xx responses (IE parser consumes it), so use curl.exe to read UIA session / errors.
# The body is written to a temp file and sent via "-d @file" to avoid PowerShell
# 5.1 -> native command argument-quoting bugs.
function Invoke-CurlJson {
  param([string]$Uri, [string]$Body)
  $tmp = Join-Path $env:TEMP ("reg-" + [guid]::NewGuid().ToString("N") + ".json")
  [System.IO.File]::WriteAllText($tmp, $Body, (New-Object System.Text.UTF8Encoding($false)))
  try {
    return & curl.exe -sk --connect-timeout 8 -X POST -H "Content-Type: application/json" --data-binary "@$tmp" $Uri
  } finally {
    Remove-Item $tmp -ErrorAction SilentlyContinue
  }
}

function Get-RegSession {
  for ($try = 1; $try -le 8; $try++) {
    $resp = Invoke-CurlJson -Uri $regUri -Body '{}'
    if (-not $resp) { return $null }
    $json = $resp | ConvertFrom-Json
    if ($json.session) { return $json.session }
    if ($json.errcode -eq "M_LIMIT_EXCEEDED") { Start-Sleep -Seconds 7; continue }
    return $null
  }
  return $null
}

$tokens = @()
foreach ($u in $Users) {
  $username = "aitester-$u"
  Write-Host "== $username =="

  # 1. Register (two-phase UIA).
  $sess = Get-RegSession
  if (-not $sess) { Write-Host "FAIL $username : no reg session"; continue }
  $body = @{ username = $username; password = $Password; auth = @{ type = "m.login.dummy"; session = $sess } } |
    ConvertTo-Json -Depth 3
  $registered = $false
  $regToken = $null
  $regUserId = $null
  foreach ($try in 1..8) {
    $resp = Invoke-CurlJson -Uri $regUri -Body $body
    if (-not $resp) { Write-Host "FAIL $username : empty response"; break }
    $json = $resp | ConvertFrom-Json
    if ($json.user_id) {
      Write-Host "OK  registered $($json.user_id)"
      $regUserId = $json.user_id
      if ($json.access_token) { $regToken = $json.access_token }
      $registered = $true
      break
    }
    if ($json.errcode -eq "M_LIMIT_EXCEEDED") { Start-Sleep -Seconds 7; continue }
    if ($resp -match "already") { Write-Host "SKIP $username (exists)"; $registered = $true }
    else { Write-Host "FAIL $username : $resp" }
    break
  }
  if (-not $registered) { continue }

  # 2. Token: prefer registration-returned, else password login.
  $token = $regToken
  if (-not $token) {
    $loginBody = @{ type = "m.login.password"; identifier = @{ type = "m.id.user"; user = $username }; password = $Password } |
      ConvertTo-Json -Depth 4
    foreach ($try in 1..5) {
      $resp = Invoke-CurlJson -Uri $loginUri -Body $loginBody
      if (-not $resp) { Write-Host "FAIL $username : login empty"; break }
      $json = $resp | ConvertFrom-Json
      if ($json.access_token) { $token = $json.access_token; break }
      if ($json.errcode -eq "M_LIMIT_EXCEEDED") { Start-Sleep -Seconds 7; continue }
      Write-Host "FAIL $username : login $resp"
      break
    }
  }
  if (-not $token) {
    Write-Host "FAIL $username : no token"
    continue
  }
  $userId = $regUserId
  if (-not $userId) {
    $server = $HomeUrl -replace '^https?://', '' -replace '/$', ''
    $userId = "@$username" + ":" + $server
  }
  $tokens += "$userId" + ":" + $token
  Write-Host "OK  token -> $userId"
}

Write-Host ""
if ($tokens.Count -gt 0) {
  Write-Host "=== paste into test-system\.env ==="
  Write-Host ("COLLEAGUE_TOKENS=" + ($tokens -join ","))
} else {
  Write-Host "No accounts created."
}
