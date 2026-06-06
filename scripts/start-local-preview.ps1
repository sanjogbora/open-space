param(
  [switch]$OpenBrowser
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$apiUrl = "http://127.0.0.1:5175"
$studioUrl = "http://127.0.0.1:5174"
$logDir = Join-Path $repoRoot ".dev-logs"
$apiLog = Join-Path $logDir "api.log"
$apiErr = Join-Path $logDir "api.err.log"
$studioLog = Join-Path $logDir "studio.log"
$studioErr = Join-Path $logDir "studio.err.log"
$studioDir = Join-Path $repoRoot "apps/studio"
$apiScript = Join-Path $repoRoot "apps/api/src/server.mjs"
$viteCmd = Join-Path $studioDir "node_modules/.bin/vite.CMD"

function Test-Http($Url) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing $Url -TimeoutSec 4
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
  } catch {
    return $false
  }
}

function Start-LoggedProcess($Name, $FilePath, $ArgumentList, $WorkingDirectory, $StdOut, $StdErr) {
  Write-Host "Starting $Name..."
  Start-Process `
    -FilePath $FilePath `
    -ArgumentList $ArgumentList `
    -WorkingDirectory $WorkingDirectory `
    -RedirectStandardOutput $StdOut `
    -RedirectStandardError $StdErr `
    -WindowStyle Hidden | Out-Null
}

New-Item -ItemType Directory -Force $logDir | Out-Null

if (-not (Test-Path $apiScript)) {
  throw "API server file not found: $apiScript"
}

if (-not (Test-Path $viteCmd)) {
  throw "Studio Vite launcher not found: $viteCmd. Run pnpm install first."
}

if (Test-Http "$apiUrl/health") {
  Write-Host "API already running at $apiUrl"
} else {
  Clear-Content $apiLog -ErrorAction SilentlyContinue
  Clear-Content $apiErr -ErrorAction SilentlyContinue
  Start-LoggedProcess `
    -Name "API" `
    -FilePath "node.exe" `
    -ArgumentList @($apiScript) `
    -WorkingDirectory $repoRoot `
    -StdOut $apiLog `
    -StdErr $apiErr
}

if (Test-Http "$studioUrl/") {
  Write-Host "Studio already running at $studioUrl"
} else {
  Clear-Content $studioLog -ErrorAction SilentlyContinue
  Clear-Content $studioErr -ErrorAction SilentlyContinue
  Start-LoggedProcess `
    -Name "Studio" `
    -FilePath $viteCmd `
    -ArgumentList @("--host", "127.0.0.1", "--port", "5174") `
    -WorkingDirectory $studioDir `
    -StdOut $studioLog `
    -StdErr $studioErr
}

Start-Sleep -Seconds 4

$apiReady = Test-Http "$apiUrl/health"
$studioReady = Test-Http "$studioUrl/"

Write-Host ""
Write-Host "Local preview status"
Write-Host "API:    $(if ($apiReady) { "ready" } else { "not responding" }) $apiUrl"
Write-Host "Studio: $(if ($studioReady) { "ready" } else { "not responding" }) $studioUrl"
Write-Host ""
Write-Host "Logs:"
Write-Host "API stdout:    $apiLog"
Write-Host "API stderr:    $apiErr"
Write-Host "Studio stdout: $studioLog"
Write-Host "Studio stderr: $studioErr"
Write-Host ""

if (-not $apiReady -or -not $studioReady) {
  Write-Host "If something is not responding, open the matching stderr log above first."
  exit 1
}

if ($OpenBrowser) {
  Start-Process $studioUrl
}

Write-Host "Open this URL:"
Write-Host $studioUrl
