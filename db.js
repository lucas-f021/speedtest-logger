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

module.exports = { insertLog, getLogs, getLatest, getStats, getAnalytics, getDbSize, getSetting, setSetting, closeDb };
