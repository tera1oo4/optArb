const REFRESH_MS = 2000;

function fmtTime(tsMs) {
  if (!tsMs) return '-';
  return new Date(tsMs).toLocaleTimeString();
}

function fmtNum(n) {
  if (n == null) return '-';
  const s = typeof n === 'string' ? n : n.toString();
  const num = Number(s);
  if (Number.isNaN(num)) return s;
  return num.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

async function fetchJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

function renderStatus(status, portfolio) {
  const badge = document.getElementById('overall-status');
  badge.textContent = status.status;
  badge.className = 'status-badge ' + status.status;

  const grid = document.getElementById('status-grid');
  const checks = status.checks || {};
  const lastScan = status.lastScanTs ? new Date(status.lastScanTs).toLocaleTimeString() : '-';

  const cards = [
    { label: 'overall', value: status.status },
    { label: 'venues', value: (status.venues || []).join(', ') },
    { label: 'last scan', value: lastScan },
    { label: 'instruments', value: status.instrumentCount ?? '-' },
    ...Object.entries(checks).map(([name, check]) => ({
      label: name,
      value: check.healthy ? 'ok' : check.message || 'fail',
    })),
  ];

  grid.innerHTML = cards
    .map(
      (c) => `
      <div class="card">
        <div class="label">${c.label}</div>
        <div class="value ${c.value === 'ok' ? 'healthy' : ''}">${c.value}</div>
      </div>`,
    )
    .join('');

  const portfolioEl = document.getElementById('portfolio');
  portfolioEl.textContent = portfolio
    ? JSON.stringify(portfolio, null, 2)
    : 'no portfolio data yet';
}

function renderSignals(signals) {
  const tbody = document.getElementById('signals-body');
  if (!signals || signals.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="muted">no signals yet</td></tr>';
    return;
  }

  tbody.innerHTML = signals
    .slice()
    .reverse()
    .map(
      (s) => `
      <tr>
        <td>${fmtTime(s.tsMs)}</td>
        <td>${s.kind}</td>
        <td title="${s.key}">${s.key}</td>
        <td>${s.buy ?? '-'}</td>
        <td>${s.sell ?? '-'}</td>
        <td>${fmtNum(s.spreadBps)}</td>
        <td>${fmtNum(s.sizeUsd)}</td>
      </tr>`,
    )
    .join('');
}

function renderLogs(logs) {
  const el = document.getElementById('logs');
  if (!logs || (!logs.stats && !logs.portfolioSummary)) {
    el.textContent = 'waiting for data...';
    return;
  }
  const parts = [];
  if (logs.stats) parts.push('stats: ' + JSON.stringify(logs.stats));
  if (logs.portfolioSummary) parts.push('portfolio: ' + JSON.stringify(logs.portfolioSummary));
  el.textContent = parts.join('\n');
}

async function refresh() {
  try {
    const [status, portfolio, signals, logs] = await Promise.all([
      fetchJson('/api/status'),
      fetchJson('/api/portfolio').catch(() => null),
      fetchJson('/api/signals').catch(() => ({ recent: [] })),
      fetchJson('/api/logs').catch(() => null),
    ]);
    renderStatus(status, portfolio);
    renderSignals(signals.recent);
    renderLogs(logs);
  } catch (err) {
    document.getElementById('overall-status').textContent = 'error';
    document.getElementById('overall-status').className = 'status-badge unhealthy';
    document.getElementById('status-grid').innerHTML =
      '<div class="card"><div class="label">fetch error</div><div class="value">' +
      err.message +
      '</div></div>';
  }
}

refresh();
setInterval(refresh, REFRESH_MS);
