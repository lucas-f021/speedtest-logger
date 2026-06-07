# Speed Test Logger

## Project Overview
A self-hosted internet speed test logging application that runs on a Windows 11 machine. It automatically tests internet speed every hour, logs results to a persistent SQLite database, and serves a web UI to view historical data with charts and a filterable log table. Includes an on-demand "Test Now" button.

## Tech Stack
- **Runtime:** Node.js (v18+)
- **Server:** Express.js
- **Database:** SQLite via `better-sqlite3` (synchronous, fast, no native build issues on Windows)
- **Speed Test Engine:** `speedtest-net` (Ookla-based CLI wrapper)
- **Scheduling:** `node-cron` (runs speed test every hour)
- **Frontend:** Plain HTML + CSS + vanilla JavaScript (no build step)
- **Charting:** Chart.js with `chartjs-adapter-date-fns` for time-series axes
- **Process Manager (optional):** pm2 for keeping the server alive across reboots
- **Dependency patching:** `patch-package` adds Apple Silicon (`darwin-arm64`) support to `speedtest-net`, applied automatically via a `postinstall` hook
- **Native-dep override:** `speedtest-net` eagerly pulls in the native `lzma-native` (via `decompress-tarxz`) for `.xz` archives it never downloads on any supported platform (Windows uses `.zip`, macOS/Linux use `.tgz`). `lzma-native@4` has no prebuilt binary for Node 22 and won't compile without a C++ toolchain, breaking `npm ci`. A `package.json` `overrides` entry redirects `decompress-tarxz` → pure-JS `decompress-targz`, dropping `lzma-native` from the tree so installs work everywhere (incl. Windows/Node 22) with no compiler.
- **Dev workflow:** `npm run dev` runs the server under `node --watch` for auto-restart on file changes

## Project Structure
```
speedtest-logger/
├── server.js              # Express server, API routes, cron scheduler
├── db.js                  # SQLite setup, query helpers, settings store
├── speedtest.js           # Speed test runner (wraps speedtest-net; accepts a server id)
├── servers.js             # Vetted server registry + "Fastest" latency picker
├── patches/               # patch-package patches (e.g. speedtest-net arm64 support)
├── package.json
├── CLAUDE.md
└── public/                # Static frontend served by Express
    ├── index.html         # Layout: left sidebar (server selector) + main dashboard
    ├── style.css          # Styling (fixed-viewport dashboard, scrollable table)
    └── app.js             # Frontend logic (server selector, chart + table)
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
    source TEXT NOT NULL DEFAULT 'scheduled'  -- 'scheduled' or 'manual'
);

CREATE INDEX IF NOT EXISTS idx_timestamp ON speed_logs(timestamp);

-- Key/value store for app settings, e.g. selected_server = '1774' | '74553' | '29122' | 'fastest'
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);
```

## API Endpoints

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
- Response: `{ avgDownload, avgUpload, avgPing, minDownload, maxDownload, minUpload, maxUpload, totalTests }`

### `GET /api/status`
Health check. Returns `{ running: true, nextScheduledTest: "ISO timestamp", dbSize: number }`.

### `GET /api/server`
Returns the current server selection and available options.
Response: `{ selected: "1774" | "74553" | "29122" | "fastest", options: [{ key, name, location }, ...] }`

### `POST /api/server`
Sets the server used for future tests. Body: `{ selection: "<key>" }` where key is one of the three server ids or `"fastest"`. Persists to the `settings` table. Returns `{ success: true, selected }`, or `400` `{ success: false, error }` for an invalid key.

## Frontend UI Requirements

### Layout
Single-page app, dark theme, optimized for desktop. **Fixed-viewport dashboard:** the page itself does not scroll — a left **sidebar** holds the server selector, and the main area splits the remaining height between the chart and a **scrollable** log table (only the table body scrolls; its header stays pinned). Falls back to normal vertical scrolling on narrow/phone widths.

### Sidebar — Server Selector
The left sidebar lists four choices and lets the user pick which Ookla server tests run against:
- **Comcast — Boston, MA** (id 1774) — the default on first run
- **GONETSPEED — Providence, RI** (id 74553)
- **i3 Broadband — Warren, RI** (id 29122)
- **Fastest** — before each test, a quick TCP-latency probe of the three picks the lowest-latency one

Selecting an option saves it (via `POST /api/server`) for future tests only — it does **not** trigger a test. The choice persists across restarts (stored in the `settings` table; Comcast is only the initial default). The header shows a "via …" indicator of the active server, and the log table's Server column records which server each result actually used.

### Components

#### Header
- App title "Speed Test Logger"
- "Test Now" button (prominent, primary color)
  - Shows a spinner/loading state while test runs (~20-30 sec)
  - Disables the button during the test to prevent double-clicks
  - On completion, shows a brief toast/notification with the result summary
  - Automatically refreshes the chart and table with the new data point

#### Stats Bar
- Cards showing: Average Download, Average Upload, Average Ping, Total Tests
- Updates based on the currently selected time range

#### Speed Chart (Chart.js)
- Line chart with **two Y-axes**: left for speed (Mbps), right for ping (ms)
- Three lines: Download (blue/cyan), Upload (green), Ping (orange/red)
- X-axis: time (auto-formatted based on range)
- Time range selector buttons: 1h, 6h, 24h, 7d, 30d, All
- Tooltip showing full details on hover
- Smooth curves, filled area under download/upload lines (low opacity)

#### Log Table
- Columns: Timestamp (local time), Download (Mbps), Upload (Mbps), Ping (ms), Server, Source (scheduled/manual badge)
- Sorted newest first
- Alternating row colors for readability
- Auto-updates when time range changes
- Show "scheduled" vs "manual" as small colored badges

## Server Behavior

### Cron Scheduling
- Use `node-cron` to schedule a speed test every hour on the hour: `'0 * * * *'`
- On server startup, check when the last test was. If more than 1 hour ago, run one immediately.
- Log test start/completion to console with timestamps.
- If a test is already running (manual or scheduled), skip/queue rather than running concurrent tests. Use a simple mutex/flag.

### Server Selection (`servers.js`)
- A fixed registry of three vetted local servers (Comcast/Boston `1774`, GONETSPEED/Providence `74553`, i3/Warren `29122`) plus a `"fastest"` option, each with host/port for latency probing.
- Before each test, `server.js` reads `selected_server` from settings (default Comcast). For `"fastest"`, `pickFastestServer()` does a cheap TCP-connect latency probe to all three and returns the lowest (falls back to the default if all are unreachable).
- The resolved server id is passed to the runner, which hands Ookla a `-s <id>` flag to pin the test.

### Speed Test Runner (`speedtest.js`)
- `runSpeedTest(serverId)` wraps `speedtest-net`, passing the optional server id, and returns a normalized result object.
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
> `speedtest-logger` Windows service on port 3000 — see `DEPLOY-AS-SERVICE.md` for the complete,
> filled-in runbook (deploy key, service install, firewall, reboot test).

### Environment Variables (optional)
- `PORT` — server port (default: `3000`)
- `CRON_SCHEDULE` — cron expression (default: `0 * * * *` = every hour)
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
  }
}
```

Frontend dependencies loaded via CDN in `index.html`:
- Chart.js: `https://cdn.jsdelivr.net/npm/chart.js`
- chartjs-adapter-date-fns: `https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns`
