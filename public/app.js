let currentRange = '24h';
let chart = null;

// --- Init ---

let serverOptions = [];

document.addEventListener('DOMContentLoaded', () => {
  loadAll();
  loadServerSelector();
  loadSchedule();
  setupScheduleSelector();
  setupRangeButtons();
  setupTestNowButton();
  loadVersion();
  setInterval(pollStatus, 5000);
});

function setupRangeButtons() {
  document.querySelectorAll('.range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentRange = btn.dataset.range;
      loadAll();
    });
  });
}

function setupTestNowButton() {
  document.getElementById('test-now-btn').addEventListener('click', async () => {
    const btn = document.getElementById('test-now-btn');
    const btnText = document.getElementById('btn-text');
    const spinner = document.getElementById('btn-spinner');

    btn.disabled = true;
    btnText.textContent = 'Testing…';
    spinner.classList.remove('hidden');
    setStatusRunning();

    try {
      const res = await fetch('/api/test', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        const r = data.result;
        showToast(`↓ ${r.download} Mbps  ↑ ${r.upload} Mbps  ping ${r.ping} ms`, 'success');
        loadAll();
      } else {
        showToast(data.error || 'Test failed', 'error');
      }
    } catch (err) {
      showToast('Could not reach server', 'error');
    } finally {
      btn.disabled = false;
      btnText.textContent = 'Test Now';
      spinner.classList.add('hidden');
      setStatusIdle();
    }
  });
}

// --- Server selector ---

async function loadServerSelector() {
  try {
    const res = await fetch('/api/server');
    const data = await res.json();
    serverOptions = data.options;
    renderServerOptions(data.options, data.selected);
    updateActiveServerLabel(data.selected);
  } catch (_) {}
}

function renderServerOptions(options, selected) {
  const container = document.getElementById('server-options');
  container.innerHTML = options.map(o => `
    <button class="server-option ${o.key === selected ? 'active' : ''}" data-key="${escHtml(o.key)}">
      <span class="server-radio"></span>
      <span class="server-info">
        <span class="server-name">${escHtml(o.name)}</span>
        <span class="server-loc">${escHtml(o.location)}</span>
      </span>
    </button>
  `).join('');
  container.querySelectorAll('.server-option').forEach(btn => {
    btn.addEventListener('click', () => selectServer(btn.dataset.key));
  });
}

async function selectServer(key) {
  try {
    const res = await fetch('/api/server', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selection: key }),
    });
    const data = await res.json();
    if (data.success) {
      renderServerOptions(serverOptions, data.selected);
      updateActiveServerLabel(data.selected);
      const opt = serverOptions.find(o => o.key === data.selected);
      const label = key === 'fastest' ? 'Fastest (auto-pick)' : `${opt.name} — ${opt.location}`;
      showToast(`Future tests will use: ${label}`, 'success');
    } else {
      showToast(data.error || 'Could not change server', 'error');
    }
  } catch (_) {
    showToast('Could not reach server', 'error');
  }
}

function updateActiveServerLabel(selected) {
  const el = document.getElementById('active-server');
  const opt = serverOptions.find(o => o.key === selected);
  if (!opt) { el.textContent = ''; return; }
  el.textContent = selected === 'fastest' ? 'via Fastest (auto)' : `via ${opt.name} — ${opt.location}`;
}

// --- Schedule selector ---

async function loadSchedule() {
  try {
    const res = await fetch('/api/schedule');
    const data = await res.json();
    const sel = document.getElementById('schedule-select');
    sel.innerHTML = data.options.map(o => `<option value="${escHtml(o.key)}">${escHtml(o.label)}</option>`).join('');
    sel.value = data.selected;
  } catch (_) {}
}

function setupScheduleSelector() {
  const sel = document.getElementById('schedule-select');
  sel.addEventListener('change', async () => {
    try {
      const res = await fetch('/api/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schedule: sel.value }),
      });
      const data = await res.json();
      if (data.success) {
        showToast(`Scheduled tests: ${sel.options[sel.selectedIndex].text}`, 'success');
      } else {
        showToast(data.error || 'Could not change schedule', 'error');
      }
    } catch (_) {
      showToast('Could not reach server', 'error');
    }
  });
}

// --- App version ---

async function loadVersion() {
  try {
    const res = await fetch('/api/version');
    const data = await res.json();
    const el = document.getElementById('app-version');
    if (el && data.version) el.textContent = `v${data.version}`;
  } catch (_) {}
}

// --- Data loading ---

async function loadAll() {
  await Promise.all([loadStats(), loadChart(), loadTable(), loadAnalytics()]);
}

async function loadStats() {
  try {
    const res = await fetch(`/api/stats?range=${currentRange}`);
    const s = await res.json();
    document.getElementById('stat-download').textContent = s.avgDownload ?? '—';
    document.getElementById('stat-upload').textContent = s.avgUpload ?? '—';
    document.getElementById('stat-ping').textContent = s.avgPing ?? '—';
    document.getElementById('stat-loss').textContent = s.avgPacketLoss ?? '—';
    renderDataUsed(s.bytesTotal);
    document.getElementById('stat-total').textContent = s.totalTests ?? '—';
  } catch (_) {}
}

// Total bytes used across the current range, shown in the friendliest unit (GB ≥ 1, else MB).
function renderDataUsed(bytesTotal) {
  const valEl = document.getElementById('stat-data');
  const unitEl = document.getElementById('stat-data-unit');
  if (!bytesTotal) { valEl.textContent = '—'; unitEl.textContent = 'GB'; return; }
  const gb = bytesTotal / 1e9;
  if (gb >= 1) { valEl.textContent = gb.toFixed(2); unitEl.textContent = 'GB'; }
  else { valEl.textContent = (bytesTotal / 1e6).toFixed(0); unitEl.textContent = 'MB'; }
}

// --- Sidebar analytics (rolling avg + median for 24h / 7d / 30d) ---

const ANALYTICS_WINDOWS = [
  { key: 'day',   label: 'Day',   sub: '24h' },
  { key: 'week',  label: 'Week',  sub: '7d'  },
  { key: 'month', label: 'Month', sub: '30d' },
];

const ANALYTICS_METRICS = [
  { key: 'download', label: '↓ Mbps' },
  { key: 'upload',   label: '↑ Mbps' },
  { key: 'ping',     label: 'ping ms' },
];

async function loadAnalytics() {
  try {
    const res = await fetch('/api/analytics');
    renderAnalytics(await res.json());
  } catch (_) {}
}

function fmtStat(n) {
  return n == null ? '—' : n.toFixed(1);
}

function renderAnalytics(data) {
  const container = document.getElementById('analytics');
  container.innerHTML = ANALYTICS_WINDOWS.map(w => {
    const win = data[w.key] || {};
    const rows = ANALYTICS_METRICS.map(m => {
      const stat = win[m.key] || {};
      return `
          <span class="aw-metric">${m.label}</span>
          <span class="aw-num">${fmtStat(stat.avg)}</span>
          <span class="aw-num">${fmtStat(stat.median)}</span>
          <span class="aw-num">${fmtStat(stat.stdev)}</span>`;
    }).join('');
    return `
      <div class="analytics-window">
        <div class="aw-head">
          <span class="aw-title">${w.label} · ${w.sub}</span>
          <span class="aw-count">n ${win.count ?? 0}</span>
        </div>
        <div class="aw-grid">
          <span></span>
          <span class="aw-col-h">avg</span>
          <span class="aw-col-h">med</span>
          <span class="aw-col-h">sd</span>${rows}
        </div>
      </div>`;
  }).join('');
}

async function loadChart() {
  try {
    const res = await fetch(`/api/logs?range=${currentRange}&limit=1000`);
    const { logs } = await res.json();
    renderChart(logs.reverse());
  } catch (_) {}
}

async function loadTable() {
  try {
    const res = await fetch(`/api/logs?range=${currentRange}&limit=500`);
    const { logs } = await res.json();
    renderTable(logs);
  } catch (_) {}
}

// --- Chart ---

function getRangeBounds(range) {
  const now = new Date();
  const offsets = { '1h': 3600e3, '6h': 6*3600e3, '24h': 24*3600e3, '7d': 7*86400e3, '30d': 30*86400e3 };
  return { min: offsets[range] ? new Date(now - offsets[range]) : undefined, max: now };
}

function getTimeAxis(range) {
  const cfg = {
    '1h':  { unit: 'minute', stepSize: 10 },
    '6h':  { unit: 'hour',   stepSize: 1  },
    '24h': { unit: 'hour',   stepSize: 4  },
    '7d':  { unit: 'day',    stepSize: 1  },
    '30d': { unit: 'day',    stepSize: 5  },
    'all': { unit: 'week',   stepSize: 1  },
  };
  const { unit, stepSize } = cfg[range] || cfg['24h'];
  return {
    time: {
      unit,
      stepSize,
      displayFormats: {
        minute: 'h:mm a',
        hour:   'h a',
        day:    'EEE M/d',
        week:   'MMM d',
      },
    },
  };
}

function medianOf(nums) {
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function renderChart(logs) {
  const labels = logs.map(l => new Date(l.timestamp + 'Z'));
  const downloads = logs.map(l => l.download);
  const uploads = logs.map(l => l.upload);
  const pings = logs.map(l => l.ping);

  // Horizontal reference lines: mean + median of the download values currently shown.
  const dlValues = downloads.filter(v => v != null);
  const meanDownload = dlValues.length ? dlValues.reduce((a, b) => a + b, 0) / dlValues.length : null;
  const medianDownload = medianOf(dlValues);

  const ctx = document.getElementById('speed-chart').getContext('2d');

  if (chart) {
    chart.destroy();
    chart = null;
  }

  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Download (Mbps)',
          data: downloads,
          borderColor: '#38bdf8',
          backgroundColor: 'rgba(56,189,248,0.08)',
          fill: true,
          tension: 0.3,
          pointRadius: logs.length > 50 ? 0 : 3,
          yAxisID: 'ySpeed',
        },
        {
          label: 'Upload (Mbps)',
          data: uploads,
          borderColor: '#34d399',
          backgroundColor: 'rgba(52,211,153,0.08)',
          fill: true,
          tension: 0.3,
          pointRadius: logs.length > 50 ? 0 : 3,
          yAxisID: 'ySpeed',
        },
        {
          label: 'Ping (ms)',
          data: pings,
          borderColor: '#fb923c',
          backgroundColor: 'transparent',
          fill: false,
          tension: 0.3,
          pointRadius: logs.length > 50 ? 0 : 3,
          borderDash: [4, 3],
          yAxisID: 'yPing',
        },
        {
          label: 'Avg ↓',
          data: labels.map(() => (meanDownload != null ? Math.round(meanDownload * 100) / 100 : null)),
          borderColor: 'rgba(56,189,248,0.65)',
          borderWidth: 1.5,
          borderDash: [8, 4],
          pointRadius: 0,
          fill: false,
          tension: 0,
          yAxisID: 'ySpeed',
        },
        {
          label: 'Median ↓',
          data: labels.map(() => (medianDownload != null ? Math.round(medianDownload * 100) / 100 : null)),
          borderColor: 'rgba(250,204,21,0.75)',
          borderWidth: 1.5,
          borderDash: [2, 3],
          pointRadius: 0,
          fill: false,
          tension: 0,
          yAxisID: 'ySpeed',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          labels: { color: '#7c8498', boxWidth: 12, font: { size: 12 } },
        },
        tooltip: {
          backgroundColor: '#1a1d26',
          borderColor: '#2a2d3e',
          borderWidth: 1,
          titleColor: '#e2e8f0',
          bodyColor: '#e2e8f0',
          padding: 12,
          boxWidth: 16,
          boxHeight: 16,
          boxPadding: 6,
          bodySpacing: 6,
          titleFont: { size: 13, weight: '600' },
          bodyFont: { size: 14 },
          callbacks: {
            title: (items) => new Date(items[0].parsed.x).toLocaleString(),
            // Fill the swatch with the actual line color (not the faint area fill).
            labelColor: (ctx) => ({
              borderColor: ctx.dataset.borderColor,
              backgroundColor: ctx.dataset.borderColor,
              borderWidth: 2,
              borderRadius: 2,
            }),
            // Show the line style next to each metric so same-color lines are distinguishable.
            label: (ctx) => {
              const dash = ctx.dataset.borderDash;
              const style = !dash || !dash.length
                ? 'solid'
                : (dash[0] >= 6 ? 'dashed' : (dash[0] <= 2 ? 'dotted' : 'dash-dot'));
              const v = ctx.parsed.y;
              return `${ctx.dataset.label} [${style}]: ${v == null ? '—' : v}`;
            },
          },
        },
      },
      scales: {
        x: {
          type: 'time',
          ...getRangeBounds(currentRange),
          ...getTimeAxis(currentRange),
          grid: { color: '#1e2130' },
          ticks: { color: '#7c8498', maxRotation: 0 },
        },
        ySpeed: {
          position: 'left',
          grid: { color: '#1e2130' },
          ticks: { color: '#7c8498' },
          title: { display: true, text: 'Mbps', color: '#7c8498', font: { size: 11 } },
        },
        yPing: {
          position: 'right',
          grid: { drawOnChartArea: false },
          ticks: { color: '#7c8498' },
          title: { display: true, text: 'Ping (ms)', color: '#7c8498', font: { size: 11 } },
        },
      },
    },
  });
}

// --- Table ---

function renderTable(logs) {
  const tbody = document.getElementById('log-tbody');
  if (!logs.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No data for this time range</td></tr>';
    return;
  }

  tbody.innerHTML = logs.map(l => `
    <tr>
      <td>${new Date(l.timestamp + 'Z').toLocaleString()}</td>
      <td>${l.download != null ? l.download + ' Mbps' : '—'}</td>
      <td>${l.upload != null ? l.upload + ' Mbps' : '—'}</td>
      <td>${l.ping != null ? l.ping + ' ms' : '—'}</td>
      <td>${l.packet_loss != null ? Number(l.packet_loss).toFixed(2) + '%' : '—'}</td>
      <td>${fmtTestData(l)}</td>
      <td title="${escHtml(serverTooltip(l))}">${escHtml(l.server_location || l.server_name || '—')}</td>
      <td><span class="badge badge-${l.source}">${l.source}</span></td>
    </tr>
  `).join('');
}

// Data used by this single test (download + upload bytes), in the friendliest unit.
function fmtTestData(l) {
  const bytes = (l.bytes_downloaded || 0) + (l.bytes_uploaded || 0);
  if (!bytes) return '—';
  const mb = bytes / 1e6;
  return mb >= 1000 ? (mb / 1000).toFixed(2) + ' GB' : mb.toFixed(0) + ' MB';
}

// Fold the stored-but-not-columned fields (external IP, VPN, full server identity)
// into the Server cell's hover tooltip so every captured field is visible somewhere.
function serverTooltip(l) {
  const parts = [];
  if (l.server_name) parts.push(l.server_name);
  if (l.server_host) parts.push(`host ${l.server_host}`);
  if (l.server_country) parts.push(l.server_country);
  if (l.server_ip) parts.push(`server IP ${l.server_ip}`);
  if (l.server_id) parts.push(`id ${l.server_id}`);
  if (l.external_ip) parts.push(`your IP ${l.external_ip}`);
  if (l.is_vpn) parts.push('over VPN');
  return parts.join(' · ') || 'No server detail';
}

// --- Status polling ---

async function pollStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    if (data.running) {
      setStatusRunning();
    } else {
      setStatusIdle();
    }
  } catch (_) {}
}

function setStatusIdle() {
  const el = document.getElementById('status-indicator');
  el.className = 'status-idle';
  el.title = 'Idle';
}

function setStatusRunning() {
  const el = document.getElementById('status-indicator');
  el.className = 'status-running';
  el.title = 'Test running…';
}

// --- Toast ---

let toastTimer = null;

function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast ${type}`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = 'toast hidden'; }, 5000);
}

// --- Helpers ---

function escHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
