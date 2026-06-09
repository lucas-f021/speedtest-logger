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
  }
  return db;
}

function insertLog(data) {
  const stmt = getDb().prepare(`
    INSERT INTO speed_logs (timestamp, download, upload, ping, jitter, server_name, server_location, isp, result_url, source)
    VALUES (@timestamp, @download, @upload, @ping, @jitter, @server_name, @server_location, @isp, @result_url, @source)
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

// Like windowStats() but for an explicit [startISO, endISO) window (UTC
// 'YYYY-MM-DD HH:MM:SS' strings). Used to roll up weekly/monthly snapshots.
function statsBetween(startISO, endISO) {
  const rows = getDb()
    .prepare('SELECT download, upload, ping FROM speed_logs WHERE timestamp >= ? AND timestamp < ?')
    .all(startISO, endISO);
  const col = (key) => rows.map(r => r[key]).filter(v => v != null);
  const dl = col('download'), up = col('upload'), pg = col('ping');
  return {
    count: dl.length,
    download: { avg: avg(dl), median: median(dl), stdev: stdev(dl) },
    upload: { avg: avg(up), median: median(up), stdev: stdev(up) },
    ping: { avg: avg(pg), median: median(pg), stdev: stdev(pg) },
  };
}

// --- Snapshot persistence (weekly/monthly rollups) ---

function getMinTimestamp() {
  const row = getDb().prepare('SELECT MIN(timestamp) AS min FROM speed_logs').get();
  return row && row.min ? row.min : null;
}

function upsertSnapshot(s) {
  getDb().prepare(`
    INSERT INTO snapshots
      (period_type, period_key, period_start, period_end, count,
       download_avg, download_median, download_stdev,
       upload_avg, upload_median, upload_stdev,
       ping_avg, ping_median, ping_stdev)
    VALUES
      (@period_type, @period_key, @period_start, @period_end, @count,
       @download_avg, @download_median, @download_stdev,
       @upload_avg, @upload_median, @upload_stdev,
       @ping_avg, @ping_median, @ping_stdev)
    ON CONFLICT(period_type, period_key) DO UPDATE SET
      period_start = excluded.period_start,
      period_end   = excluded.period_end,
      count        = excluded.count,
      download_avg = excluded.download_avg, download_median = excluded.download_median, download_stdev = excluded.download_stdev,
      upload_avg   = excluded.upload_avg,   upload_median   = excluded.upload_median,   upload_stdev   = excluded.upload_stdev,
      ping_avg     = excluded.ping_avg,     ping_median     = excluded.ping_median,     ping_stdev     = excluded.ping_stdev,
      created_at   = datetime('now')
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
  statsBetween, getMinTimestamp, upsertSnapshot, getSnapshot, getSnapshots,
};
