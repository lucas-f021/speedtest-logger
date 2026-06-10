const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'speedtest.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS speed_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        download REAL,
        upload REAL,
        ping REAL,
        jitter REAL,
        server_name TEXT,
        server_location TEXT,
        isp TEXT,
        result_url TEXT,
        source TEXT NOT NULL DEFAULT 'scheduled'
      );
      CREATE INDEX IF NOT EXISTS idx_timestamp ON speed_logs(timestamp);
      -- NOTE: extra Ookla columns (packet_loss, bytes_*, elapsed_*, external_ip, is_vpn,
      -- server_id/host/port/ip/country) are added by ensureColumns() below — CREATE TABLE
      -- IF NOT EXISTS won't alter the live production table, so they're migrated in additively.

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      -- Persisted weekly/monthly rollups of speed_logs (see snapshots.js).
      -- One row per completed (or in-progress) ISO week / calendar month.
      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        period_type TEXT NOT NULL,            -- 'week' | 'month'
        period_key  TEXT NOT NULL,            -- '2026-W23' | '2026-06'
        period_start TEXT NOT NULL,           -- 'YYYY-MM-DD HH:MM:SS' UTC, inclusive
        period_end   TEXT NOT NULL,           -- exclusive
        count INTEGER NOT NULL,
        download_avg REAL, download_median REAL, download_stdev REAL,
        upload_avg REAL,   upload_median REAL,   upload_stdev REAL,
        ping_avg REAL,     ping_median REAL,     ping_stdev REAL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(period_type, period_key)
      );
    `);
    ensureColumns();
  }
  return db;
}

// Additive, idempotent migration: add any missing columns to a live table.
// SQLite ADD COLUMN is cheap and safe; existing rows get NULL.
function ensureTableColumns(table, columns) {
  const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
  for (const [name, type] of Object.entries(columns)) {
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}

function ensureColumns() {
  ensureTableColumns('speed_logs', {
    packet_loss: 'REAL',
    bytes_downloaded: 'INTEGER',
    bytes_uploaded: 'INTEGER',
    elapsed_download: 'INTEGER',
    elapsed_upload: 'INTEGER',
    external_ip: 'TEXT',
    is_vpn: 'INTEGER',
    server_id: 'TEXT',
    server_host: 'TEXT',
    server_port: 'INTEGER',
    server_ip: 'TEXT',
    server_country: 'TEXT',
  });
  // Distribution columns for the Trends boxplots. Snapshots are fully recomputable from
  // speed_logs, so backfillSnapshots() (startup + daily cron) fills these for old rows.
  const quartileCols = {};
  for (const metric of ['download', 'upload', 'ping']) {
    for (const stat of ['min', 'p25', 'p75', 'max']) {
      quartileCols[`${metric}_${stat}`] = 'REAL';
    }
  }
  quartileCols.packet_loss_avg = 'REAL';
  quartileCols.bytes_total = 'INTEGER';
  ensureTableColumns('snapshots', quartileCols);
}

function insertLog(data) {
  const stmt = getDb().prepare(`
    INSERT INTO speed_logs (
      timestamp, download, upload, ping, jitter, server_name, server_location, isp, result_url, source,
      packet_loss, bytes_downloaded, bytes_uploaded, elapsed_download, elapsed_upload,
      external_ip, is_vpn, server_id, server_host, server_port, server_ip, server_country
    )
    VALUES (
      @timestamp, @download, @upload, @ping, @jitter, @server_name, @server_location, @isp, @result_url, @source,
      @packet_loss, @bytes_downloaded, @bytes_uploaded, @elapsed_download, @elapsed_upload,
      @external_ip, @is_vpn, @server_id, @server_host, @server_port, @server_ip, @server_country
    )
  `);
  const result = stmt.run(data);
  return result.lastInsertRowid;
}

function getLogs({ range = '24h', limit = 500, offset = 0 } = {}) {
  const db = getDb();
  const whereClause = buildTimeFilter(range);
  const total = db.prepare(`SELECT COUNT(*) as count FROM speed_logs ${whereClause}`).get().count;
  const logs = db.prepare(`
    SELECT * FROM speed_logs ${whereClause}
    ORDER BY timestamp DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);
  return { logs, total };
}

function getLatest() {
  return getDb().prepare('SELECT * FROM speed_logs ORDER BY timestamp DESC LIMIT 1').get();
}

function getStats(range = '24h') {
  const whereClause = buildTimeFilter(range);
  return getDb().prepare(`
    SELECT
      ROUND(AVG(download), 2) as avgDownload,
      ROUND(AVG(upload), 2) as avgUpload,
      ROUND(AVG(ping), 2) as avgPing,
      ROUND(MIN(download), 2) as minDownload,
      ROUND(MAX(download), 2) as maxDownload,
      ROUND(MIN(upload), 2) as minUpload,
      ROUND(MAX(upload), 2) as maxUpload,
      ROUND(AVG(packet_loss), 2) as avgPacketLoss,
      SUM(COALESCE(bytes_downloaded, 0) + COALESCE(bytes_uploaded, 0)) as bytesTotal,
      COUNT(*) as totalTests
    FROM speed_logs
    ${whereClause}
    AND download IS NOT NULL
  `).get();
}

// --- Rolling analytics: avg + median of download/upload/ping over 24h / 7d / 30d ---

function avg(nums) {
  if (!nums.length) return null;
  return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10;
}

function median(nums) {
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const m = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(m * 10) / 10;
}

// Population standard deviation (we have every measurement in the window, not a sample).
function stdev(nums) {
  if (!nums.length) return null;
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  const variance = nums.reduce((a, b) => a + (b - mean) ** 2, 0) / nums.length;
  return Math.round(Math.sqrt(variance) * 10) / 10;
}

function windowStats(range) {
  const rows = getDb()
    .prepare(`SELECT download, upload, ping FROM speed_logs ${buildTimeFilter(range)}`)
    .all();
  const col = (key) => rows.map(r => r[key]).filter(v => v != null);
  const dl = col('download'), up = col('upload'), pg = col('ping');
  return {
    count: dl.length,
    download: { avg: avg(dl), median: median(dl), stdev: stdev(dl) },
    upload: { avg: avg(up), median: median(up), stdev: stdev(up) },
    ping: { avg: avg(pg), median: median(pg), stdev: stdev(pg) },
  };
}

function getAnalytics() {
  return {
    day: windowStats('24h'),
    week: windowStats('7d'),
    month: windowStats('30d'),
  };
}

// Linear-interpolated percentile of an already-sorted array (p in [0, 1]).
function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  const v = lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  return Math.round(v * 10) / 10;
}

// avg/median/stdev plus the five-number spread (min/p25/p75/max) for the Trends boxplots.
function distSummary(nums) {
  if (!nums.length) {
    return { avg: null, median: null, stdev: null, min: null, p25: null, p75: null, max: null };
  }
  const sorted = [...nums].sort((a, b) => a - b);
  return {
    avg: avg(nums), median: median(nums), stdev: stdev(nums),
    min: sorted[0], max: sorted[sorted.length - 1],
    p25: percentile(sorted, 0.25), p75: percentile(sorted, 0.75),
  };
}

// Like windowStats() but for an explicit [startISO, endISO) window (UTC
// 'YYYY-MM-DD HH:MM:SS' strings). Used to roll up weekly/monthly snapshots.
function statsBetween(startISO, endISO) {
  const rows = getDb()
    .prepare(`
      SELECT download, upload, ping, packet_loss,
             COALESCE(bytes_downloaded, 0) + COALESCE(bytes_uploaded, 0) AS bytes
      FROM speed_logs WHERE timestamp >= ? AND timestamp < ?
    `)
    .all(startISO, endISO);
  const col = (key) => rows.map(r => r[key]).filter(v => v != null);
  const dl = col('download'), up = col('upload'), pg = col('ping'), pl = col('packet_loss');
  const bytesTotal = rows.reduce((a, r) => a + r.bytes, 0);
  return {
    count: dl.length,
    download: distSummary(dl),
    upload: distSummary(up),
    ping: distSummary(pg),
    packet_loss_avg: pl.length ? Math.round((pl.reduce((a, b) => a + b, 0) / pl.length) * 100) / 100 : null,
    bytes_total: bytesTotal || null,
  };
}

// Raw per-test rows for one period — feeds the Trends dot strips (one dot per test).
function getTestsBetween(startISO, endISO) {
  return getDb().prepare(`
    SELECT timestamp, download, upload, ping FROM speed_logs
    WHERE timestamp >= ? AND timestamp < ? ORDER BY timestamp
  `).all(startISO, endISO);
}

// Per-day download aggregates for the Trends calendar heatmap. Median is computed in
// JS (SQLite has no median); row volume is small (≤ ~48 tests/day).
function getDailyStats(days = 365) {
  const rows = getDb().prepare(`
    SELECT date(timestamp) AS day, download FROM speed_logs
    WHERE timestamp >= datetime('now', ?) AND download IS NOT NULL
    ORDER BY day
  `).all(`-${Math.max(1, days)} days`);
  const byDay = new Map();
  for (const r of rows) {
    if (!byDay.has(r.day)) byDay.set(r.day, []);
    byDay.get(r.day).push(r.download);
  }
  return [...byDay.entries()].map(([date, dls]) => ({
    date, count: dls.length, median: median(dls), avg: avg(dls),
  }));
}

// --- Snapshot persistence (weekly/monthly rollups) ---

function getMinTimestamp() {
  const row = getDb().prepare('SELECT MIN(timestamp) AS min FROM speed_logs').get();
  return row && row.min ? row.min : null;
}

function upsertSnapshot(s) {
  // avg/median/stdev plus min/p25/p75/max per metric — generate the column lists so the
  // INSERT, VALUES, and DO UPDATE clauses can't drift apart.
  const statCols = [];
  for (const metric of ['download', 'upload', 'ping']) {
    for (const stat of ['avg', 'median', 'stdev', 'min', 'p25', 'p75', 'max']) {
      statCols.push(`${metric}_${stat}`);
    }
  }
  statCols.push('packet_loss_avg', 'bytes_total');
  const cols = ['period_type', 'period_key', 'period_start', 'period_end', 'count', ...statCols];
  const updates = ['period_start', 'period_end', 'count', ...statCols]
    .map(c => `${c} = excluded.${c}`).join(', ');
  getDb().prepare(`
    INSERT INTO snapshots (${cols.join(', ')})
    VALUES (${cols.map(c => '@' + c).join(', ')})
    ON CONFLICT(period_type, period_key) DO UPDATE SET
      ${updates},
      created_at = datetime('now')
  `).run(s);
}

function getSnapshot(periodType, periodKey) {
  return getDb()
    .prepare('SELECT * FROM snapshots WHERE period_type = ? AND period_key = ?')
    .get(periodType, periodKey) || null;
}

function getSnapshots(periodType, { startKey, endKey } = {}) {
  let sql = 'SELECT * FROM snapshots WHERE period_type = ?';
  const params = [periodType];
  if (startKey) { sql += ' AND period_key >= ?'; params.push(startKey); }
  if (endKey)   { sql += ' AND period_key <= ?'; params.push(endKey); }
  sql += ' ORDER BY period_key';
  return getDb().prepare(sql).all(...params);
}

function getDbSize() {
  const result = getDb().prepare("SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()").get();
  return result ? result.size : 0;
}

function getSetting(key) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  getDb().prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

function buildTimeFilter(range) {
  const filters = {
    '1h':  "WHERE timestamp >= datetime('now', '-1 hour')",
    '6h':  "WHERE timestamp >= datetime('now', '-6 hours')",
    '24h': "WHERE timestamp >= datetime('now', '-24 hours')",
    '7d':  "WHERE timestamp >= datetime('now', '-7 days')",
    '30d': "WHERE timestamp >= datetime('now', '-30 days')",
    'all': 'WHERE 1=1',
  };
  return filters[range] || filters['24h'];
}

module.exports = {
  insertLog, getLogs, getLatest, getStats, getAnalytics, getDbSize, getSetting, setSetting, closeDb,
  statsBetween, getMinTimestamp, upsertSnapshot, getSnapshot, getSnapshots, getDailyStats,
  getTestsBetween,
};
