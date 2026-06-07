# Architecture

Self-hosted internet speed-test logger: a small Node service that runs an Ookla speed test on a
schedule, stores results in SQLite, and serves a single-page dashboard. No build step, no external
services — everything runs in one process on a LAN.

```
                         ┌──────────────────────── Node process (server.js) ────────────────────────┐
  browser (LAN)          │                                                                           │
  ┌───────────┐  HTTP    │   Express ──► API routes ─┬─► db.js (better-sqlite3) ──► speedtest.db     │
  │ public/   │ ───────► │     │                     │                                               │
  │ index/app │ ◄─────── │     └─ static public/     ├─► speedtest.js ─► speedtest-net ─► Ookla CLI   │
  └───────────┘  JSON    │                           │                     (downloads/runs binary)   │
                         │   node-cron (re-schedulable) ─► runScheduledTest ─► executeTest ──────────┤
                         │                           └─► servers.js (pick server) / schedules.js      │
                         └───────────────────────────────────────────────────────────────────────────┘
```

## Tech stack

### Runtime & frameworks
| Piece | Choice | Notes |
|---|---|---|
| Runtime | **Node.js** (≥18; runs on Node 22 in prod) | single process |
| HTTP server | **Express** `^4.18` | API + static file serving |
| Database | **SQLite** via **better-sqlite3** `^11` | synchronous, single-connection, zero-config file |
| Speed-test engine | **speedtest-net** `^2.2` | wraps the **official Ookla Speedtest CLI** (same engine as speedtest.net) |
| Scheduler | **node-cron** `^3` | hourly by default; cadence is user-configurable + applied live |

### Frontend (no build, no bundler)
| Piece | Choice | Loaded via |
|---|---|---|
| UI | Plain **HTML + CSS + vanilla JS** | served from `public/` |
| Charting | **Chart.js** + **chartjs-adapter-date-fns** | CDN (`jsdelivr`) in `index.html` |

### Dev / build-time
| Piece | Choice | Why |
|---|---|---|
| Patch tooling | **patch-package** `^8` | `postinstall` applies `patches/speedtest-net+2.2.0.patch` (adds darwin-arm64 binary support for local dev on Apple Silicon) |
| Native-dep override | `package.json` **`overrides`** | redirects `decompress-tarxz` → pure-JS `decompress-targz`, dropping the native `lzma-native` (no Node 22 prebuilt, won't compile without a C++ toolchain). The `.xz` path is never used (Ookla ships `.zip` on Windows, `.tgz` on mac/Linux). |

There is **no runtime auth, no TLS, no message queue, no ORM** — by design, it's a LAN-only tool.

## Project structure
```
speedtest-logger/
├── server.js        # Express app, all API routes, the re-schedulable node-cron job, graceful shutdown
├── db.js            # better-sqlite3 setup + schema; query/stat/analytics helpers; key-value settings store
├── speedtest.js     # wraps speedtest-net; normalizes the result; converts bytes/sec → Mbps
├── servers.js       # registry of 3 vetted Ookla servers + a "Fastest" TCP-latency picker
├── schedules.js     # registry of cron presets (30m / 1h / 2h / 6h / 12h / daily)
├── public/
│   ├── index.html   # layout: left sidebar (server / analytics / schedule / version) + main (stats, chart, table)
│   ├── style.css    # dark theme, fixed-viewport dashboard
│   └── app.js       # all frontend logic: fetch + render chart/table/analytics, selectors, toasts
├── patches/         # patch-package patch (speedtest-net arm64)
├── scripts/         # update.ps1 (rollback-safe deploy) + deploy.bat (one-click wrapper)
├── package.json     # deps + the decompress-tarxz override; version is the app version (v0.1.0)
└── speedtest.db     # SQLite file, created on first run (gitignored)
```

## Data flow (one scheduled test)
1. **node-cron** fires `runScheduledTest()` on the configured cadence (or once on startup if the last test
   was >1h ago). A `testRunning` mutex prevents concurrent tests.
2. `executeTest()` calls `resolveTargetServer()` — reads `selected_server` from the `settings` table; for
   `"fastest"` it TCP-latency-probes the three servers (`servers.js`) and picks the lowest.
3. `runSpeedTest(serverId)` (`speedtest.js`) invokes **speedtest-net**, which runs the **Ookla CLI**
   (downloading the binary on first use), and returns a normalized row (Mbps converted from bytes/sec).
4. The row is written to `speed_logs` via `insertLog()`. Failures are caught and logged — the server never
   crashes on a bad test.
5. The browser fetches the new data on its next refresh (after `Test Now`, range change, or page load).

## HTTP API
- `GET /health` → `{ ok: true }` (deploy smoke-test)
- `GET /api/logs?range&limit&offset` · `GET /api/logs/latest`
- `POST /api/test` (on-demand; `409` if one is already running)
- `GET /api/stats?range` (avg/min/max for a range)
- `GET /api/analytics` (avg / median / **stdev** of download/upload/ping over rolling 24h / 7d / 30d)
- `GET /api/status` (running flag, next scheduled test, db size) · `GET /api/version`
- `GET|POST /api/server` (server selector) · `GET|POST /api/schedule` (cron cadence)

## Data model (`speedtest.db`)
- **`speed_logs`** — `id, timestamp (UTC), download, upload, ping, jitter, server_name, server_location,
  isp, result_url, source ('scheduled' | 'manual')`; index on `timestamp`.
- **`settings`** — `key, value` key-value store (`selected_server`, `schedule`).

## Deployment
Runs on a Windows 11 home server as an **NSSM service** (`speedtest-logger`, port 3000, auto-start +
restart-on-crash), LAN-only firewall rule. Code is pulled from a private GitHub repo via a read-only
**deploy key** (SSH alias `github-speedtest`). Deploys are one-click and rollback-safe via
`scripts/update.ps1` / `scripts/deploy.bat`. Full runbook: `SPEEDTEST-DEPLOY.md`.
