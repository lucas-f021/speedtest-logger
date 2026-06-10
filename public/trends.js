// Trends page: month-centric report fed by GET /api/month (picker list comes from
// GET /api/trends?period=month). Left column: the selected month's stat panel + a month
// picker. Right: one stat box per ISO week of that month (upcoming weeks are placeholders).
// Every box shows the same stat block plus a dot strip — one dot per test (hover for the
// exact value/time), a median tick, and one shared x-scale across the whole page.

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

let months = [];      // picker rows (oldest→newest, from /api/trends)
let selected = null;  // 'YYYY-MM'
let scaleMax = 100;   // shared dot-strip x-scale (Mbps), derived from the month's tests

document.addEventListener('DOMContentLoaded', init);

async function init() {
  try {
    const res = await fetch('/api/trends?period=month');
    const data = await res.json();
    months = data.rows || [];
    if (!months.length) {
      document.getElementById('month-panel').innerHTML =
        '<div class="statbox"><div class="sb-upcoming">No data yet — run a few tests first.</div></div>';
      return;
    }
    selected = months[months.length - 1].key; // default: the current (newest) month
    renderPicker();
    await loadMonth();
  } catch (_) {
    showToast('Could not load months', 'error');
  }
}

async function loadMonth() {
  try {
    const res = await fetch(`/api/month?within=${encodeURIComponent(selected)}`);
    const report = await res.json();
    const values = (report.month.points || []).map(p => p.download).filter(v => v != null);
    scaleMax = niceCeil(values.length ? Math.max(...values) : 100);
    renderMonthPanel(report.month);
    renderWeeks(report.weeks);
    document.getElementById('report-title').textContent = monthLabelFromKey(selected);
  } catch (_) {
    showToast('Could not load month report', 'error');
  }
}

// --- Month picker ---

function monthLabelFromKey(key) {
  const [y, m] = key.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

function renderPicker() {
  const el = document.getElementById('month-list');
  el.innerHTML = months.map(r => `
    <button class="month-item ${r.key === selected ? 'active' : ''}" data-key="${escHtml(r.key)}">
      <span>${escHtml(r.label)}</span>
      ${r.partial ? '<span class="partial-tag">live</span>' : ''}
      <span class="mi-n">n ${r.count}</span>
    </button>`).join('');
  el.querySelectorAll('.month-item').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.key === selected) return;
      selected = btn.dataset.key;
      renderPicker();
      loadMonth();
    });
  });
}

// --- Stat boxes ---

const fmt1 = (n) => n == null ? '—' : (Math.round(n * 10) / 10).toFixed(1);

function niceCeil(v) {
  if (v <= 100) return 100;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  return Math.ceil(v / mag) * mag;
}

function fmtBytes(bytes) {
  if (!bytes) return '—';
  const gb = bytes / 1e9;
  return gb >= 1 ? gb.toFixed(2) + ' GB' : (bytes / 1e6).toFixed(0) + ' MB';
}

// 'Jun 1–7' (or 'Jun 29 – Jul 5' across a month boundary); end is exclusive in the API.
function rangeLabel(row) {
  const s = new Date(row.start + 'Z');
  const e = new Date(new Date(row.end + 'Z') - 86400000);
  const sM = MONTH_NAMES[s.getUTCMonth()], eM = MONTH_NAMES[e.getUTCMonth()];
  return sM === eM
    ? `${sM} ${s.getUTCDate()}–${e.getUTCDate()}`
    : `${sM} ${s.getUTCDate()} – ${eM} ${e.getUTCDate()}`;
}

// One dot per test along a 0→scaleMax Mbps axis, with deterministic vertical jitter and
// a median tick. Native <title> tooltips carry the exact value + local time.
function dotStrip(points, median) {
  const W = 240, H = 40, left = 8, right = 8, axisY = 34;
  const x = (v) => left + (Math.min(v, scaleMax) / scaleMax) * (W - left - right);
  const dots = (points || []).filter(p => p.download != null).map((p, i) => {
    const jitter = ((i * 2654435761) % 13) - 6;
    const when = new Date(p.timestamp + 'Z').toLocaleString();
    return `<circle cx="${x(p.download).toFixed(1)}" cy="${20 + jitter}" r="3"><title>${p.download} Mbps · ${escHtml(when)}</title></circle>`;
  }).join('');
  const med = median != null
    ? `<line class="strip-median" x1="${x(median).toFixed(1)}" y1="7" x2="${x(median).toFixed(1)}" y2="32"><title>median ${fmt1(median)} Mbps</title></line>`
    : '';
  return `
    <svg class="dot-strip" viewBox="0 0 ${W} ${H}" role="img" aria-label="Dot strip of test results">
      <line class="strip-axis" x1="${left}" y1="${axisY}" x2="${W - right}" y2="${axisY}"/>
      <text x="${left}" y="${H - 1}">0</text>
      <text x="${W - right}" y="${H - 1}" text-anchor="end">${scaleMax.toLocaleString()}</text>
      ${dots}${med}
    </svg>`;
}

function statRows(row) {
  const d = row.download, u = row.upload, p = row.ping;
  return `
    <div class="sb-grid">
      <span class="sb-k">median</span><span class="sb-v">${fmt1(d.median)}</span>
      <span class="sb-k">sd</span><span class="sb-v">${fmt1(d.stdev)}</span>
      <span class="sb-k">min · max</span><span class="sb-v">${fmt1(d.min)} · ${fmt1(d.max)}</span>
      <span class="sb-k">↑ upload</span><span class="sb-v">${fmt1(u.avg)} <span class="sb-sub">med ${fmt1(u.median)}</span></span>
      <span class="sb-k">ping</span><span class="sb-v">${fmt1(p.avg)} ms <span class="sb-sub">med ${fmt1(p.median)}</span></span>
      <span class="sb-k">loss</span><span class="sb-v">${row.packet_loss_avg != null ? row.packet_loss_avg + '%' : '—'}</span>
      <span class="sb-k">data</span><span class="sb-v">${fmtBytes(row.bytes_total)}</span>
    </div>`;
}

function renderMonthPanel(month) {
  const title = `${escHtml(month.label)}${month.partial ? ' · to date' : ''}`;
  document.getElementById('month-panel').innerHTML = `
    <div class="statbox statbox-month ${month.partial ? 'statbox-live' : ''}">
      <div class="sb-head">
        <span class="sb-title">${title}</span>
        ${month.partial ? '<span class="partial-tag">live</span>' : ''}
        <span class="sb-n">n ${month.count}</span>
      </div>
      ${month.count ? `
        <div class="sb-big">${fmt1(month.download.avg)}<span class="sb-unit"> Mbps ↓ mean</span></div>
        ${dotStrip(month.points, month.download.median)}
        ${statRows(month)}
      ` : '<div class="sb-upcoming">no tests this month</div>'}
    </div>`;
}

function renderWeeks(weeks) {
  document.getElementById('week-grid').innerHTML = weeks.map(w => {
    const head = `
      <div class="sb-head">
        <span class="sb-title">Wk ${w.index}</span>
        <span class="sb-range">${rangeLabel(w)}</span>
        ${w.partial ? '<span class="partial-tag">live</span>' : ''}
        <span class="sb-n">${w.future ? '' : `n ${w.count}`}</span>
      </div>`;
    if (w.future) {
      return `<div class="statbox statbox-future">${head}<div class="sb-upcoming">upcoming</div></div>`;
    }
    if (!w.count) {
      return `<div class="statbox statbox-future">${head}<div class="sb-upcoming">no tests</div></div>`;
    }
    return `
      <div class="statbox ${w.partial ? 'statbox-live' : ''}">
        ${head}
        <div class="sb-big">${fmt1(w.download.avg)}<span class="sb-unit"> Mbps ↓ mean</span></div>
        ${dotStrip(w.points, w.download.median)}
        ${statRows(w)}
      </div>`;
  }).join('');
}

// --- Helpers ---

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

let toastTimer = null;
function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast ${type}`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = 'toast hidden'; }, 5000);
}
