# Deploy this Node app as an always-on service on Lou's home server

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

| Placeholder | How to find it | Value for this app |
|-------------|----------------|--------------------|
| `<<APP_NAME>>` | A short kebab-case name (also the service name + folder name) | `__________` |
| `<<ENTRY_POINT>>` | The file Node runs. Check `package.json` `"main"` or the file behind `npm start` (e.g. `server.js`, `index.js`, `src/server.js`) | `__________` |
| `<<PORT>>` | Any free LAN port **other than 3001**. The app should read `process.env.PORT` with this as the default | `__________` |
| `<<APP_DIR>>` | Always `C:\apps\<<APP_NAME>>` | `C:\apps\__________` |
| `<<REPO_URL>>` | The GitHub SSH URL, e.g. `git@github.com:froliol/<<APP_NAME>>.git` | `__________` |
| Has a frontend build? | Is there a `build` script (Vite/webpack/etc.) producing a `dist/` the server serves? | yes / no |

**Two things to confirm in the app's code before deploying:**

1. **Port comes from the environment.** The server should bind like this so the port is configurable:
   ```js
   const PORT = process.env.PORT || <<PORT>>;
   app.listen(PORT, '0.0.0.0', () => console.log(`<<APP_NAME>> running on http://127.0.0.1:${PORT}`));
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

Clone into `C:\apps\<<APP_NAME>>`:

```powershell
cd C:\apps
git clone <<REPO_URL>> <<APP_NAME>>
cd <<APP_NAME>>
```

> **Use the SSH form of the repo URL (`git@github.com:...`).** Over an SSH session the HTTPS Git
> credential helper can't authenticate, so the dashboard uses a read-only **deploy key**. If `git clone`
> prompts for a password or fails to auth, the fix is to add this app's deploy key to GitHub
> (Repo → Settings → Deploy keys) and use the SSH URL — ask Lou and help him set it up.

---

## 5. Step 2 — Configure (.env)

If the app needs secrets or settings, create `C:\apps\<<APP_NAME>>\.env`. At minimum set the port:

```
PORT=<<PORT>>
```

Rules:
- **Never commit `.env`** — make sure it's in `.gitignore`.
- If it holds secrets, lock it down (SYSTEM + Administrators only):
  ```powershell
  icacls "C:\apps\<<APP_NAME>>\.env" /inheritance:r /grant:r "Administrators:F" "SYSTEM:F"
  ```
- If the app loads `.env` via `dotenv`, note that it reads from the **current working directory** — this
  is why `AppDirectory` in Step 5 is mandatory.

---

## 6. Step 3 — Install dependencies (and build, if needed)

```powershell
cd C:\apps\<<APP_NAME>>
npm ci
```

`npm ci` installs the exact versions from `package-lock.json` (reproducible; better than `npm install`
for a server).

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
cd C:\apps\<<APP_NAME>>
node <<ENTRY_POINT>>
```

In another SSH window (or after confirming the log line), hit the health route:

```powershell
curl.exe http://127.0.0.1:<<PORT>>/health
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
mkdir C:\apps\<<APP_NAME>>\logs

cd C:\nssm
.\nssm.exe install <<APP_NAME>> "C:\Program Files\nodejs\node.exe" "<<ENTRY_POINT>>"
.\nssm.exe set <<APP_NAME>> AppDirectory "C:\apps\<<APP_NAME>>"
.\nssm.exe set <<APP_NAME>> AppStdout "C:\apps\<<APP_NAME>>\logs\out.log"
.\nssm.exe set <<APP_NAME>> AppStderr "C:\apps\<<APP_NAME>>\logs\err.log"
.\nssm.exe set <<APP_NAME>> Start SERVICE_AUTO_START
.\nssm.exe set <<APP_NAME>> AppExit Default Restart
.\nssm.exe start <<APP_NAME>>
```

The lines that deliver Lou's requirement:

- **`Start SERVICE_AUTO_START`** → the service starts automatically on every boot, no login needed.
- **`AppExit Default Restart`** → if the Node process crashes, NSSM relaunches it.
- **`AppDirectory ...`** → sets the working directory so `.env` and any relative paths resolve.
  Without it the service starts but can't find its config. **This is the #1 cause of "it ran by hand
  but the service is broken."**

If `<<ENTRY_POINT>>` is nested (e.g. `src/server.js`), pass it exactly as the relative path from
`AppDirectory` — NSSM runs `node.exe` *in* `AppDirectory`.

---

## 9. Step 6 — Open the firewall (LAN-only)

Allow inbound traffic to the port, scoped to the local network only (no internet exposure):

```powershell
New-NetFirewallRule -DisplayName "<<APP_NAME>> (TCP <<PORT>>)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort <<PORT>> -Profile Private -RemoteAddress LocalSubnet
```

This mirrors how the dashboard is exposed: `Private` profile + `LocalSubnet`, so it's reachable from
devices on Lou's home network but not from the internet.

---

## 10. Step 7 — Verify it's a real service

```powershell
Get-Service <<APP_NAME>>      # STATUS should be "Running"
```

Then, from **another device on the LAN** (e.g. Lou's Mac), open:

- `http://192.168.50.187:<<PORT>>`
- `http://frolio-central-server.local:<<PORT>>`

**The acceptance test for Lou's requirement:** reboot the laptop and confirm the app comes back on its
own with nobody logged in. (The dashboard passes this same test.)

```powershell
Restart-Computer
# after it reboots, from the Mac:
ssh louis@192.168.50.187 "powershell Get-Service <<APP_NAME>>"   # should be Running
```

---

## 11. Managing the service day-to-day

```powershell
Restart-Service <<APP_NAME>>
Stop-Service    <<APP_NAME>>
Start-Service   <<APP_NAME>>
Get-Service     <<APP_NAME>>

# Tail the logs to debug a startup failure:
Get-Content "C:\apps\<<APP_NAME>>\logs\err.log" -Tail 40
Get-Content "C:\apps\<<APP_NAME>>\logs\out.log" -Tail 40
```

> After you change `.env` or pull new code, the running service won't pick it up until you
> **`Restart-Service <<APP_NAME>>`**.

---

## 12. Updating after code changes

The safe redeploy loop (the dashboard automates this in `scripts/update.ps1` — consider generating an
equivalent for this app):

```powershell
cd C:\apps\<<APP_NAME>>
$prev = git rev-parse HEAD          # remember current commit for rollback
git pull --ff-only
Stop-Service <<APP_NAME>>           # release the file/port locks
npm ci                              # only needed if package-lock.json changed in the pull
# npm run build                     # only if this app has a frontend build
Start-Service <<APP_NAME>>
curl.exe http://127.0.0.1:<<PORT>>/health   # confirm it came back

# If the health check fails, roll back:
# Stop-Service <<APP_NAME>>; git reset --hard $prev; npm ci; Start-Service <<APP_NAME>>
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

---

## 14. Quick checklist

- [ ] Filled in `<<APP_NAME>>`, `<<ENTRY_POINT>>`, `<<PORT>>` (≠ 3001), `<<REPO_URL>>` from this repo
- [ ] App reads `PORT` from env and has a `/health` route
- [ ] `git clone` into `C:\apps\<<APP_NAME>>`
- [ ] `.env` created if needed (and gitignored)
- [ ] `npm ci` (+ `npm run build` only if there's a frontend)
- [ ] Smoke test: `node <<ENTRY_POINT>>` → `curl http://127.0.0.1:<<PORT>>/health` → Ctrl-C
- [ ] `mkdir logs`, then NSSM install with `AppDirectory`, `SERVICE_AUTO_START`, `AppExit ... Restart`
- [ ] Firewall rule (Private + LocalSubnet) for the port
- [ ] `Get-Service` shows Running; reachable from the Mac
- [ ] **Reboot test passed** — service came back on its own
