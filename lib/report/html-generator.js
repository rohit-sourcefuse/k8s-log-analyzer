'use strict';

const fs = require('fs');
const { getCssStyles, renderIssueCard, renderRecommendation, renderStatCard, esc } = require('./templates');
const cb = require('./chart-builder');
const { formatTimestamp } = require('../utils/time-utils');

async function generateReport(data, outputPath) {
  const { manifestData, errorAnalysis, metricsAnalysis, dbAnalysis, issues, recommendations, stats } = data;

  const charts = {};
  if (errorAnalysis.categories.length > 0) {
    charts.errorDist = cb.buildErrorDistributionChart(errorAnalysis.categories);
  }
  if (errorAnalysis.timeline.length > 0) {
    charts.errorTimeline = cb.buildErrorTimelineChart(errorAnalysis.timeline, errorAnalysis.categories);
  }
  if (errorAnalysis.topPods.length > 0) {
    charts.podErrors = cb.buildPodErrorChart(errorAnalysis.topPods);
  }
  if (metricsAnalysis.nodeTrends.cpu.length > 0) {
    charts.nodeCpu = cb.buildNodeCpuChart(metricsAnalysis.nodeTrends);
  }
  if (metricsAnalysis.nodeTrends.memory.length > 0) {
    charts.nodeMemory = cb.buildNodeMemoryChart(metricsAnalysis.nodeTrends);
  }
  if (metricsAnalysis.hotPods.length > 0) {
    charts.hotPodCpu = cb.buildHotPodCpuChart(metricsAnalysis.podTrends, metricsAnalysis.hotPods);
  }
  if (metricsAnalysis.deploymentTimelines) {
    charts.scaling = cb.buildScalingChart(metricsAnalysis.deploymentTimelines);
  }
  if (dbAnalysis.timeline && dbAnalysis.timeline.length > 0) {
    charts.dbConns = cb.buildDbConnectionChart(dbAnalysis.timeline);
  }

  const topCategories = errorAnalysis.categories.slice(0, 4);
  const statCards = topCategories.map((c, i) => {
    const sev = c.severity >= 5 ? 'sev-critical' : c.severity >= 4 ? 'sev-high' : c.severity >= 3 ? 'sev-medium' : 'sev-low';
    return renderStatCard(c.count.toLocaleString(), c.name.replace(/_/g, ' '), sev);
  });
  while (statCards.length < 4) {
    statCards.push(renderStatCard('-', 'No data', 'sev-low'));
  }

  const issueCards = issues.map(i => renderIssueCard(i)).join('\n');
  const recCards = recommendations.map((r, i) => renderRecommendation(r, i)).join('\n');

  const chartCanvases = [];
  const chartInits = [];

  for (const [key, cfg] of Object.entries(charts)) {
    if (!cfg) continue;
    const canvasId = `chart-${key}`;
    const title = {
      errorDist: 'Error Distribution by Type',
      errorTimeline: 'Error Volume Over Time (5-min buckets)',
      podErrors: 'Log Lines by Pod (Top Services)',
      nodeCpu: 'Node CPU % Over Time',
      nodeMemory: 'Node Memory % Over Time',
      hotPodCpu: 'Hot Pods — CPU (millicores)',
      scaling: 'Deployment Replica Count Over Time',
      dbConns: 'Database Connections Over Time'
    }[key] || key;

    chartCanvases.push(`<div class="card" id="card-${key}"><h3>${esc(title)}</h3><div class="chart-container"><canvas id="${canvasId}"></canvas></div></div>`);
    chartInits.push(`new Chart(document.getElementById('${canvasId}'), ${JSON.stringify(cfg)});`);
  }

  const chartGrid = [];
  for (let i = 0; i < chartCanvases.length; i += 2) {
    const pair = chartCanvases.slice(i, i + 2);
    chartGrid.push(`<div class="grid grid-${pair.length}">${pair.join('\n')}</div>`);
  }

  const botTable = errorAnalysis.topBots.length > 0 ? `
    <div class="card" style="margin-bottom:20px;">
      <h3>Affected Bots / Entities</h3>
      <table>
        <tr><th>Bot ID</th><th>Error Count</th><th>Top Category</th><th>Pods</th></tr>
        ${errorAnalysis.topBots.slice(0, 10).map(b => {
          const topCat = Object.entries(b.categories).sort((a,c) => c[1]-a[1])[0];
          return `<tr><td><code>${esc(b.id)}</code></td><td>${b.count}</td><td>${topCat ? topCat[0].replace(/_/g,' ') : '-'}</td><td>${b.pods.length}</td></tr>`;
        }).join('\n')}
      </table>
    </div>` : '';

  const dbTable = dbAnalysis.connectionsByDatabase.length > 0 ? `
    <div class="card" style="margin-bottom:20px;">
      <h3>Database Connection Summary</h3>
      <table>
        <tr><th>Database</th><th>Avg Connections</th><th>Peak Connections</th></tr>
        ${dbAnalysis.connectionsByDatabase.map(d =>
          `<tr><td>${esc(d.database)}</td><td>${d.avgConnections}</td><td>${d.peakConnections}</td></tr>`
        ).join('\n')}
      </table>
      ${dbAnalysis.longRunningQueries.length > 0 ? `
        <h3 style="margin-top:16px;">Long Running Queries (>60s)</h3>
        <table>
          <tr><th>Duration</th><th>Database</th><th>Command</th><th>Query</th></tr>
          ${dbAnalysis.longRunningQueries.slice(0, 10).map(q =>
            `<tr><td>${q.duration}s</td><td>${esc(q.db)}</td><td>${esc(q.command)}</td><td><code>${esc(q.query || 'N/A')}</code></td></tr>`
          ).join('\n')}
        </table>` : ''}
    </div>` : '';

  const source = manifestData.source || 'unknown';
  const timeRange = stats.firstTimestamp && stats.lastTimestamp
    ? `${formatTimestamp(stats.firstTimestamp)} - ${formatTimestamp(stats.lastTimestamp)}`
    : 'N/A';

  // Build raw data for all time-series charts so filters can update them
  const rawNodeCpu = metricsAnalysis.nodeTrends.cpu.map(e => ({ timestamp: e.timestamp, nodes: e.nodes }));
  const rawNodeMemory = metricsAnalysis.nodeTrends.memory.map(e => ({ timestamp: e.timestamp, nodes: e.nodes }));

  const hotPodDeployments = metricsAnalysis.hotPods.slice(0, 5).map(h => h.deployment);
  const rawHotPodCpu = {};
  for (const depl of hotPodDeployments) {
    const points = (metricsAnalysis.podTrends.cpu[depl] || []);
    rawHotPodCpu[depl] = points.map(p => ({ timestamp: p.timestamp, value: p.value }));
  }

  const rawScaling = {};
  if (metricsAnalysis.deploymentTimelines) {
    for (const [name, points] of Object.entries(metricsAnalysis.deploymentTimelines)) {
      rawScaling[name] = points.map(p => ({ timestamp: p.timestamp, desired: p.desired }));
    }
  }

  const rawDbConns = (dbAnalysis.timeline || []).map(t => ({ timestamp: t.timestamp, total: t.total, active: t.active }));

  const reportData = {
    timeRange: { start: stats.firstTimestamp, end: stats.lastTimestamp },
    errorTimeline: errorAnalysis.timeline.map(t => ({ timestamp: t.timestamp, categories: t.categories })),
    categories: errorAnalysis.categories.map(c => ({ name: c.name, count: c.count })),
    nodeCpu: rawNodeCpu,
    nodeMemory: rawNodeMemory,
    hotPodCpu: rawHotPodCpu,
    hotPodDeployments: hotPodDeployments,
    scaling: rawScaling,
    dbConns: rawDbConns
  };

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>K8s Log Analysis Report</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
<style>${getCssStyles()}</style>
</head>
<body>
<h1>K8s Log Analysis Report</h1>
<p class="subtitle">Source: ${esc(source)} | Time: ${esc(timeRange)} | Lines: ${(stats.totalLines || 0).toLocaleString()} | Files: ${stats.fileCount || 0}</p>

<div class="filter-bar" style="flex-direction:column;align-items:stretch;">
  <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
    <label>Quick:</label>
    <button class="btn-secondary btn-quick" onclick="setQuickRange(15)" style="padding:5px 10px;font-size:0.78rem;">15m</button>
    <button class="btn-secondary btn-quick" onclick="setQuickRange(30)" style="padding:5px 10px;font-size:0.78rem;">30m</button>
    <button class="btn-secondary btn-quick" onclick="setQuickRange(60)" style="padding:5px 10px;font-size:0.78rem;">1h</button>
    <button class="btn-secondary btn-quick" onclick="setQuickRange(360)" style="padding:5px 10px;font-size:0.78rem;">6h</button>
    <button class="btn-secondary btn-quick" onclick="setQuickRange(1440)" style="padding:5px 10px;font-size:0.78rem;">24h</button>
    <button class="btn-secondary btn-quick" onclick="setQuickRange(2880)" style="padding:5px 10px;font-size:0.78rem;">2d</button>
    <button class="btn-secondary btn-quick" onclick="resetFilters()" style="padding:5px 10px;font-size:0.78rem;">All</button>
    <span class="filter-status" id="filter-status"></span>
    <span id="tz-label" style="margin-left:auto;font-size:0.78rem;color:var(--muted);"></span>
  </div>
  <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:8px;">
    <label>From:</label>
    <input type="datetime-local" id="filter-start" />
    <label>To:</label>
    <input type="datetime-local" id="filter-end" />
    <label>Severity:</label>
    <select id="filter-severity">
      <option value="all">All</option>
      <option value="critical">Critical</option>
      <option value="high">High</option>
      <option value="medium">Medium</option>
      <option value="low">Low</option>
    </select>
    <label>Category:</label>
    <select id="filter-category">
      <option value="all">All</option>
      ${errorAnalysis.categories.map(c => `<option value="${esc(c.name)}">${esc(c.name.replace(/_/g,' '))}</option>`).join('\n')}
    </select>
    <button class="btn-primary" onclick="applyFilters()">Apply Filters</button>
    <button class="btn-secondary" onclick="resetFilters()">Reset</button>
  </div>
</div>

<div class="section-title">Summary</div>
<div class="grid grid-4">${statCards.join('\n')}</div>

<div class="section-title">Issues (${issues.length} detected)</div>
<div id="issues-container" style="margin-bottom:24px;">${issueCards || '<p style="color:var(--muted)">No issues detected.</p>'}</div>

<div class="section-title">Recommendations</div>
<div id="recs-container" style="margin-bottom:24px;">${recCards || '<p style="color:var(--muted)">No recommendations.</p>'}</div>

<div class="section-title">Charts</div>
${chartGrid.join('\n')}

${botTable}
${dbTable}

<p style="text-align:center;color:var(--muted);font-size:0.8rem;padding:20px 0;">
  Generated by k8s-log-analyzer | ${new Date().toISOString()}
</p>

<script>
const REPORT_DATA = ${JSON.stringify(reportData)};
const COLORS = ['#f85149','#d29922','#e3b341','#3fb950','#58a6ff','#bc8cff','#f778ba','#22d3ee','#e879f9','#84cc16'];

const chartMap = {};
${chartInits.map((c, idx) => {
    const keys = Object.keys(charts);
    const key = keys[idx];
    return `chartMap['${key}'] = ${c}`;
  }).join('\n')}

// Detect and display local timezone
(function initFilters() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const offset = new Date().getTimezoneOffset();
    const sign = offset <= 0 ? '+' : '-';
    const absH = String(Math.floor(Math.abs(offset)/60)).padStart(2,'0');
    const absM = String(Math.abs(offset)%60).padStart(2,'0');
    document.getElementById('tz-label').textContent = tz + ' (UTC' + sign + absH + ':' + absM + ')';
  } catch(e) {}

  const s = REPORT_DATA.timeRange.start;
  const e = REPORT_DATA.timeRange.end;
  if (s) document.getElementById('filter-start').value = toLocalInput(new Date(s));
  if (e) document.getElementById('filter-end').value = toLocalInput(new Date(e));
})();

function toLocalInput(d) {
  return d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate())+'T'+p2(d.getHours())+':'+p2(d.getMinutes());
}
function p2(n){ return String(n).padStart(2,'0'); }
function fmtTime(ts) {
  const d = new Date(ts);
  return p2(d.getHours())+':'+p2(d.getMinutes());
}
function fmtTimeSec(ts) {
  const d = new Date(ts);
  return p2(d.getHours())+':'+p2(d.getMinutes())+':'+p2(d.getSeconds());
}

function getFilterRange() {
  const startVal = document.getElementById('filter-start').value;
  const endVal = document.getElementById('filter-end').value;
  return {
    startTs: startVal ? new Date(startVal).getTime() : null,
    endTs: endVal ? new Date(endVal).getTime() : null
  };
}

function inRange(ts, startTs, endTs) {
  if (startTs && ts < startTs) return false;
  if (endTs && ts > endTs) return false;
  return true;
}

function applyFilters() {
  const severity = document.getElementById('filter-severity').value;
  const category = document.getElementById('filter-category').value;
  const { startTs, endTs } = getFilterRange();

  // --- Filter issues by severity ---
  const boxes = document.querySelectorAll('.issue-box');
  let visibleIssues = 0;
  boxes.forEach(box => {
    const sev = box.getAttribute('data-severity');
    const sevMatch = severity === 'all' || sev === severity;
    box.style.display = sevMatch ? '' : 'none';
    if (sevMatch) visibleIssues++;
  });

  // --- Error Timeline (stacked bar) ---
  if (chartMap.errorTimeline) {
    const filtered = REPORT_DATA.errorTimeline.filter(t => inRange(t.timestamp, startTs, endTs));
    chartMap.errorTimeline.data.labels = filtered.map(t => fmtTime(t.timestamp));
    chartMap.errorTimeline.data.datasets.forEach(ds => {
      const catName = ds.label.replace(/ /g, '_');
      ds.data = filtered.map(t => t.categories[catName] || 0);
      ds.hidden = (category !== 'all') ? catName !== category : false;
    });
    chartMap.errorTimeline.update();
  }

  // --- Error Distribution (doughnut) - category highlight ---
  if (chartMap.errorDist) {
    if (category !== 'all') {
      chartMap.errorDist.data.datasets[0].backgroundColor = REPORT_DATA.categories.slice(0,10).map((c, i) =>
        c.name === category ? COLORS[i] : 'rgba(100,100,100,0.2)'
      );
    } else {
      chartMap.errorDist.data.datasets[0].backgroundColor = COLORS.slice(0, chartMap.errorDist.data.labels.length);
    }
    chartMap.errorDist.update();
  }

  // --- Node CPU (line) ---
  if (chartMap.nodeCpu && REPORT_DATA.nodeCpu.length > 0) {
    const filtered = REPORT_DATA.nodeCpu.filter(e => inRange(e.timestamp, startTs, endTs));
    chartMap.nodeCpu.data.labels = filtered.map(e => fmtTime(e.timestamp));
    const nodeNames = Object.keys(REPORT_DATA.nodeCpu[0].nodes);
    chartMap.nodeCpu.data.datasets.forEach((ds, i) => {
      const n = nodeNames[i];
      ds.data = filtered.map(e => e.nodes[n] || 0);
    });
    chartMap.nodeCpu.update();
  }

  // --- Node Memory (line) ---
  if (chartMap.nodeMemory && REPORT_DATA.nodeMemory.length > 0) {
    const filtered = REPORT_DATA.nodeMemory.filter(e => inRange(e.timestamp, startTs, endTs));
    chartMap.nodeMemory.data.labels = filtered.map(e => fmtTime(e.timestamp));
    const nodeNames = Object.keys(REPORT_DATA.nodeMemory[0].nodes);
    chartMap.nodeMemory.data.datasets.forEach((ds, i) => {
      const n = nodeNames[i];
      ds.data = filtered.map(e => e.nodes[n] || 0);
    });
    chartMap.nodeMemory.update();
  }

  // --- Hot Pod CPU (line) ---
  if (chartMap.hotPodCpu && REPORT_DATA.hotPodDeployments.length > 0) {
    const allTs = new Set();
    for (const depl of REPORT_DATA.hotPodDeployments) {
      for (const p of (REPORT_DATA.hotPodCpu[depl] || [])) {
        if (inRange(p.timestamp, startTs, endTs)) allTs.add(p.timestamp);
      }
    }
    const sortedTs = [...allTs].sort((a,b)=>a-b);
    chartMap.hotPodCpu.data.labels = sortedTs.map(ts => fmtTime(ts));
    chartMap.hotPodCpu.data.datasets.forEach((ds, i) => {
      const depl = REPORT_DATA.hotPodDeployments[i];
      const points = (REPORT_DATA.hotPodCpu[depl] || []).filter(p => inRange(p.timestamp, startTs, endTs));
      const byTs = {};
      for (const p of points) {
        if (!byTs[p.timestamp]) byTs[p.timestamp] = [];
        byTs[p.timestamp].push(p.value);
      }
      ds.data = sortedTs.map(ts => {
        const vals = byTs[ts];
        return vals ? Math.max(...vals) : null;
      });
    });
    chartMap.hotPodCpu.update();
  }

  // --- Scaling (line) ---
  if (chartMap.scaling && Object.keys(REPORT_DATA.scaling).length > 0) {
    const allTs = new Set();
    for (const points of Object.values(REPORT_DATA.scaling)) {
      for (const p of points) {
        if (inRange(p.timestamp, startTs, endTs)) allTs.add(p.timestamp);
      }
    }
    const sortedTs = [...allTs].sort((a,b)=>a-b);
    chartMap.scaling.data.labels = sortedTs.map(ts => fmtTime(ts));
    chartMap.scaling.data.datasets.forEach((ds, i) => {
      const name = Object.keys(REPORT_DATA.scaling)[i];
      const points = (REPORT_DATA.scaling[name] || []).filter(p => inRange(p.timestamp, startTs, endTs));
      const byTs = {};
      for (const p of points) byTs[p.timestamp] = p.desired;
      ds.data = sortedTs.map(ts => byTs[ts] ?? null);
    });
    chartMap.scaling.update();
  }

  // --- DB Connections (line) ---
  if (chartMap.dbConns && REPORT_DATA.dbConns.length > 0) {
    const filtered = REPORT_DATA.dbConns.filter(t => inRange(t.timestamp, startTs, endTs));
    const step = Math.max(1, Math.floor(filtered.length / 50));
    const sampled = filtered.filter((_, i) => i % step === 0);
    chartMap.dbConns.data.labels = sampled.map(t => fmtTimeSec(t.timestamp));
    chartMap.dbConns.data.datasets[0].data = sampled.map(t => t.total);
    chartMap.dbConns.data.datasets[1].data = sampled.map(t => t.active);
    chartMap.dbConns.update();
  }

  // --- Filter status ---
  const parts = [];
  if (severity !== 'all') parts.push(severity + ' severity');
  if (category !== 'all') parts.push(category.replace(/_/g,' '));
  if (startTs || endTs) parts.push('time range');
  const statusEl = document.getElementById('filter-status');
  if (parts.length > 0) {
    statusEl.textContent = 'Active: ' + parts.join(' + ') + ' (' + visibleIssues + ' issues)';
    statusEl.style.display = '';
  } else {
    statusEl.style.display = 'none';
  }
}

function resetFilters() {
  document.getElementById('filter-severity').value = 'all';
  document.getElementById('filter-category').value = 'all';
  const s = REPORT_DATA.timeRange.start;
  const e = REPORT_DATA.timeRange.end;
  if (s) document.getElementById('filter-start').value = toLocalInput(new Date(s));
  if (e) document.getElementById('filter-end').value = toLocalInput(new Date(e));

  document.querySelectorAll('.issue-box').forEach(box => box.style.display = '');
  document.getElementById('filter-status').style.display = 'none';

  // Reset all charts to full data
  applyFilters();
}

function setQuickRange(minutes) {
  const end = REPORT_DATA.timeRange.end;
  if (!end) return;
  const endDate = new Date(end);
  const startDate = new Date(endDate.getTime() - minutes * 60 * 1000);
  document.getElementById('filter-start').value = toLocalInput(startDate);
  document.getElementById('filter-end').value = toLocalInput(endDate);
  document.getElementById('filter-severity').value = 'all';
  document.getElementById('filter-category').value = 'all';
  applyFilters();
}
<\/script>
</body>
</html>`;

  fs.writeFileSync(outputPath, html, 'utf8');
}

module.exports = { generateReport };
