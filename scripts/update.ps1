<#
  update.ps1 - deploy the latest pushed code to the laptop server.

  Daily use (from the Mac, after `git push`):
      ssh louis@192.168.50.187
      powershell -ExecutionPolicy Bypass -File C:\apps\speedtest-logger\scripts\update.ps1

  Rolls back to the previous commit if the restart/health-check fails.
  Keep this file ASCII-only (PowerShell 5.1 mis-decodes UTF-8 punctuation).
#>

$AppRoot   = 'C:\apps\speedtest-logger'
$Service   = 'speedtest-logger'
$Port      = 3000
$HealthUrl = "http://127.0.0.1:$Port/health"   # 127.0.0.1 (IPv4) - the server binds 0.0.0.0
$ErrLog    = Join-Path $AppRoot 'logs\err.log'

function Invoke-Step {
    param([string]$Name, [scriptblock]$Action)
    Write-Host "[update] $Name ..." -ForegroundColor Cyan
    & $Action
    if ($LASTEXITCODE -ne 0) { throw "$Name failed (exit $LASTEXITCODE)" }
}

function Stop-App {
    Write-Host '[update] Stopping service ...' -ForegroundColor Cyan
    Stop-Service $Service -Force -ErrorAction SilentlyContinue
    try { (Get-Service $Service).WaitForStatus('Stopped', '00:00:30') } catch { }
    # Make sure the port is actually free - NSSM can lag killing the node child,
    # and a new instance starting too soon hits EADDRINUSE.
    for ($i = 0; $i -lt 15; $i++) {
        if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) { return }
        Start-Sleep -Seconds 1
    }
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($conn) {
        $conn.OwningProcess | Select-Object -Unique | ForEach-Object {
            Write-Host "[update] Port $Port still held by PID $_ - terminating it." -ForegroundColor Yellow
            Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Seconds 2
    }
}

function Start-App {
    Write-Host '[update] Starting service ...' -ForegroundColor Cyan
    Start-Service $Service   # Stop+Start (not Restart) so a throttled NSSM SERVICE_PAUSED clears
}

function Test-FileChanged {
    param([string]$From, [string]$To, [string]$RepoPath)
    if ($From -eq $To) { return $false }
    $changed = git diff --name-only $From $To -- $RepoPath
    return [bool]$changed
}

function Deploy {
    param([string]$From, [string]$To, [switch]$ForceDeps)
    Stop-App
    if ($ForceDeps -or (Test-FileChanged $From $To 'package-lock.json')) {
        Invoke-Step 'npm ci' { npm ci }
    } else {
        Write-Host '[update] deps unchanged - skipping npm ci' -ForegroundColor DarkGray
    }
    # This app is a plain backend (no frontend build) - nothing to build here.
    Start-App
}

function Test-Health {
    for ($i = 1; $i -le 15; $i++) {
        $code = & curl.exe -s -o NUL -w '%{http_code}' $HealthUrl 2>$null
        if ($code -eq '200') { return $true }
        Start-Sleep -Seconds 2
    }
    return $false
}

Set-Location $AppRoot
$prev = (git rev-parse HEAD).Trim()
Write-Host "[update] Current commit: $prev" -ForegroundColor DarkGray

try {
    Invoke-Step 'git pull' { git pull --ff-only }
    $new = (git rev-parse HEAD).Trim()
    if ($new -eq $prev) {
        Write-Host '[update] Already up to date - restarting anyway.' -ForegroundColor Yellow
    } else {
        Write-Host "[update] $prev -> $new" -ForegroundColor Green
    }

    Deploy $prev $new

    if (Test-Health) {
        Write-Host "`n[update] SUCCESS - service healthy at $HealthUrl (now at $new)." -ForegroundColor Green
        exit 0
    }
    throw 'Service did not pass health check after restart'
}
catch {
    Write-Host "`n[update] ERROR: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "[update] Rolling back to $prev ..." -ForegroundColor Yellow
    try {
        Set-Location $AppRoot
        git reset --hard $prev | Out-Null
        Deploy $prev $prev -ForceDeps
        if (Test-Health) {
            Write-Host "[update] ROLLED BACK to $prev - service healthy again." -ForegroundColor Yellow
        } else {
            Write-Host '[update] ROLLBACK restart done but health check STILL failing.' -ForegroundColor Red
            Write-Host "         Inspect: Get-Content '$ErrLog' -Tail 40"
        }
    }
    catch {
        Write-Host "[update] ROLLBACK FAILED: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host "         Manual recovery: cd $AppRoot ; git reset --hard $prev ; npm ci ; Restart-Service $Service"
    }
    if (Test-Path $ErrLog) {
        Write-Host "`n[update] Last 20 lines of err.log:" -ForegroundColor DarkGray
        Get-Content $ErrLog -Tail 20
    }
    exit 1
}
