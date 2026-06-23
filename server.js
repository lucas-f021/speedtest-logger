const express = require('express');
const cron = require('node-cron');
const path = require('path');
const { runSpeedTest } = require('./speedtest');
const { insertLog, getLogs, getLatest, getStats, getAnalytics, getDbSize, getSetting, setSetting, closeDb, getDailyStats } = require('./db');
const { DEFAULT_SCHEDULE_KEY, getCronForKey, isValidScheduleKey, listScheduleOptions } = require('./schedules');
const { backfillSnapshots, getTrends, getMonthReport } = require('./snapshots');
const pkg = require('./package.json');

const app = express();
const PORT = process.env.PORT || 3000;

let testRunning = false;
let nextScheduledTest = null;
let scheduledTask = null;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Lightweight health check for deploy verification (no auth, always 200).
app.get('/health', (req, res) => res.json({ ok: true }));

// --- API Routes ---

app.get('/api/logs', (req, res) => {
  const { range = '24h', limit = 500, offset = 0 } = req.query;
  const result = getLogs({ range, limit: parseInt(limit), offset: parseInt(offset) });
  res.json(result);
});

app.get('/api/logs/latest', (req, res) => {
  const log = getLatest();
  res.json(log || null);
});

app.post('/api/test', async (req, res) => {
  if (testRunning) {
    return res.status(409).json({ success: false, error: 'Test already in progress' });
  }
  try {
    const result = await executeTest('manual');
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/stats', (req, res) => {
  const { range = '24h' } = req.query;
  const stats = getStats(range);
  res.json(stats);
});

app.get('/api/analytics', (req, res) => {
  res.json(getAnalytics());
});

// Month report for the Trends page: the month's stats + each of its ISO weeks (with
// upcoming weeks as placeholders) + raw per-test points for the dot strips.
app.get('/api/month', (req, res) => {
  const within = req.query.within || new Date().toISOString().slice(0, 7);
  const report = getMonthReport(within);
  if (!report) return res.status(400).json({ error: 'Invalid month — use YYYY-MM' });
  res.json(report);
});

// Per-day download aggregates (median/avg/count). Not used by the UI right now
// (the heatmap was retired with the month-report redesign) — kept for future use.
app.get('/api/daily', (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 365, 730);
  res.json({ days, rows: getDailyStats(days) });
});

// Persisted weekly/monthly trends. `?period=month` (default) → trailing 12 months;
// `?period=week&within=YYYY-MM` → that month's weeks. The in-progress period is computed
// live and flagged `partial`.
app.get('/api/trends', (req, res) => {
  const { period = 'month', within } = req.query;
  res.json(getTrends({ period, within }));
});

app.get('/api/status', (req, res) => {
  res.json({
    running: testRunning,
    nextScheduledTest: nextScheduledTest ? nextScheduledTest.toISOString() : null,
    dbSize: getDbSize(),
  });
});

app.get('/api/version', (req, res) => {
  res.json({ version: pkg.version });
});

app.get('/api/schedule', (req, res) => {
  res.json({ selected: getScheduleKey(), options: listScheduleOptions() });
});

app.post('/api/schedule', (req, res) => {
  const { schedule } = req.body || {};
  if (!isValidScheduleKey(schedule)) {
    return res.status(400).json({ success: false, error: 'Invalid schedule selection' });
  }
  setSetting('schedule', schedule);
  applySchedule(schedule);
  console.log(`[${new Date().toISOString()}] Schedule changed to "${schedule}"`);
  res.json({ success: true, selected: schedule });
});

// --- Test runner ---

async function executeTest(source) {
  testRunning = true;
  console.log(`[${new Date().toISOString()}] Speed test starting (${source})`);
  try {
    // No server pinning — Ookla auto-selects the nearest/best server for our location.
    const data = await runSpeedTest();
    const timestamp = new Date().toISOString().replace('T', ' ').replace('Z', '');
    insertLog({ ...data, timestamp, source });
    console.log(`[${new Date().toISOString()}] Speed test complete (via ${data.server_name ?? '?'}) — ↓${data.download} Mbps ↑${data.upload} Mbps ping ${data.ping}ms`);
    return data;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Speed test failed:`, err.message);
    throw err;
  } finally {
    testRunning = false;
  }
}

// --- Cron scheduler ---

function computeNextHour() {
  const next = new Date();
  next.setMinutes(0, 0, 0);
  next.setHours(next.getHours() + 1);
  return next;
}

function runScheduledTest() {
  nextScheduledTest = computeNextHour();
  if (!testRunning) {
    executeTest('scheduled').catch(() => {});
  } else {
    console.log(`[${new Date().toISOString()}] Skipping scheduled test — another test is already running`);
  }
}

// Resolve the saved schedule (default hourly), falling back if it's invalid/missing.
function getScheduleKey() {
  const stored = getSetting('schedule');
  return isValidScheduleKey(stored) ? stored : DEFAULT_SCHEDULE_KEY;
}

// (Re)apply a schedule to the live cron task — stops the old one so changes take
// effect without restarting the process.
function applySchedule(key) {
  const expr = getCronForKey(key) || getCronForKey(DEFAULT_SCHEDULE_KEY);
  if (scheduledTask) scheduledTask.stop();
  scheduledTask = cron.schedule(expr, runScheduledTest);
  console.log(`[${new Date().toISOString()}] Scheduled tests: "${key}" (${expr})`);
}

applySchedule(getScheduleKey());

nextScheduledTest = computeNextHour();

// Snapshots: build any missing weekly/monthly rollups now, then keep them current with a
// fixed daily rollup. backfillSnapshots() is idempotent, so a period is captured within a
// day of completing and a missed run (downtime) self-heals on the next tick.
try { backfillSnapshots(); } catch (err) {
  console.error(`[${new Date().toISOString()}] Snapshot backfill failed:`, err.message);
}
cron.schedule('5 0 * * *', () => {
  try { backfillSnapshots(); } catch (err) {
    console.error(`[${new Date().toISOString()}] Snapshot rollup failed:`, err.message);
  }
});

// Run immediately on startup if last test was more than 1 hour ago
(async () => {
  const latest = getLatest();
  const shouldRunNow = !latest || (Date.now() - new Date(latest.timestamp + 'Z').getTime()) > 3600_000;
  if (shouldRunNow) {
    console.log(`[${new Date().toISOString()}] Running initial speed test on startup`);
    executeTest('scheduled').catch(() => {});
  }
})();

// --- Start server ---

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Speed Test Logger running at http://0.0.0.0:${PORT} (reachable on the LAN)`);
});

// --- Graceful shutdown ---

function shutdown() {
  console.log('\nShutting down...');
  server.close(() => {
    closeDb();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
