let currentRange = '24h';
let chart = null;

// --- Init ---

let serverOptions = [];

document.addEventListener('DOMContentLoaded', () => {
  loadAll();
  loadServerSelector();
  setupRangeButtons();
  setupTestNowButton();
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

// --- Data loading ---

async function loadAll() {
  await Promise.all([loadStats(), loadChart(), loadTable()]);
}

async function loadStats() {
  try {
    const res = await fetch(`/api/stats?range=${currentRange}`);
    const s = await res.json();
    document.getElementById('stat-download').textContent = s.avgDownload ?? '—';
    document.getElementById('stat-upload').textContent = s.avgUpload ?? '—';
    document.getElementById('stat-ping').textContent = s.avgPing ?? '—';
    document.getElementById('stat-total').textContent = s.totalTests ?? '—';
  } catch (_) {}
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

function renderChart(logs) {
  const labels = logs.map(l => new Date(l.timestamp + 'Z'));
  const downloads = logs.map(l => l.download);
  const uploads = logs.map(l => l.upload);
  const pings = logs.map(l => l.ping);

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
          bodyColor: '#7c8498',
          callbacks: {
            title: (items) => new Date(items[0].parsed.x).toLocaleString(),
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
          title: { display: true, text: 'Mbps / ms', color: '#7c8498', font: { size: 11 } },
        },
      },
    },
  });
}

// --- Table ---

function renderTable(logs) {
  const tbody = document.getElementById('log-tbody');
  if (!logs.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No data for this time range</td></tr>';
    return;
  }

  tbody.innerHTML = logs.map(l => `
    <tr>
      <td>${new Date(l.timestamp + 'Z').toLocaleString()}</td>
      <td>${l.download != null ? l.download + ' Mbps' : '—'}</td>
      <td>${l.upload != null ? l.upload + ' Mbps' : '—'}</td>
      <td>${l.ping != null ? l.ping + ' ms' : '—'}</td>
      <td>${escHtml(l.server_location || l.server_name || '—')}</td>
      <td><span class="badge badge-${l.source}">${l.source}</span></td>
    </tr>
  `).join('');
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
