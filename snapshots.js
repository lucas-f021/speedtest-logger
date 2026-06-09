// Weekly + monthly rollups of speed_logs.
//
// A "snapshot" is the avg/median/stdev of download/upload/ping over one completed
// ISO week (Monday-start, UTC) or one calendar month. Snapshots are derived from
// speed_logs, so they're recomputable: backfillSnapshots() (re)builds every completed
// period from existing data and is safe to run repeatedly (idempotent upsert). The
// in-progress period is never persisted as final — getTrends() computes it live so the
// Trends view is always current.
//
// All period math is done in UTC to match how timestamps are stored (db.js / server.js).

const { statsBetween, getMinTimestamp, upsertSnapshot, getSnapshot } = require('./db');

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// --- UTC period helpers ---

// SQLite-friendly UTC string: 'YYYY-MM-DD HH:MM:SS' (matches executeTest()/buildTimeFilter()).
function toSqlUtc(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

// Parse a stored 'YYYY-MM-DD HH:MM:SS' UTC string into a Date.
function parseSqlUtc(s) {
  return new Date(s.replace(' ', 'T') + 'Z');
}

// Midnight (UTC) of the Monday that starts the ISO week containing `date`.
function weekStart(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum);
  return d;
}

// ISO week-numbering year + week number for the week containing `date`.
function isoWeekParts(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // Thursday of this week decides the year
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const ftDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ftDayNum + 3);
  const week = 1 + Math.round((d - firstThursday) / (7 * 86400000));
  return { isoYear, week };
}

function weekPeriod(date) {
  const start = weekStart(date);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 7);
  const { isoYear, week } = isoWeekParts(start);
  return {
    type: 'week',
    key: `${isoYear}-W${String(week).padStart(2, '0')}`,
    label: `${MONTH_NAMES[start.getUTCMonth()]} ${start.getUTCDate()}`,
    start,
    end,
  };
}

function monthPeriod(date) {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  return {
    type: 'month',
    key: `${y}-${String(m + 1).padStart(2, '0')}`,
    label: `${MONTH_NAMES[m]} '${String(y).slice(-2)}`,
    start: new Date(Date.UTC(y, m, 1)),
    end: new Date(Date.UTC(y, m + 1, 1)),
  };
}

function nextMonth(start) {
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
}

function addWeek(date) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + 7);
  return d;
}

// --- Shaping ---

function snapToStats(s) {
  return {
    count: s.count,
    download: { avg: s.download_avg, median: s.download_median, stdev: s.download_stdev },
    upload: { avg: s.upload_avg, median: s.upload_median, stdev: s.upload_stdev },
    ping: { avg: s.ping_avg, median: s.ping_median, stdev: s.ping_stdev },
  };
}

function snapshotRow(p, stats) {
  return {
    period_type: p.type,
    period_key: p.key,
    period_start: toSqlUtc(p.start),
    period_end: toSqlUtc(p.end),
    count: stats.count,
    download_avg: stats.download.avg, download_median: stats.download.median, download_stdev: stats.download.stdev,
    upload_avg: stats.upload.avg, upload_median: stats.upload.median, upload_stdev: stats.upload.stdev,
    ping_avg: stats.ping.avg, ping_median: stats.ping.median, ping_stdev: stats.ping.stdev,
  };
}

// --- Backfill ---

// List every completed period (week|month) from the first data point up to — but not
// including — the in-progress one containing `now`.
function listCompletedPeriods(periodType, since, now) {
  const periods = [];
  if (periodType === 'month') {
    const currentStart = monthPeriod(now).start;
    let p = monthPeriod(since);
    while (p.start < currentStart) {
      periods.push(p);
      p = monthPeriod(nextMonth(p.start));
    }
  } else {
    const currentStart = weekPeriod(now).start;
    let p = weekPeriod(since);
    while (p.start < currentStart) {
      periods.push(p);
      p = weekPeriod(addWeek(p.start));
    }
  }
  return periods;
}

// Recompute and persist every completed week + month that has data. Idempotent.
function backfillSnapshots() {
  const minTs = getMinTimestamp();
  if (!minTs) return { weeks: 0, months: 0 };
  const since = parseSqlUtc(minTs);
  const now = new Date();

  let weeks = 0, months = 0;
  for (const p of listCompletedPeriods('week', since, now)) {
    const stats = statsBetween(toSqlUtc(p.start), toSqlUtc(p.end));
    if (stats.count) { upsertSnapshot(snapshotRow(p, stats)); weeks++; }
  }
  for (const p of listCompletedPeriods('month', since, now)) {
    const stats = statsBetween(toSqlUtc(p.start), toSqlUtc(p.end));
    if (stats.count) { upsertSnapshot(snapshotRow(p, stats)); months++; }
  }
  console.log(`[${new Date().toISOString()}] Snapshots: backfilled ${weeks} weeks, ${months} months`);
  return { weeks, months };
}

// --- Trends (read path for GET /api/trends) ---

// Build a display row for one period: use the persisted snapshot for completed periods,
// compute live for the in-progress period (and as a fallback if no snapshot exists yet).
function buildRow(p, now) {
  const isCurrent = now >= p.start && now < p.end;
  let stats;
  if (isCurrent) {
    stats = statsBetween(toSqlUtc(p.start), toSqlUtc(p.end));
  } else {
    const snap = getSnapshot(p.type, p.key);
    stats = snap ? snapToStats(snap) : statsBetween(toSqlUtc(p.start), toSqlUtc(p.end));
  }
  return {
    key: p.key,
    label: p.label,
    start: toSqlUtc(p.start),
    end: toSqlUtc(p.end),
    count: stats.count,
    partial: isCurrent,
    download: stats.download,
    upload: stats.upload,
    ping: stats.ping,
  };
}

// Trailing 12 months (incl. current), oldest→newest. Leading empty months are dropped.
function monthTrends() {
  const minTs = getMinTimestamp();
  if (!minTs) return { period: 'month', rows: [] };
  const now = new Date();
  const firstStart = monthPeriod(parseSqlUtc(minTs)).start;
  const currentStart = monthPeriod(now).start;
  const elevenBack = new Date(Date.UTC(currentStart.getUTCFullYear(), currentStart.getUTCMonth() - 11, 1));
  let cursor = firstStart > elevenBack ? firstStart : elevenBack;

  const rows = [];
  while (cursor <= currentStart) {
    rows.push(buildRow(monthPeriod(cursor), now));
    cursor = nextMonth(cursor);
  }
  return { period: 'month', rows: rows.filter(r => r.count > 0 || r.partial) };
}

// The ISO weeks whose Monday falls inside month `within` ('YYYY-MM'), oldest→newest.
// Future weeks (start after now) are omitted; the in-progress week is flagged partial.
function weekTrends(within) {
  if (!within || !/^\d{4}-\d{2}$/.test(within)) return { period: 'week', within, rows: [] };
  const [y, m] = within.split('-').map(Number);
  const monthStart = new Date(Date.UTC(y, m - 1, 1));
  const monthEnd = new Date(Date.UTC(y, m, 1));
  const now = new Date();

  let cursor = weekStart(monthStart);
  while (cursor < monthStart) cursor = addWeek(cursor); // first Monday on/after the 1st

  const rows = [];
  while (cursor < monthEnd) {
    const p = weekPeriod(cursor);
    if (p.start <= now) rows.push(buildRow(p, now));
    cursor = addWeek(cursor);
  }
  // Drop empty weeks (e.g. before data collection started); keep the in-progress one.
  return { period: 'week', within, rows: rows.filter(r => r.count > 0 || r.partial) };
}

function getTrends({ period = 'month', within = null } = {}) {
  return period === 'week' ? weekTrends(within) : monthTrends();
}

module.exports = { backfillSnapshots, getTrends };
