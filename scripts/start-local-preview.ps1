param(
  [switch]$OpenBrowser
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$apiUrl = "http://127.0.0.1:5175"
$viewerUrl = "http://127.0.0.1:5173"
$studioUrl = "http://127.0.0.1:5174"
$logDir = Join-Path $repoRoot ".dev-logs"
$apiLog = Join-Path $logDir "api.log"
$apiErr = Join-Path $logDir "api.err.log"
$viewerLog = Join-Path $logDir "viewer.log"
$viewerErr = Join-Path $logDir "viewer.err.log"
$studioLog = Join-Path $logDir "studio.log"
$studioErr = Join-Path $logDir "studio.err.log"
$viewerDir = Join-Path $repoRoot "apps/viewer-demo"
$studioDir = Join-Path $repoRoot "apps/studio"
$apiScript = Join-Path $repoRoot "apps/api/src/server.mjs"
$viewerViteCmd = Join-Path $viewerDir "node_modules/.bin/vite.CMD"
$studioViteCmd = Join-Path $studioDir "node_modules/.bin/vite.CMD"

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

if (-not (Test-Path $viewerViteCmd)) {
  throw "Viewer Vite launcher not found: $viewerViteCmd. Run pnpm install first."
}

if (-not (Test-Path $studioViteCmd)) {
  throw "Studio Vite launcher not found: $studioViteCmd. Run pnpm install first."
}

if (Test-Http "$apiUrl/health") {
  Write-Host "API already running at $apiUrl"
} else {
  Clear-Content $apiLog -ErrorAction SilentlyContinue
  Clear-Content $apiErr -ErrorAction SilentlyContinue
  Start-LoggedProcess `
    -Name "API" `
    -FilePath "node.exe" `
    -ArgumentList @("`"$apiScript`"") `
    -WorkingDirectory $repoRoot `
    -StdOut $apiLog `
    -StdErr $apiErr
}

if (Test-Http "$viewerUrl/") {
  Write-Host "Viewer already running at $viewerUrl"
} else {
  Clear-Content $viewerLog -ErrorAction SilentlyContinue
  Clear-Content $viewerErr -ErrorAction SilentlyContinue
  Start-LoggedProcess `
    -Name "Viewer" `
    -FilePath $viewerViteCmd `
    -ArgumentList @("--host", "127.0.0.1", "--port", "5173") `
    -WorkingDirectory $viewerDir `
    -StdOut $viewerLog `
    -StdErr $viewerErr
}

if (Test-Http "$studioUrl/") {
  Write-Host "Studio already running at $studioUrl"
} else {
  Clear-Content $studioLog -ErrorAction SilentlyContinue
  Clear-Content $studioErr -ErrorAction SilentlyContinue
  Start-LoggedProcess `
    -Name "Studio" `
    -FilePath $studioViteCmd `
    -ArgumentList @("--host", "127.0.0.1", "--port", "5174") `
    -WorkingDirectory $studioDir `
    -StdOut $studioLog `
    -StdErr $studioErr
}

Start-Sleep -Seconds 4

$apiReady = Test-Http "$apiUrl/health"
$viewerReady = Test-Http "$viewerUrl/"
$studioReady = Test-Http "$studioUrl/"

Write-Host ""
Write-Host "Local preview status"
Write-Host "API:    $(if ($apiReady) { "ready" } else { "not responding" }) $apiUrl"
Write-Host "Viewer: $(if ($viewerReady) { "ready" } else { "not responding" }) $viewerUrl"
Write-Host "Studio: $(if ($studioReady) { "ready" } else { "not responding" }) $studioUrl"
Write-Host ""
Write-Host "Logs:"
Write-Host "API stdout:    $apiLog"
Write-Host "API stderr:    $apiErr"
Write-Host "Viewer stdout: $viewerLog"
Write-Host "Viewer stderr: $viewerErr"
Write-Host "Studio stdout: $studioLog"
Write-Host "Studio stderr: $studioErr"
Write-Host ""

if (-not $apiReady -or -not $viewerReady -or -not $studioReady) {
  Write-Host "If something is not responding, open the matching stderr log above first."
  exit 1
}

if ($OpenBrowser) {
  Start-Process $studioUrl
}

Write-Host "Open this URL:"
Write-Host $studioUrl
