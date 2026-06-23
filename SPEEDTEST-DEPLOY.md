# Deploy the Speedtest app to Lou's home server (as an always-on service)

> 📒 **What's live vs. pushed:** see [DEPLOYMENTS.md](DEPLOYMENTS.md) — the dev↔prod sync ledger.

> ✅ **ALREADY DEPLOYED (2026-06-07).** Live as the NSSM service `speedtest-logger` on port `3000`
> (`http://192.168.50.187:3000`, also `http://frolio-central-server.local:3000`). The first-time setup
> in §3 is done; the new piece is the one-click `scripts/deploy.bat` / `scripts/update.ps1` (committed
> in this repo, filled in for this app with no build step). Day-to-day deploys: §5.

> **READ ME FIRST (you are the AI assistant for the Speedtest app).** Lou runs another Node app
> ("finance-dashboard") on a home server as an NSSM Windows service with a one-click `deploy.bat`.
> He wants *this* Speedtest app deployed the same way. This file is that proven pattern, adapted for
> a simple Node app (plain HTTP, no frontend build assumed). Your job: read this repo to fill the
> `<<PLACEHOLDERS>>`, drop in the two scripts below, register the NSSM service once, and from then on
> deploys are a double-click of `deploy.bat` (or one SSH command). Everything about the **server** is
> already true — don't re-ask Lou about it.

---

## 1. The server you're deploying onto (already set up)

| Fact | Value |
|------|-------|
| Machine | Windows 11 laptop, always on |
| Hostname | `Frolio-Central-Server` → LAN address `frolio-central-server.local` |
| IP | `192.168.50.187` (fixed) |
| SSH | `ssh louis@192.168.50.187` (LAN-only) |
| App install root | `C:\apps\` (each app gets its own folder) |
| Runtime | **Node.js 22 LTS** + npm 10 already installed |
| Service manager | **NSSM 2.24** at `C:\nssm\nssm.exe` |
| Port already taken | `3001` (the finance dashboard) → **pick a different port** for Speedtest |
| Git remote auth over SSH | uses a **read-only deploy key** (HTTPS credential helper can't auth in an SSH session) |

NSSM wraps `node.exe` as a real Windows service: it auto-starts on boot (nobody logged in) and restarts
on crash — that's the "always running, comes back after a reboot" behavior.

---

## 2. Fill these in from THIS repo (do before talking to Lou)

| Placeholder | Value for this app |
|-------------|--------------------|
| `APP_NAME` | `speedtest-logger` (the live service + folder name — **not** `speedtest`) |
| `ENTRY_POINT` | `server.js` |
| `PORT` | `3000` |
| `REPO_URL` | `git@github-speedtest:froliol/speedtest-logger.git` (SSH alias for the read-only deploy key) |
| Frontend build? | **No** — static `public/`, no build step (the `npm run build` line is removed from the scripts) |

**Two things to confirm in this app's code first:**

1. **Port from env + bind all interfaces** so it's reachable on the LAN but probeable on IPv4:
   ```js
   const PORT = process.env.PORT || 3000;
   app.listen(PORT, '0.0.0.0', () => console.log(`speedtest running on http://127.0.0.1:${PORT}`));
   ```
2. **A health endpoint** the deploy script can check (add it if missing — put it *before* any auth):
   ```js
   app.get('/health', (req, res) => res.json({ ok: true }));
   ```

> Plain **HTTP** is fine for this app (no TLS/cert) — it's a LAN-only tool with no OAuth callback.

---

## 3. First-time setup (once)

SSH in (`ssh louis@192.168.50.187`) and confirm the basics:
```powershell
node -v                      # expect v22.x
git --version                # present
Test-Path C:\nssm\nssm.exe   # True
```

**Clone the code** into `C:\apps\speedtest-logger` (SSH URL — see the deploy-key note in §1):
```powershell
cd C:\apps
git clone git@github-speedtest:froliol/speedtest-logger.git speedtest-logger
cd speedtest-logger
```

**Config + deps:**
```powershell
# Optional: only if the app needs env vars. Never commit .env (gitignore it).
# Set the port and anything else the app reads:
#   PORT=3000
npm ci
# npm run build      # ONLY if this app has a frontend build (skip for a plain backend)
```

**Smoke-test before making it a service:**
```powershell
node server.js
# in another window:  curl.exe http://127.0.0.1:3000/health   -> {"ok":true}
# then Ctrl-C
```
(Probe `127.0.0.1`, not `localhost` — the app binds IPv4 `0.0.0.0`.)

**Register the NSSM service** (run one line at a time; long pastes get chopped over remote desktop):
```powershell
mkdir C:\apps\speedtest-logger\logs

cd C:\nssm
.\nssm.exe install speedtest-logger "C:\Program Files\nodejs\node.exe" "server.js"
.\nssm.exe set speedtest-logger AppDirectory "C:\apps\speedtest-logger"
.\nssm.exe set speedtest-logger AppStdout "C:\apps\speedtest-logger\logs\out.log"
.\nssm.exe set speedtest-logger AppStderr "C:\apps\speedtest-logger\logs\err.log"
.\nssm.exe set speedtest-logger Start SERVICE_AUTO_START
.\nssm.exe set speedtest-logger AppExit Default Restart
.\nssm.exe start speedtest-logger
```
The three lines that deliver "always-on, survives reboot": **`Start SERVICE_AUTO_START`** (boot),
**`AppExit Default Restart`** (crash recovery), **`AppDirectory`** (so `.env`/relative paths resolve —
the #1 cause of "ran by hand but the service is broken").

**Open the firewall, LAN-only:**
```powershell
New-NetFirewallRule -DisplayName "speedtest-logger (TCP 3000)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000 -Profile Private -RemoteAddress LocalSubnet
```

**Verify it's a real service:** `Get-Service speedtest-logger` shows **Running**; reach it from another LAN
device at `http://192.168.50.187:3000` and `http://frolio-central-server.local:3000`; then
**reboot the laptop and confirm it comes back on its own** (the acceptance test).

---

## 4. The deploy scripts (the `deploy.bat` approach)

After first-time setup, every future deploy is **rollback-safe and one click**. These two files are
**committed** at `scripts/update.ps1` and `scripts/deploy.bat` (already filled in for this app, build
step removed). On the server they live at `C:\apps\speedtest-logger\scripts\` after a pull. The listings
below match the committed files.

### `scripts/update.ps1`
A rollback-safe deploy: record commit -> `git pull --ff-only` -> stop service -> `npm ci` only if a
lockfile changed -> (optional) build -> start -> health-check. If anything fails it resets to the
previous commit, reinstalls, and restarts, so a bad push can't leave the server down.

**Edit only the four `$...` lines at the top.** Keep the file **ASCII-only** (no em-dashes / curly
quotes) — PowerShell 5.1 mis-decodes UTF-8 and won't parse it. If this app has **no build step**,
delete the one `npm run build` line noted below.

```powershell
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
```

### `scripts/deploy.bat`
The double-clickable one-click wrapper. It calls `update.ps1`, keeps the console window open so you can
read the success/rollback result, and exits with the script's code.

```bat
@echo off
REM ---------------------------------------------------------------------------
REM deploy.bat - one-click deploy of the latest pushed code to this server.
REM
REM Wraps scripts\update.ps1 (git pull -> stop -> npm ci if a lockfile changed
REM -> build -> start -> health-check; auto-rolls back on any failure).
REM
REM Usage: double-click this file on the server (it lives next to update.ps1).
REM Note: if you ever run it over SSH instead, call update.ps1 directly -
REM       the PAUSE below would hang a non-interactive session.
REM ---------------------------------------------------------------------------
title speedtest-logger deploy
powershell -ExecutionPolicy Bypass -File "%~dp0update.ps1"
set "RC=%ERRORLEVEL%"
echo.
echo [deploy] update.ps1 exited with code %RC% (0 = success, 1 = failed/rolled back).
pause
exit /b %RC%
```

---

## 5. Day-to-day: how you deploy after the first time

You commit + push from the Mac as usual, then **either**:

- **One click on the server:** double-click `C:\apps\speedtest-logger\scripts\deploy.bat`.
- **From the Mac over SSH** (call `update.ps1` directly — never `deploy.bat`, its `pause` hangs a
  non-interactive session):
  ```bash
  ssh louis@192.168.50.187
  powershell -ExecutionPolicy Bypass -File C:\apps\speedtest-logger\scripts\update.ps1
  ```

> The scripts live in the repo they deploy, so a change to `update.ps1` itself takes effect on the
> **next** run, not the current one.

**Manual service control** (rarely needed):
```powershell
Restart-Service speedtest-logger
Stop-Service    speedtest-logger
Start-Service   speedtest-logger
Get-Service     speedtest-logger
Get-Content "C:\apps\speedtest-logger\logs\err.log" -Tail 40   # debug a startup failure
```

---

## 6. Gotchas (learned on this exact server)

- **Pick a port that isn't 3001** (the finance dashboard) or any other in use.
- **Probe `127.0.0.1`, never `localhost`** — the app binds IPv4; `localhost` may resolve to IPv6.
- **`AppDirectory` is mandatory** if the app uses `.env`/relative paths.
- **Stop before `npm`** — the script stops the service first so files/port are free; it waits for the
  port to actually free before restarting (avoids `EADDRINUSE`).
- **Keep `update.ps1` ASCII-only** — PowerShell 5.1 mis-decodes UTF-8 punctuation and won't parse.
- **Run `nssm install` / firewall lines one at a time** over remote desktop; long pastes get truncated.
- **SSH git auth** uses a read-only **deploy key** (GitHub repo -> Settings -> Deploy keys) because the
  HTTPS credential helper can't authenticate in an SSH session. Use the `git@github.com:...` URL.
- **Don't commit `.env`.**
- **`speedtest-net` pulls a native `lzma-native` that won't build on Node 22.** Fixed in-repo via a
  `package.json` `overrides` (redirects `decompress-tarxz` -> pure-JS `decompress-targz`), so a clean
  `npm ci` works with no C++ toolchain. After a failed `npm ci`, clear a partial install with
  `cmd /c "rmdir /s /q node_modules"` before retrying.
- **The deploy key uses a dedicated SSH alias.** Clone/pull with `git@github-speedtest:...`; a
  `Host github-speedtest` block in `~/.ssh/config` maps it to GitHub with
  `IdentityFile ~/.ssh/speedtest_deploy`, keeping this key separate from the finance-dashboard's.

---

## 7. First-deploy checklist

- [ ] Filled `speedtest-logger`, `server.js`, `3000` (≠ 3001), `git@github-speedtest:froliol/speedtest-logger.git`
- [ ] App reads `PORT` from env, binds `0.0.0.0`, has a `/health` route
- [ ] Added `scripts/update.ps1` + `scripts/deploy.bat` (placeholders replaced; build line kept/removed)
- [ ] `git clone` into `C:\apps\speedtest-logger`, `.env` if needed, `npm ci` (+ build if any)
- [ ] Smoke test: `node server.js` -> `curl http://127.0.0.1:3000/health` -> Ctrl-C
- [ ] `mkdir logs`, NSSM install with `AppDirectory` + `SERVICE_AUTO_START` + `AppExit ... Restart`
- [ ] Firewall rule (Private + LocalSubnet) for the port
- [ ] `Get-Service` shows Running; reachable from the Mac
- [ ] **Reboot test passed** — service came back on its own
- [ ] Test a deploy: push a trivial change, double-click `deploy.bat`, confirm it pulls + health-checks green
```
