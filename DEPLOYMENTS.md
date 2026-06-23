# Deployment Log — speedtest-logger

Tracks what's **live in production** (Lou's home-server NSSM service `speedtest-logger`,
`http://192.168.50.187:3000`) versus the **latest pushed code**, so dev↔prod sync is always
visible at a glance. Deploy runbook: [SPEEDTEST-DEPLOY.md](SPEEDTEST-DEPLOY.md).

## Sync rule
- Production is deployed **manually by Lou** (`scripts\deploy.bat` / `update.ps1` on the server).
- **Claude asks Lou to confirm** after every code push; a version is only marked deployed here
  once Lou confirms it. His word is authoritative — Claude never assumes prod's state either way.
- Docs-only pushes don't change prod behavior, so they don't need a deploy/confirmation.

## Current state
| | Version | Commit |
|---|---|---|
| **Dev** (`origin/main`) | v0.6.0 | latest on `main` |
| **Prod** (home server) | v0.6.0 | ✅ **in sync** — confirmed by Lou 2026-06-23 |

## History
| Date | Version | Event | Notes |
|------|---------|-------|-------|
| 2026-06-23 | v0.6.0 | ✅ Deployed to prod | Brought prod current with the whole session's work: full Ookla telemetry capture (v0.3.0), month-report Trends redesign (v0.4.0–v0.5.0), the `NoServersException` fix, and the switch to Ookla auto-pick (v0.6.0). Jumped prod up from its pre-v0.3.0 version. |
| 2026-06-07 | initial | ✅ First prod stand-up | NSSM service registered on the home server per SPEEDTEST-DEPLOY.md; ran a pre-v0.3.0 build until 2026-06-23. |
