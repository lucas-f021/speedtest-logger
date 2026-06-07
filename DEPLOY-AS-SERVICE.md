# Deploy this Node app as an always-on service on Lou's home server

> ✅ **DEPLOYED 2026-06-07.** This app is live as the NSSM service `speedtest-logger` on port `3000`,
> reachable on the LAN at `http://192.168.50.187:3000` and `http://frolio-central-server.local:3000`.
> The placeholders below are filled in with this app's real values, and the steps are the exact ones
> used — keep this as the redeploy / maintenance runbook.

> **READ ME FIRST (you are the AI assistant for this app).** Lou already runs another Node app
> ("finance-dashboard") on a home server as a Windows service that auto-starts on boot and restarts
> on crash. He wants *this* app deployed the same way. This document is the proven, working pattern
> from that other app, generalized. Your job: read this app's own code to fill in the
> `<<PLACEHOLDERS>>` below, then walk Lou through the steps. Everything about the **server** is already
> true and fixed — don't re-ask him about it. Only the app-specific blanks need filling.

---

## 1. What you're deploying onto (already set up — don't change it)

| Fact | Value |
|------|-------|
| Server | A **Windows 11 laptop**, always on |
| Hostname | `Frolio-Central-Server` → LAN address `frolio-central-server.local` |
| IP address | `192.168.50.187` (fixed via DHCP reservation) |
| SSH access | `ssh louis@192.168.50.187` (port 22, LAN-only) |
| App install root | `C:\apps\` (each app gets its own folder under here) |
| Runtime | **Node.js 22 LTS** + npm 10 already installed |
| Service manager | **NSSM 2.24** at `C:\nssm\nssm.exe` (this is how apps run as services) |
| Already-running service | `finance-dashboard` on **port 3001** → your app **must use a different port** |

NSSM ("Non-Sucking Service Manager") wraps any `.exe` (here, `node.exe`) as a real Windows service:
it starts on boot with nobody logged in, and restarts the process if it crashes. That is exactly the
"always running, comes back after a reboot" behavior Lou wants.

---

## 2. Fill these in from THIS app's code (do this before talking to Lou)

Inspect this repo and fill the table. Don't guess — read `package.json` and the source.

| Placeholder | Resolved value for this app |
|-------------|------------------------------|
| `APP_NAME` | `speedtest-logger` |
| `ENTRY_POINT` | `server.js` |
| `PORT` | `3000` (the app's default; ≠ 3001) |
| `APP_DIR` | `C:\apps\speedtest-logger` |
| `REPO_URL` | `git@github-speedtest:froliol/speedtest-logger.git` (SSH **alias** for the read-only deploy key — see §4) |
| Frontend build? | **No** — static `public/`, no build step |

**Two things to confirm in the app's code before deploying** — ✅ both are already in place in this app (`process.env.PORT` default + a `/health` route):

1. **Port comes from the environment.** The server should bind like this so the port is configurable:
   ```js
   const PORT = process.env.PORT || 3000;
   app.listen(PORT, '0.0.0.0', () => console.log(`speedtest-logger running on http://127.0.0.1:${PORT}`));
   ```
   Binding `0.0.0.0` (not `localhost`) makes it reachable from other LAN devices.

2. **There's a health endpoint.** A tiny public route makes deploys verifiable. If missing, add:
   ```js
   app.get('/health', (req, res) => res.json({ ok: true }));
   ```
   If the app has auth/middleware, register `/health` **before** the auth gate so it returns `200`, not `401`.

> Plain **HTTP is fine** for this app (no HTTPS/TLS certificate needed) — it's a LAN-only app with no
> OAuth callback requirement. (The finance-dashboard uses HTTPS only because Schwab's API demands it.)

---

## 3. Prerequisites check

SSH onto the server (`ssh louis@192.168.50.187`) and confirm:

```powershell
node -v                 # expect v22.x
git --version           # expect git present
Test-Path C:\nssm\nssm.exe   # expect True
```

If any are missing, stop and tell Lou — the rest assumes these exist.

---

## 4. Step 1 — Get the code onto the server

Clone into `C:\apps\speedtest-logger`:

```powershell
cd C:\apps
git clone git@github-speedtest:froliol/speedtest-logger.git speedtest-logger
cd speedtest-logger
```

> **This app uses a read-only deploy key over a dedicated SSH alias** (`github-speedtest`). Set up once
> on the server, kept here for rebuilds:
> 1. `ssh-keygen -t ed25519 -C "speedtest-logger-deploy" -f "$HOME\.ssh\speedtest_deploy"` (no passphrase).
> 2. Add a `Host github-speedtest` block to `~/.ssh/config` → `HostName github.com`,
>    `IdentityFile ~/.ssh/speedtest_deploy`, `IdentitiesOnly yes`. The alias keeps this key separate from
>    the finance-dashboard's GitHub key.
> 3. Add the **public** key (`speedtest_deploy.pub`) to the repo's **Deploy keys** (read-only).
> 4. Test: `ssh -T git@github-speedtest` → `Hi froliol/speedtest-logger! You've successfully authenticated`.
>
> That's why the clone URL uses `git@github-speedtest:...` rather than `git@github.com:...`.

---

## 5. Step 2 — Configure (.env)

If the app needs secrets or settings, create `C:\apps\speedtest-logger\.env`. At minimum set the port:

```
PORT=3000
```

Rules:
- **Never commit `.env`** — make sure it's in `.gitignore`.
- If it holds secrets, lock it down (SYSTEM + Administrators only):
  ```powershell
  icacls "C:\apps\speedtest-logger\.env" /inheritance:r /grant:r "Administrators:F" "SYSTEM:F"
  ```
- If the app loads `.env` via `dotenv`, note that it reads from the **current working directory** — this
  is why `AppDirectory` in Step 5 is mandatory.

---

## 6. Step 3 — Install dependencies (and build, if needed)

```powershell
cd C:\apps\speedtest-logger
npm ci
```

`npm ci` installs the exact versions from `package-lock.json` (reproducible; better than `npm install`
for a server).

> **No C++ toolchain needed.** `speedtest-net` used to drag in the native `lzma-native`, which has no
> Node 22 prebuilt binary and broke `npm ci` here. The repo now carries a `package.json` `overrides`
> entry that removes it (see CLAUDE.md), so a clean `npm ci` just works. If a previous `npm ci` failed
> partway, clear the partial install first — `cmd /c "rmdir /s /q node_modules"` — then re-run.

**Only if this app has a frontend build** (see the table in §2):

```powershell
npm run build
```

If there's a separate `client/` folder with its own lockfile, run `npm ci` inside it too, then build.
**Skip this whole step entirely if the app is pure backend Node** (no `build` script).

---

## 7. Step 4 — Smoke-test before making it a service

Run it by hand once to be sure it boots and serves:

```powershell
cd C:\apps\speedtest-logger
node server.js
```

In another SSH window (or after confirming the log line), hit the health route:

```powershell
curl.exe http://127.0.0.1:3000/health
```

Expect `{"ok":true}` (or a `200`). Then stop it with **Ctrl-C**. Don't proceed until this works —
debugging is much easier here than once it's wrapped as a service.

> Probe `127.0.0.1`, **not** `localhost`: on Windows `localhost` can resolve to IPv6 `::1`, but the app
> binds IPv4 `0.0.0.0`, so a `localhost` probe may falsely fail.

---

## 8. Step 5 — Install it as an NSSM service (the always-on part)

Create the logs folder first, then register the service. Run these **one line at a time** (long pasted
multi-line commands get chopped over remote-desktop sessions):

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

The lines that deliver Lou's requirement:

- **`Start SERVICE_AUTO_START`** → the service starts automatically on every boot, no login needed.
- **`AppExit Default Restart`** → if the Node process crashes, NSSM relaunches it.
- **`AppDirectory ...`** → sets the working directory so `.env` and any relative paths resolve.
  Without it the service starts but can't find its config. **This is the #1 cause of "it ran by hand
  but the service is broken."**

If `server.js` is nested (e.g. `src/server.js`), pass it exactly as the relative path from
`AppDirectory` — NSSM runs `node.exe` *in* `AppDirectory`.

---

## 9. Step 6 — Open the firewall (LAN-only)

Allow inbound traffic to the port, scoped to the local network only (no internet exposure):

```powershell
New-NetFirewallRule -DisplayName "speedtest-logger (TCP 3000)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000 -Profile Private -RemoteAddress LocalSubnet
```

This mirrors how the dashboard is exposed: `Private` profile + `LocalSubnet`, so it's reachable from
devices on Lou's home network but not from the internet.

---

## 10. Step 7 — Verify it's a real service

```powershell
Get-Service speedtest-logger      # STATUS should be "Running"
```

Then, from **another device on the LAN** (e.g. Lou's Mac), open:

- `http://192.168.50.187:3000`
- `http://frolio-central-server.local:3000`

**The acceptance test for Lou's requirement:** reboot the laptop and confirm the app comes back on its
own with nobody logged in. (The dashboard passes this same test.)

```powershell
Restart-Computer
# after it reboots, from the Mac:
ssh louis@192.168.50.187 "powershell Get-Service speedtest-logger"   # should be Running
```

---

## 11. Managing the service day-to-day

```powershell
Restart-Service speedtest-logger
Stop-Service    speedtest-logger
Start-Service   speedtest-logger
Get-Service     speedtest-logger

# Tail the logs to debug a startup failure:
Get-Content "C:\apps\speedtest-logger\logs\err.log" -Tail 40
Get-Content "C:\apps\speedtest-logger\logs\out.log" -Tail 40
```

> After you change `.env` or pull new code, the running service won't pick it up until you
> **`Restart-Service speedtest-logger`**.

---

## 12. Updating after code changes

The safe redeploy loop (the dashboard automates this in `scripts/update.ps1` — consider generating an
equivalent for this app):

```powershell
cd C:\apps\speedtest-logger
$prev = git rev-parse HEAD          # remember current commit for rollback
git pull --ff-only
Stop-Service speedtest-logger           # release the file/port locks
npm ci                              # only needed if package-lock.json changed in the pull
# npm run build                     # only if this app has a frontend build
Start-Service speedtest-logger
curl.exe http://127.0.0.1:3000/health   # confirm it came back

# If the health check fails, roll back:
# Stop-Service speedtest-logger; git reset --hard $prev; npm ci; Start-Service speedtest-logger
```

Stop the service **before** `npm ci`/build so npm can replace any locked native binaries and the new
instance can bind the port cleanly.

---

## 13. Gotchas (learned the hard way on this exact server)

- **Pick a port that isn't 3001** (that's the dashboard) — and not any other port already in use.
- **Probe `127.0.0.1`, never `localhost`** — the server binds IPv4 `0.0.0.0`; `localhost` may resolve to IPv6.
- **`AppDirectory` is mandatory** if the app uses `dotenv` or relative paths (see §8).
- **Restart after restarting the port too fast:** `Stop-Service` returns before NSSM fully kills the Node
  child. If a quick restart hits `EADDRINUSE`, wait a couple seconds (or until the port is free) and
  `Start-Service` again. If NSSM shows `SERVICE_PAUSED` (crash-throttle), `Stop-Service` then `Start-Service`.
- **Keep any PowerShell scripts ASCII-only** — Windows PowerShell 5.1 mis-decodes UTF-8/emoji and can fail.
- **Never commit `.env`**; restrict it with `icacls` if it holds secrets (§5).
- **Run NSSM commands one line at a time** over remote desktop — long pastes get truncated.
- **`speedtest-net` + Node 22 = the `lzma-native` trap.** It eagerly requires `decompress-tarxz` → native
  `lzma-native@4`, which has no Node 22 prebuilt binary and won't compile without VS C++ build tools.
  Fixed in-repo via a `package.json` `overrides` redirecting `decompress-tarxz` → pure-JS
  `decompress-targz` (the `.xz` path is never used: Windows downloads `.zip`, mac/Linux `.tgz`).
- **A failed `npm ci` can leave an undeletable `node_modules`** (EPERM on `tar-fs` test fixtures). Clear
  it with `cmd /c "rmdir /s /q node_modules"` before retrying.

---

## 14. Quick checklist

- [ ] Filled in `speedtest-logger`, `server.js`, `3000` (≠ 3001), `git@github-speedtest:froliol/speedtest-logger.git` from this repo
- [ ] App reads `PORT` from env and has a `/health` route
- [ ] `git clone` into `C:\apps\speedtest-logger`
- [ ] `.env` created if needed (and gitignored)
- [ ] `npm ci` (+ `npm run build` only if there's a frontend)
- [ ] Smoke test: `node server.js` → `curl http://127.0.0.1:3000/health` → Ctrl-C
- [ ] `mkdir logs`, then NSSM install with `AppDirectory`, `SERVICE_AUTO_START`, `AppExit ... Restart`
- [ ] Firewall rule (Private + LocalSubnet) for the port
- [ ] `Get-Service` shows Running; reachable from the Mac
- [ ] **Reboot test passed** — service came back on its own
