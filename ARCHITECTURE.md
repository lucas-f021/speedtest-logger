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
                         │                           └─► schedules.js (cron cadence)                  │
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
| Charting (dashboard) | **Chart.js** + **chartjs-adapter-date-fns** | CDN (`jsdelivr`) in `index.html` |
| Charting (Trends) | none — dependency-free **inline SVG** dot strips | rendered by `trends.js` |

### Dev / build-time
| Piece | Choice | Why |
|---|---|---|
| Patch tooling | **patch-package** `^8` | `postinstall` applies `patches/speedtest-net+2.2.0.patch` (adds darwin-arm64 binary support for local dev on Apple Silicon) |
| Native-dep override | `package.json` **`overrides`** | redirects `decompress-tarxz` → pure-JS `decompress-targz`, dropping the native `lzma-native` (no Node 22 prebuilt, won't compile without a C++ toolchain). The `.xz` path is never used (Ookla ships `.zip` on Windows, `.tgz` on mac/Linux). |

There is **no runtime auth, no TLS, no message queue, no ORM** — by design, it's a LAN-only tool.

## Project structure
```
speedtest-logger/
├── server.js        # Express app, all API routes, the re-schedulable node-cron job, daily snapshot cron, graceful shutdown
├── db.js            # better-sqlite3 setup + schema; query/stat/analytics + snapshot helpers; key-value settings store
├── speedtest.js     # wraps speedtest-net; normalizes the result; converts bytes/sec → Mbps
│                  # (servers.js removed in v0.6.0 — tests use Ookla auto-pick, no pinning)
├── schedules.js     # registry of cron presets (30m / 1h / 2h / 6h / 12h / daily)
├── snapshots.js     # weekly/monthly rollups: ISO-week/month math, idempotent backfill, trends + month-report read paths
├── public/
│   ├── index.html   # dashboard layout: left sidebar (server / analytics / schedule / Trends link / version) + main (stats, chart, table)
│   ├── style.css    # dark theme, fixed-viewport dashboard + Trends page
│   ├── app.js       # dashboard frontend logic: fetch + render chart/table/analytics, selectors, toasts
│   ├── trends.html  # standalone Trends month report: month stat panel + picker + week stat boxes
│   └── trends.js    # Trends logic (no chart lib): stat boxes + inline-SVG dot strips
├── patches/         # patch-package patch (speedtest-net arm64)
├── scripts/         # update.ps1 (rollback-safe deploy) + deploy.bat (one-click wrapper)
├── package.json     # deps + the decompress-tarxz override; version is the app version (v0.6.0)
└── speedtest.db     # SQLite file, created on first run (gitignored)
```

## Data flow (one scheduled test)
1. **node-cron** fires `runScheduledTest()` on the configured cadence (or once on startup if the last test
   was >1h ago). A `testRunning` mutex prevents concurrent tests.
2. `executeTest()` runs the test directly — there's no server selection (removed in v0.6.0).
3. `runSpeedTest()` (`speedtest.js`) invokes **speedtest-net** with no pinned server, so the **Ookla CLI**
   (downloading the binary on first use) auto-selects the nearest/best server for our location and
   returns a normalized row (Mbps converted from bytes/sec). Immune to Ookla retiring individual servers.
4. The row is written to `speed_logs` via `insertLog()`. Failures are caught and logged — the server never
   crashes on a bad test.
5. The browser fetches the new data on its next refresh (after `Test Now`, range change, or page load).

## HTTP API
- `GET /health` → `{ ok: true }` (deploy smoke-test)
- `GET /api/logs?range&limit&offset` · `GET /api/logs/latest`
- `POST /api/test` (on-demand; `409` if one is already running)
- `GET /api/stats?range` (avg/min/max, avg packet loss, total data used, for a range)
- `GET /api/analytics` (avg / median / **stdev** of download/upload/ping over rolling 24h / 7d / 30d)
- `GET /api/trends?period=month` · `?period=week&within=YYYY-MM` (persisted weekly/monthly snapshots incl. min/p25/p75/max; in-progress period computed live + flagged `partial`; month mode feeds the Trends picker)
- `GET /api/month?within=YYYY-MM` (the Trends month report: month stats + its ISO weeks incl. upcoming placeholders + raw per-test points for the dot strips)
- `GET /api/daily?days=365` (per-day download median/avg/count; currently unused by the UI)
- `GET /api/status` (running flag, next scheduled test, db size) · `GET /api/version`
- `GET|POST /api/schedule` (cron cadence) — no server-selection API (tests use Ookla auto-pick)

## Data model (`speedtest.db`)
- **`speed_logs`** — `id, timestamp (UTC), download, upload, ping, jitter, server_name, server_location,
  isp, result_url, source ('scheduled' | 'manual')`; index on `timestamp`. Plus richer per-test capture
  (added additively via `db.js` `ensureColumns()`): `packet_loss, bytes_downloaded, bytes_uploaded,
  elapsed_download, elapsed_upload, external_ip, is_vpn, server_id/host/port/ip/country`.
- **`settings`** — `key, value` key-value store (`schedule`; the old `selected_server` key was retired in v0.6.0).
- **`snapshots`** — persisted weekly/monthly rollups: `period_type ('week'|'month'), period_key
  ('2026-W23'|'2026-06'), period_start/period_end (UTC), count,
  {download,upload,ping}_{avg,median,stdev,min,p25,p75,max}, packet_loss_avg, bytes_total`;
  unique on `(period_type, period_key)`. Derived from `speed_logs` and recomputable — the daily/startup
  backfill upserts every completed period, so newly added columns self-heal.

## Snapshots & trends
The **Trends page** (`trends.html`/`trends.js`, linked from the sidebar) is a **month report**:
a month picker selects the month, the left panel shows that month's full stats, and the right grid
shows one stat box per ISO week (upcoming weeks as placeholders). Every box pairs the numbers
(mean/median/sd/min/max, upload + ping, packet loss, data used) with an inline-SVG **dot strip** —
one dot per raw test on a page-wide 0→max axis, median tick, hover tooltips. Snapshots are aggregates of `speed_logs`, so they're recomputable: on startup
and via a fixed **daily cron** (`5 0 * * *`, separate from the re-applyable test cron), `snapshots.js`
`backfillSnapshots()` recomputes every completed week/month and **upserts** them (idempotent — missed
runs self-heal). The in-progress period is never persisted as final; `GET /api/trends` computes it live
and flags it `partial`. All period math is UTC (weeks are ISO, Monday-start).

## Deployment
Runs on a Windows 11 home server as an **NSSM service** (`speedtest-logger`, port 3000, auto-start +
restart-on-crash), LAN-only firewall rule. Code is pulled from a private GitHub repo via a read-only
**deploy key** (SSH alias `github-speedtest`). Deploys are one-click and rollback-safe via
`scripts/update.ps1` / `scripts/deploy.bat`. Full runbook: `SPEEDTEST-DEPLOY.md`.
