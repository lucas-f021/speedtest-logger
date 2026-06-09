// Trends page: persisted weekly/monthly rollups from GET /api/trends.
// Monthly overview by default; click a month to drill into that month's weeks.

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const COLORS = {
  download: '#38bdf8', // --accent-blue
  upload: '#34d399',   // --accent-green
  ping: '#fb923c',     // --accent-orange
  band: 'rgba(56,189,248,0.12)',
  grid: '#1e2130',
  muted: '#7c8498',
};

const METRICS = [
  { key: 'download', label: 'Download (Mbps)', unit: 'Mbps', axis: 'ySpeed' },
  { key: 'upload', label: 'Upload (Mbps)', unit: 'Mbps', axis: 'ySpeed' },
  { key: 'ping', label: 'Ping (ms)', unit: 'ms', axis: 'yPing' },
];

let view = { period: 'month', within: null };
let currentRows = [];
let trendsChart = null;

document.addEventListener('DOMContentLoaded', loadTrends);

async function loadTrends() {
  const qs = view.period === 'week'
    ? `?period=week&within=${encodeURIComponent(view.within)}`
    : '?period=month';
  try {
    const res = await fetch('/api/trends' + qs);
    const data = await res.json();
    currentRows = data.rows || [];
    renderBreadcrumb(data);
    renderHint();
    renderChart(currentRows);
    renderTable(currentRows);
  } catch (_) {
    showToast('Could not load trends', 'error');
  }
}

// --- Breadcrumb + hint ---

function monthLabelFromKey(key) {
  const [y, m] = key.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

function renderBreadcrumb(data) {
  const el = document.getElementById('breadcrumb');
  if (data.period === 'week') {
    el.innerHTML = `<a id="crumb-back">Months</a><span class="crumb-sep">▸</span><span class="crumb-current">${escHtml(monthLabelFromKey(data.within))}</span>`;
    document.getElementById('crumb-back').addEventListener('click', () => {
      view = { period: 'month', within: null };
      loadTrends();
    });
  } else {
    el.innerHTML = `<span class="crumb-current">Months</span>`;
  }
}

function renderHint() {
  const el = document.getElementById('trends-hint');
  el.textContent = view.period === 'month'
    ? 'Click a month to drill into its weeks.'
    : 'Weekly breakdown · use “Months” above to go back.';
}

// --- Chart ---

const round2 = (n) => Math.round(n * 100) / 100;

function lineDataset(metric) {
  const color = COLORS[metric.key];
  const partial = currentRows.map(r => r.partial);
  return {
    label: metric.label,
    metricKey: metric.key,
    data: currentRows.map(r => r[metric.key].avg),
    borderColor: color,
    backgroundColor: color,
    yAxisID: metric.axis,
    tension: 0.3,
    borderDash: metric.key === 'ping' ? [4, 3] : undefined,
    pointRadius: currentRows.map(r => (r[metric.key].avg == null ? 0 : (r.partial ? 5 : 3))),
    pointBackgroundColor: currentRows.map(r => (r.partial ? 'transparent' : color)),
    fill: false,
    // Dash the final segment leading into the in-progress period.
    segment: metric.key === 'ping' ? undefined : {
      borderDash: (ctx) => (partial[ctx.p1DataIndex] ? [6, 4] : undefined),
    },
  };
}

function bandDatasets() {
  const lower = currentRows.map(r => {
    const m = r.download;
    return (m.avg != null && m.stdev != null) ? round2(m.avg - m.stdev) : null;
  });
  const upper = currentRows.map(r => {
    const m = r.download;
    return (m.avg != null && m.stdev != null) ? round2(m.avg + m.stdev) : null;
  });
  const base = { yAxisID: 'ySpeed', pointRadius: 0, borderColor: 'transparent', tension: 0.3, band: true };
  return [
    { ...base, label: 'dl-lower', data: lower, fill: false },
    { ...base, label: '↓ ±sd', data: upper, backgroundColor: COLORS.band, fill: '-1' },
  ];
}

function renderChart(rows) {
  const ctx = document.getElementById('trends-chart').getContext('2d');
  if (trendsChart) { trendsChart.destroy(); trendsChart = null; }
  if (!rows.length) return;

  trendsChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: rows.map(r => r.label),
      datasets: [...bandDatasets(), ...METRICS.map(lineDataset)],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      onHover: (e, els) => {
        e.native.target.style.cursor = (view.period === 'month' && els.length) ? 'pointer' : 'default';
      },
      onClick: (e, els) => {
        if (view.period !== 'month' || !els.length) return;
        const row = currentRows[els[0].index];
        if (row) { view = { period: 'week', within: row.key }; loadTrends(); }
      },
      plugins: {
        legend: {
          labels: {
            color: COLORS.muted,
            boxWidth: 12,
            font: { size: 12 },
            filter: (item, data) => !data.datasets[item.datasetIndex].band,
          },
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
          filter: (item) => !item.dataset.band,
          callbacks: {
            title: (items) => {
              const row = currentRows[items[0].dataIndex];
              return `${row.label}${row.partial ? ' · in progress' : ''} · n ${row.count}`;
            },
            labelColor: (c) => ({
              borderColor: c.dataset.borderColor,
              backgroundColor: c.dataset.borderColor,
              borderWidth: 2,
              borderRadius: 2,
            }),
            label: (c) => {
              const row = currentRows[c.dataIndex];
              const m = row[c.dataset.metricKey];
              const unit = c.dataset.metricKey === 'ping' ? 'ms' : 'Mbps';
              if (m.avg == null) return `${c.dataset.label}: —`;
              return `${c.dataset.label}: ${m.avg} ${unit}  (med ${fmt(m.median)}, sd ${fmt(m.stdev)})`;
            },
          },
        },
      },
      scales: {
        x: {
          grid: { color: COLORS.grid },
          ticks: { color: COLORS.muted, maxRotation: 0, autoSkip: true },
        },
        ySpeed: {
          position: 'left',
          grid: { color: COLORS.grid },
          ticks: { color: COLORS.muted },
          title: { display: true, text: 'Mbps', color: COLORS.muted, font: { size: 11 } },
        },
        yPing: {
          position: 'right',
          grid: { drawOnChartArea: false },
          ticks: { color: COLORS.muted },
          title: { display: true, text: 'Ping (ms)', color: COLORS.muted, font: { size: 11 } },
        },
      },
    },
  });
}

// --- Table ---

const THEAD = `
  <tr>
    <th>Period</th><th>n</th>
    <th>↓ avg</th><th>↓ med</th><th>↓ sd</th>
    <th>↑ avg</th><th>↑ med</th><th>↑ sd</th>
    <th>ping avg</th><th>ping med</th><th>ping sd</th>
  </tr>`;

function renderTable(rows) {
  document.getElementById('trends-thead').innerHTML = THEAD;
  const tbody = document.getElementById('trends-tbody');

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="11" class="empty-state">No snapshots yet</td></tr>';
    return;
  }

  const drillable = view.period === 'month';
  tbody.innerHTML = rows.map(r => `
    <tr class="${r.partial ? 'trend-partial' : ''} ${drillable ? 'drillable' : ''}" data-key="${escHtml(r.key)}">
      <td>${escHtml(r.label)}${r.partial ? ' <span class="partial-tag">live</span>' : ''}</td>
      <td>${r.count}</td>
      <td>${fmt(r.download.avg)}</td><td>${fmt(r.download.median)}</td><td>${fmt(r.download.stdev)}</td>
      <td>${fmt(r.upload.avg)}</td><td>${fmt(r.upload.median)}</td><td>${fmt(r.upload.stdev)}</td>
      <td>${fmt(r.ping.avg)}</td><td>${fmt(r.ping.median)}</td><td>${fmt(r.ping.stdev)}</td>
    </tr>`).join('');

  if (drillable) {
    tbody.querySelectorAll('tr.drillable').forEach(tr => {
      tr.addEventListener('click', () => {
        view = { period: 'week', within: tr.dataset.key };
        loadTrends();
      });
    });
  }
}

// --- Helpers ---

function fmt(n) {
  return n == null ? '—' : (Math.round(n * 10) / 10).toFixed(1);
}

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
