# Speed Test Logger

## Project Overview
A self-hosted internet speed test logging application that runs on a Windows 11 machine. It automatically tests internet speed every hour, logs results to a persistent SQLite database, and serves a web UI to view historical data with charts and a filterable log table. Includes an on-demand "Test Now" button.

## Tech Stack
- **Runtime:** Node.js (v18+)
- **Server:** Express.js
- **Database:** SQLite via `better-sqlite3` (synchronous, fast, no native build issues on Windows)
- **Speed Test Engine:** `speedtest-net` (Ookla-based CLI wrapper)
- **Scheduling:** `node-cron` (configurable cadence via the Schedule picker; hourly by default)
- **Frontend:** Plain HTML + CSS + vanilla JavaScript (no build step)
- **Charting:** Chart.js with `chartjs-adapter-date-fns` for time-series axes
- **Process manager / deploy:** **NSSM** Windows service in production + one-click `scripts/deploy.bat` (rollback-safe `update.ps1`); pm2 also works
- **Dependency patching:** `patch-package` adds Apple Silicon (`darwin-arm64`) support to `speedtest-net`, applied automatically via a `postinstall` hook
- **Native-dep override:** `speedtest-net` eagerly pulls in the native `lzma-native` (via `decompress-tarxz`) for `.xz` archives it never downloads on any supported platform (Windows uses `.zip`, macOS/Linux use `.tgz`). `lzma-native@4` has no prebuilt binary for Node 22 and won't compile without a C++ toolchain, breaking `npm ci`. A `package.json` `overrides` entry redirects `decompress-tarxz` → pure-JS `decompress-targz`, dropping `lzma-native` from the tree so installs work everywhere (incl. Windows/Node 22) with no compiler.
- **Dev workflow:** `npm run dev` runs the server under `node --watch` for auto-restart on file changes

## Project Structure
```
speedtest-logger/
├── server.js              # Express server, all API routes, re-schedulable cron scheduler, graceful shutdown
├── db.js                  # SQLite setup; logs/stats/analytics + snapshot query helpers; key-value settings store
├── speedtest.js           # Speed test runner (wraps speedtest-net; accepts a server id)
├── servers.js             # UNUSED since v0.6.0 (server pinning removed; safe to delete) — tests use Ookla auto-pick
├── schedules.js           # Cron preset registry (30m / 1h / 2h / 6h / 12h / daily)
├── snapshots.js           # Weekly/monthly rollups: ISO-week/month math, idempotent backfill, trends + month-report read paths
├── patches/               # patch-package patches (e.g. speedtest-net arm64 support)
├── scripts/               # update.ps1 (rollback-safe deploy) + deploy.bat (one-click wrapper)
├── package.json           # deps + the decompress-tarxz override; "version" is the app version
├── CLAUDE.md              # this file
├── ARCHITECTURE.md        # architecture + tech-stack overview
├── BACKLOG.md             # nice-to-have ideas
├── SPEEDTEST-DEPLOY.md    # canonical NSSM / one-click deploy runbook
└── public/                # Static frontend served by Express
    ├── index.html         # Layout: left sidebar (server / analytics / schedule / Trends link / version) + main dashboard
    ├── style.css          # Styling (fixed-viewport dashboard + Trends page, scrollable tables)
    ├── app.js             # Dashboard logic (selectors, chart + table + analytics, version)
    ├── trends.html        # Trends month report: month stat panel + picker + week stat boxes
    └── trends.js          # Trends logic (no chart lib): stat boxes + inline-SVG dot strips
```

## Database Schema
Single SQLite file: `speedtest.db` (created automatically in project root on first run).

```sql
CREATE TABLE IF NOT EXISTS speed_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),  -- ISO 8601 UTC
    download REAL,          -- Mbps
    upload REAL,            -- Mbps
    ping REAL,              -- ms
    jitter REAL,            -- ms (nullable, not always available)
    server_name TEXT,       -- Ookla test server used
    server_location TEXT,   -- City/region of test server
    isp TEXT,               -- ISP name reported by Ookla
    result_url TEXT,        -- Ookla result URL (nullable)
    source TEXT NOT NULL DEFAULT 'scheduled',  -- 'scheduled' or 'manual'
    -- Extra Ookla fields (added additively via db.js ensureColumns() — ALTER TABLE on the
    -- live DB, since CREATE TABLE IF NOT EXISTS won't alter an existing table). All nullable.
    packet_loss REAL,        -- % packets lost
    bytes_downloaded INTEGER,-- bytes moved during the download test
    bytes_uploaded INTEGER,  -- bytes moved during the upload test
    elapsed_download INTEGER,-- download test duration (ms)
    elapsed_upload INTEGER,  -- upload test duration (ms)
    external_ip TEXT,        -- WAN / public IP at test time
    is_vpn INTEGER,          -- 1 if the test ran over a VPN, else 0
    server_id TEXT,          -- Ookla server id
    server_host TEXT,        -- server host:port
    server_port INTEGER,     -- server port
    server_ip TEXT,          -- server IP
    server_country TEXT      -- server country
);

CREATE INDEX IF NOT EXISTS idx_timestamp ON speed_logs(timestamp);

-- Key/value store for app settings:
--   schedule = '30m' | '1h' | '2h' | '6h' | '12h' | '1d'
-- (selected_server was removed in v0.6.0 — tests use Ookla's auto-pick. Old DBs may still
--  have a stale selected_server row; it's simply ignored.)
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);

-- Persisted weekly/monthly rollups of speed_logs (one row per ISO week / calendar month).
-- Derived from speed_logs and recomputable; backfilled on startup + a daily cron (idempotent
-- upsert keyed by period_type+period_key). See snapshots.js.
CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    period_type TEXT NOT NULL,            -- 'week' | 'month'
    period_key  TEXT NOT NULL,            -- '2026-W23' | '2026-06'
    period_start TEXT NOT NULL,           -- ISO 8601 UTC, inclusive
    period_end   TEXT NOT NULL,           -- exclusive
    count INTEGER NOT NULL,
    download_avg REAL, download_median REAL, download_stdev REAL,
    upload_avg REAL,   upload_median REAL,   upload_stdev REAL,
    ping_avg REAL,     ping_median REAL,     ping_stdev REAL,
    -- Added via ensureColumns(); snapshots are recomputable so backfillSnapshots() fills
    -- these for pre-existing rows on its next run:
    -- {download,upload,ping}_{min,p25,p75,max} — 12 REAL columns (five-number spread),
    -- packet_loss_avg REAL, bytes_total INTEGER (per-period quality + data used).
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(period_type, period_key)
);
```

## API Endpoints

### `GET /health`
Lightweight liveness check used by the deploy scripts. Returns `{ ok: true }`.

### `GET /api/logs`
Returns speed test logs. Supports query params for filtering:
- `?range=1h|6h|24h|7d|30d|all` — time range filter (default: `24h`)
- `?limit=N` — max rows (default: 500)
- `?offset=N` — pagination offset

Response: `{ logs: [...], total: number }`

### `GET /api/logs/latest`
Returns the single most recent test result.

### `POST /api/test`
Triggers an on-demand speed test. Runs the test, saves to DB with `source: 'manual'`, and returns the result. Should return a loading-friendly response — the test takes 20-30 seconds.

Response: `{ success: true, result: { ... } }` or `{ success: false, error: "..." }`

### `GET /api/stats`
Returns aggregate stats for a given range:
- `?range=24h|7d|30d|all`
- Response: `{ avgDownload, avgUpload, avgPing, minDownload, maxDownload, minUpload, maxUpload, avgPacketLoss, bytesTotal, totalTests }` (`avgPacketLoss` in %, `bytesTotal` = summed download+upload bytes over the range)

### `GET /api/analytics`
Rolling-window analytics for the sidebar (no params). For each of `day` (24h), `week` (7d), `month` (30d):
`{ count, download: {avg, median, stdev}, upload: {…}, ping: {…} }`. Median + stdev are computed in JS (SQLite has neither).

### `GET /api/trends`
Persisted weekly/monthly snapshot trends (`snapshots.js`). The Trends page uses the month mode for its picker list; the week mode remains available.
- `?period=month` (default) — the trailing 12 calendar months (incl. the current one).
- `?period=week&within=YYYY-MM` — the ISO weeks (Mon-start, UTC) whose Monday falls in that month.

Response: `{ period, within?, rows: [{ key, label, start, end, count, partial, download:{avg,median,stdev,min,p25,p75,max}, upload:{…}, ping:{…} }] }`, oldest→newest. Completed periods come from the `snapshots` table (falling back to a live recompute if not yet persisted); the in-progress period is always computed live from `speed_logs` and flagged `partial: true`.

### `GET /api/month`
The Trends page's month report. `?within=YYYY-MM` (default: the current month).
Response: `{ within, month, weeks: [...] }`. `month` and each non-future week are trend rows (same shape as `/api/trends` rows, plus `packet_loss_avg`, `bytes_total`, and `points: [{ timestamp, download, upload, ping }]` — the raw tests, for the dot strips). `weeks` covers every ISO week whose Monday falls in the month (4–5), in order with an `index`; weeks that haven't started yet are placeholders: `{ key, label, index, future: true, count: 0, start, end }`. `400` on a malformed month key.

### `GET /api/daily`
Per-day download aggregates. `?days=N` (default 365, max 730). **Currently unused by the UI** (the calendar heatmap was retired in the v0.5.0 month-report redesign) — kept for future use.
Response: `{ days, rows: [{ date: 'YYYY-MM-DD', count, median, avg }] }` (download Mbps), oldest→newest, days with no tests omitted.

### `GET /api/status`
Returns `{ running, nextScheduledTest: "ISO timestamp", dbSize }` — used to drive the running indicator.

> **No server-selection API** (removed in v0.6.0). Tests always run against Ookla's
> auto-selected server; the server actually used is recorded per row and shown in the UI.

### `GET /api/schedule` · `POST /api/schedule`
Get/set how often the scheduled test runs. `GET` → `{ selected, options: [{key,label}] }`. `POST` body
`{ schedule: "<key>" }` (one of `30m|1h|2h|6h|12h|1d`) persists to `settings` and **re-applies the cron job
live** (no restart); `400` on an invalid key.

### `GET /api/version`
Returns `{ version }` read from `package.json` (shown in the sidebar footer).

## Frontend UI Requirements

### Layout
Single-page app, dark theme, optimized for desktop. **Fixed-viewport dashboard:** the page itself does not scroll — a left **sidebar** holds Analytics + Schedule + the Trends link, and the main area splits the remaining height between the chart and a **scrollable** log table (only the table body scrolls; its header stays pinned). Falls back to normal vertical scrolling on narrow/phone widths.

### Server selection — none (auto-pick)
As of **v0.6.0 there is no server picker**. Every test runs against **Ookla's auto-selected** nearest/best server for the connection's location (the runner passes no `-s` flag). This is intentionally immune to Ookla decommissioning/renumbering individual servers — the old cause of `NoServersException` outages (e.g. Comcast/Boston id 1774, retired June 2026). The header shows a "via …" indicator of the server the **latest** test used (from `GET /api/logs/latest`), and the log table's Server column records the server each result actually used — so the auto-pick is always transparent.

### Sidebar — Analytics
Rolling **avg / median / stdev** of download, upload, and ping for three windows — **Day (24h) / Week (7d) / Month (30d)** — fed by `GET /api/analytics`.

### Sidebar — Schedule & version
A dropdown sets how often the scheduled test runs (30m / 1h / 2h / 6h / 12h / daily), backed by `GET|POST /api/schedule`; the choice persists and is applied live. The app version (`vX.Y.Z`, from `package.json`) is pinned at the bottom of the sidebar. A **Reports → Trends** link opens the standalone Trends page (`/trends.html`).

### Trends Page (`trends.html` / `trends.js`)
A standalone **month-centric report** (linked from the sidebar), no chart library — the visuals are small hand-rolled inline SVGs. Fed by `GET /api/month` (the report) + `GET /api/trends?period=month` (the picker list). Layout:
- **Left column** — the selected month's **stat panel** (defaults to the current month, tagged `live` and "to date"), with a **month picker** below it (every month with data, trailing 12; clicking re-renders the page for that month).
- **Right** — one **stat box per ISO week** of the selected month (Mon-start; 4 or 5 boxes). Weeks that haven't started yet render as dashed "upcoming" placeholders.
- **Every stat box** (month + weeks) shows the same block: big mean download, a **dot strip** (one dot per test on a 0→max Mbps axis shared across the whole page, with deterministic jitter, a yellow median tick, and native hover tooltips showing the exact value + local time), then median / sd / min·max, compact upload + ping lines (avg with median), packet-loss avg, and data used.
Period summaries are deliberately **not** drawn as a line chart — they're distributions, not a time series. Reuses the dashboard's dark theme.

### Components

#### Header
- App title "Speed Test Logger"
- "Test Now" button (prominent, primary color)
  - Shows a spinner/loading state while test runs (~20-30 sec)
  - Disables the button during the test to prevent double-clicks
  - On completion, shows a brief toast/notification with the result summary
  - Automatically refreshes the chart and table with the new data point

#### Stats Bar
- Cards showing: Average Download, Average Upload, Average Ping, Average Packet Loss, Data Used (total GB/MB over the range), Total Tests
- Updates based on the currently selected time range

#### Speed Chart (Chart.js)
- Line chart with **two Y-axes**: left for speed (Mbps), right for ping (ms)
- Three lines: Download (blue/cyan), Upload (green), Ping (orange/red)
- X-axis: time (auto-formatted based on range)
- Time range selector buttons: 1h, 6h, 24h, 7d, 30d, All
- **Mean + median reference lines** for download (dashed/dotted; values track the selected range)
- Tooltip showing full details on hover, with each metric tagged by line style (solid / dashed / dotted)
- Smooth curves, filled area under download/upload lines (low opacity)

#### Log Table
- Columns: Timestamp (local time), Download (Mbps), Upload (Mbps), Ping (ms), Loss (packet loss %), Data (per-test data used), Server, Source (scheduled/manual badge). The Server cell's hover tooltip surfaces the stored-but-not-columned fields (external IP, VPN flag, server host/country/ip/id).
- Sorted newest first
- Alternating row colors for readability
- Auto-updates when time range changes
- Show "scheduled" vs "manual" as small colored badges

## Server Behavior

### Cron Scheduling
- Use `node-cron`; cadence is user-configurable via the Schedule picker (`schedules.js` presets, persisted in `settings`, default hourly `'0 * * * *'`). The cron task is re-applied live on change — no restart.
- On server startup, check when the last test was. If more than 1 hour ago, run one immediately.
- Log test start/completion to console with timestamps.
- If a test is already running (manual or scheduled), skip/queue rather than running concurrent tests. Use a simple mutex/flag.

### Snapshot Rollups (`snapshots.js`)
- On startup and via a fixed daily cron (`'5 0 * * *'`, separate from the re-applyable test cron), `backfillSnapshots()` recomputes the avg/median/stdev of every completed ISO week and calendar month from `speed_logs` and **upserts** them into the `snapshots` table.
- Idempotent: re-running overwrites the same `(period_type, period_key)` rows, so missed runs (downtime) self-heal on the next tick and a period is persisted within a day of completing.
- Period math is all UTC; week boundaries are ISO weeks (Monday start). The in-progress period is never persisted — `GET /api/trends` computes it live so the Trends page is always current.

### Server Selection — none (Ookla auto-pick)
- **No server pinning.** As of v0.6.0 there's no curated registry and no `selected_server` setting; `servers.js` is now unused (orphaned, safe to delete). Every test lets Ookla choose the nearest/best server for the connection's location.
- This is deliberately robust to Ookla retiring/renumbering servers (the old `NoServersException` failure mode). The server actually used is captured per row (`server_*` fields) and surfaced in the UI.

### Speed Test Runner (`speedtest.js`)
- `runSpeedTest()` wraps `speedtest-net` with no server id (Ookla auto-pick) and returns a normalized result object.
- Handle errors gracefully — if the test fails (network down, timeout), log the error to console but do NOT crash the server. Optionally insert a row with null values and an error note.
- Convert speeds from bytes/sec (speedtest-net default) to Mbps: `(bytes * 8) / 1_000_000`.

### Concurrency Guard
- Only one speed test can run at a time.
- If `POST /api/test` is called while a test is running, return `{ success: false, error: "Test already in progress" }` with HTTP 409.
- The frontend should poll or use the response to show appropriate state.

## Setup & Run Instructions (for Windows 11)

### Prerequisites
- Node.js v18+ installed (download from nodejs.org)
- npm (comes with Node.js)

### Install
```bash
git clone <repo-url> speedtest-logger
cd speedtest-logger
npm install
```

### Run
```bash
npm run dev    # development: auto-restarts on file changes (node --watch)
npm start      # production: plain `node server.js`
```
Server starts on `http://localhost:3000` (configurable via `PORT` env var).

> **Apple Silicon (arm64 Macs):** `speedtest-net@2.2.0` doesn't ship an arm64 build by default. A `patch-package` patch in `patches/` adds it and is applied automatically by the `postinstall` hook on `npm install` — no manual step needed.

### Run Persistently (survive reboots)
```bash
npm install -g pm2
pm2 start server.js --name speedtest-logger
pm2 save
pm2 startup   # follow instructions to set up Windows service
```

> **Production note:** the live deployment on the home server uses **NSSM** (not pm2) to run this as the
> `speedtest-logger` Windows service on port 3000 — see `SPEEDTEST-DEPLOY.md` for the complete,
> filled-in runbook (deploy key, service install, firewall, one-click `deploy.bat`, reboot test).

### Environment Variables (optional)
- `PORT` — server port (default: `3000`)
- `CRON_SCHEDULE` — *(legacy; superseded by the in-app Schedule picker, which persists to `settings`; default hourly)*
- `DB_PATH` — path to SQLite file (default: `./speedtest.db`)

## Key Implementation Notes

1. **better-sqlite3 over sqlite3:** Use `better-sqlite3` because it's synchronous, faster for single-connection use, and avoids callback hell. Perfect for this use case where only one server process accesses the DB.

2. **Speed conversion:** `speedtest-net` returns bandwidth in bytes/sec. Always convert: `(bandwidth * 8) / 1_000_000` for Mbps. Round to 2 decimal places for display.

3. **Timestamps:** Store all timestamps as ISO 8601 UTC in the DB. Convert to local time only in the frontend using `new Date(utcString).toLocaleString()`.

4. **Error resilience:** The server must never crash due to a failed speed test. Wrap the test runner in try/catch. Log errors. The cron job should keep running regardless of individual test failures.

5. **Static file serving:** Use `express.static('public')` to serve the frontend. No build step, no bundler. The `public/` folder is served at `/`.

6. **Chart.js time axis:** Use `type: 'time'` for the X-axis with `chartjs-adapter-date-fns`. This auto-formats labels (e.g., "2:00 PM" for 24h view, "Mon Jan 5" for 30d view).

7. **Frontend fetching:** Use vanilla `fetch()` for all API calls. Poll for test status if needed. On page load, fetch logs for the default range (24h) and render both chart and table.

8. **CORS:** Not needed — frontend and API are served from the same Express server on the same origin.

9. **No authentication:** This is a local network tool. If the user wants to expose it externally later, auth can be added as a follow-up.

10. **Graceful shutdown:** Handle `SIGINT`/`SIGTERM` to close the DB connection cleanly.

## Dependencies
```json
{
  "dependencies": {
    "express": "^4.18.0",
    "better-sqlite3": "^11.0.0",
    "speedtest-net": "^2.2.0",
    "node-cron": "^3.0.0"
  },
  "devDependencies": {
    "patch-package": "^8.0.1"
  },
  "overrides": {
    "decompress-tarxz": "npm:decompress-targz@^4.1.1"
  }
}
```

Frontend dependencies loaded via CDN:
- `index.html` (dashboard): Chart.js + chartjs-adapter-date-fns (`https://cdn.jsdelivr.net/npm/chart.js`, `…/chartjs-adapter-date-fns`)
- `trends.html` (Trends page): none — the dot strips are dependency-free inline SVG
