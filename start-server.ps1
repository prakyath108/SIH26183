# Hosts CryptoTrace locally on http://localhost:8080
#
# The API process serves both /api and the built SPA from web/dist, so there is
# one port to open and no Vite proxy in the loop. Build first with `npm run build`.
#
# Config comes from .env (PORT, HOST, CORS_ORIGIN, JWT_SECRET, ...). This script
# sets only NODE_ENV=production, because production mode is what makes the API
# serve web/dist and apply the strict JWT checks; .env keeps development mode so
# `npm run dev` and the db:* scripts still work.
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

$build = Join-Path $root "web\dist"
if (-not (Test-Path $build)) {
  Write-Host "web/dist not found. Run 'npm run build' first." -ForegroundColor Yellow
  exit 1
}

# Read PORT and HOST from .env so the health check targets the real host.
$envFile = Join-Path $root ".env"
$port = 8080
$host_ = "127.0.0.1"
if (Test-Path $envFile) {
  foreach ($line in Get-Content $envFile) {
    if ($line -match '^\s*PORT\s*=\s*(\d+)') { $port = [int]$Matches[1] }
    if ($line -match '^\s*HOST\s*=\s*(\S+)') { $host_ = $Matches[1].Trim() }
  }
}

# Any previous host still holding the port would make the health check pass
# against stale code, so stop it first.
Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1

$env:NODE_ENV = "production"
Start-Process npm.cmd `
  -ArgumentList "run", "start" `
  -WorkingDirectory $root `
  -RedirectStandardOutput "$env:TEMP\cryptotrace-host.log" `
  -RedirectStandardError "$env:TEMP\cryptotrace-host.err" `
  -WindowStyle Hidden

$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 700
  try {
    $health = Invoke-RestMethod "http://localhost:$port/api/health" -TimeoutSec 3
    if ($health.status -eq "ok") {
      $reach = if ($host_ -eq "0.0.0.0" -or $host_ -eq "::") { "local network" } else { "this machine only" }
      Write-Host "CryptoTrace is live at http://localhost:$port  (bound to $host_, $reach)" -ForegroundColor Green
      exit 0
    }
  } catch {
    # Not up yet; keep waiting.
  }
}

Write-Host "Host did not become healthy in 30s. Check logs:" -ForegroundColor Red
Write-Host "  $env:TEMP\cryptotrace-host.log"
Write-Host "  $env:TEMP\cryptotrace-host.err"
exit 1
