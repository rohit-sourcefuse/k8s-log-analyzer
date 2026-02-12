'use strict';

const fs = require('fs');
const path = require('path');
const { getCssStyles, renderIssueCard, renderRecommendation, renderStatCard, esc } = require('./templates');
const cb = require('./chart-builder');
const { formatTimestamp } = require('../utils/time-utils');

// Load Chart.js source for inline embedding (works on file:// protocol)
const CHARTJS_PATH = path.join(__dirname, 'chartjs.min.js');
let chartJsSource = '';
try {
  chartJsSource = fs.readFileSync(CHARTJS_PATH, 'utf8');
} catch (e) {
  console.warn('  Warning: chartjs.min.js not found, falling back to CDN (may not work on file://)');
}

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

  // --- Summary stat cards (with IDs so JS can update them) ---
  const topCategories = errorAnalysis.categories.slice(0, 4);
  const statCardsHtml = topCategories.map((c, i) => {
    const sev = c.severity >= 5 ? 'sev-critical' : c.severity >= 4 ? 'sev-high' : c.severity >= 3 ? 'sev-medium' : 'sev-low';
    return `
    <div class="card stat-card ${sev}" id="stat-card-${i}" data-category="${esc(c.name)}">
      <div class="value" id="stat-value-${i}">${c.count.toLocaleString()}</div>
      <div class="label">${esc(c.name.replace(/_/g, ' '))}</div>
    </div>`;
  });
  while (statCardsHtml.length < 4) {
    const idx = statCardsHtml.length;
    statCardsHtml.push(`
    <div class="card stat-card sev-low" id="stat-card-${idx}">
      <div class="value" id="stat-value-${idx}">-</div>
      <div class="label">No data</div>
    </div>`);
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
    chartInits.push(`chartMap['${key}'] = new Chart(document.getElementById('${canvasId}'), ${JSON.stringify(cfg)});`);
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

  // --- Build raw data for all time-series charts (client-side filtering) ---
  // ALL timestamps must be epoch milliseconds (numbers) for client-side comparison
  function toMs(ts) {
    if (typeof ts === 'number') return ts;
    if (ts instanceof Date) return ts.getTime();
    if (typeof ts === 'string') { const d = new Date(ts); return isNaN(d.getTime()) ? 0 : d.getTime(); }
    return 0;
  }

  const rawNodeCpu = metricsAnalysis.nodeTrends.cpu.map(e => ({ timestamp: toMs(e.timestamp), nodes: e.nodes }));
  const rawNodeMemory = metricsAnalysis.nodeTrends.memory.map(e => ({ timestamp: toMs(e.timestamp), nodes: e.nodes }));

  const hotPodDeployments = metricsAnalysis.hotPods.slice(0, 5).map(h => h.deployment);
  const rawHotPodCpu = {};
  for (const depl of hotPodDeployments) {
    const points = (metricsAnalysis.podTrends.cpu[depl] || []);
    rawHotPodCpu[depl] = points.map(p => ({ timestamp: toMs(p.timestamp), value: p.value }));
  }

  const rawScaling = {};
  if (metricsAnalysis.deploymentTimelines) {
    for (const [name, points] of Object.entries(metricsAnalysis.deploymentTimelines)) {
      rawScaling[name] = points.map(p => ({ timestamp: toMs(p.timestamp), desired: p.desired }));
    }
  }

  const rawDbConns = (dbAnalysis.timeline || []).map(t => ({ timestamp: toMs(t.timestamp), total: t.total, active: t.active }));

  // Embed category full data so stat cards can recompute per time range
  const categoriesWithEvents = errorAnalysis.categories.map(c => ({
    name: c.name, count: c.count, severity: c.severity
  }));

  const reportData = {
    timeRange: { start: toMs(stats.firstTimestamp), end: toMs(stats.lastTimestamp) },
    totalLines: stats.totalLines || 0,
    fileCount: stats.fileCount || 0,
    errorTimeline: errorAnalysis.timeline.map(t => ({ timestamp: toMs(t.timestamp), categories: t.categories })).filter(t => t.timestamp > 0),
    categories: categoriesWithEvents,
    nodeCpu: rawNodeCpu,
    nodeMemory: rawNodeMemory,
    hotPodCpu: rawHotPodCpu,
    hotPodDeployments: hotPodDeployments,
    scaling: rawScaling,
    dbConns: rawDbConns,
    issueCount: issues.length
  };

  // Chart.js: embed inline or fallback to CDN
  const chartJsTag = chartJsSource
    ? `<script>${chartJsSource}<\/script>`
    : `<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>K8s Log Analysis Report</title>
${chartJsTag}
<style>${getCssStyles()}</style>
</head>
<body>
<h1>K8s Log Analysis Report</h1>
<p class="subtitle" id="report-subtitle">Source: ${esc(source)} | Time: <span id="subtitle-time">${esc(timeRange)}</span> | Lines: ${(stats.totalLines || 0).toLocaleString()} | Files: ${stats.fileCount || 0}</p>

<div class="filter-bar" style="flex-direction:column;align-items:stretch;">
  <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
    <label>Quick:</label>
    <button class="btn-secondary btn-quick" onclick="setQuickRange(15)" style="padding:5px 10px;font-size:0.78rem;">15m</button>
    <button class="btn-secondary btn-quick" onclick="setQuickRange(30)" style="padding:5px 10px;font-size:0.78rem;">30m</button>
    <button class="btn-secondary btn-quick" onclick="setQuickRange(60)" style="padding:5px 10px;font-size:0.78rem;">1h</button>
    <button class="btn-secondary btn-quick" onclick="setQuickRange(360)" style="padding:5px 10px;font-size:0.78rem;">6h</button>
    <button class="btn-secondary btn-quick" onclick="setQuickRange(1440)" style="padding:5px 10px;font-size:0.78rem;">24h</button>
    <button class="btn-secondary btn-quick" onclick="setQuickRange(2880)" style="padding:5px 10px;font-size:0.78rem;">2d</button>
    <button class="btn-secondary btn-quick btn-quick-active" onclick="resetFilters()" style="padding:5px 10px;font-size:0.78rem;">All</button>
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
<div class="grid grid-4" id="summary-grid">${statCardsHtml.join('\n')}</div>

<div class="section-title">Charts</div>
${chartGrid.join('\n')}

<div class="section-title" id="issues-title">Issues (${issues.length} detected)</div>
<div id="issues-container" style="margin-bottom:24px;">${issueCards || '<p style="color:var(--muted)">No issues detected.</p>'}</div>

<div class="section-title">Recommendations</div>
<div id="recs-container" style="margin-bottom:24px;">${recCards || '<p style="color:var(--muted)">No recommendations.</p>'}</div>

${botTable}
${dbTable}

<p style="text-align:center;color:var(--muted);font-size:0.8rem;padding:20px 0;">
  Generated by k8s-log-analyzer | ${new Date().toISOString()}
</p>

<script>
/* === Global state (var for file:// scope access) === */
var REPORT_DATA = ${JSON.stringify(reportData)};
var COLORS = ['#f85149','#d29922','#e3b341','#3fb950','#58a6ff','#bc8cff','#f778ba','#22d3ee','#e879f9','#84cc16'];
var chartMap = {};
var activeQuickBtn = null;

/* === Initialize Charts === */
${chartInits.join('\n')}

/* === Timezone display === */
(function initTimezone() {
  try {
    var tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    var offset = new Date().getTimezoneOffset();
    var sign = offset <= 0 ? '+' : '-';
    var absH = p2(Math.floor(Math.abs(offset)/60));
    var absM = p2(Math.abs(offset)%60);
    document.getElementById('tz-label').textContent = tz + ' (UTC' + sign + absH + ':' + absM + ')';
  } catch(e) {}
})();

/* === Get actual data time bounds across all sources === */
function getDataBounds() {
  var maxTs = REPORT_DATA.timeRange.end || 0;
  var minTs = REPORT_DATA.timeRange.start || Infinity;
  var tl = REPORT_DATA.errorTimeline;
  if (tl.length > 0) { minTs = Math.min(minTs, tl[0].timestamp); maxTs = Math.max(maxTs, tl[tl.length-1].timestamp); }
  var nc = REPORT_DATA.nodeCpu;
  if (nc.length > 0) { minTs = Math.min(minTs, nc[0].timestamp); maxTs = Math.max(maxTs, nc[nc.length-1].timestamp); }
  var dc = REPORT_DATA.dbConns;
  if (dc.length > 0) { minTs = Math.min(minTs, dc[0].timestamp); maxTs = Math.max(maxTs, dc[dc.length-1].timestamp); }
  if (minTs === Infinity) minTs = 0;
  return { min: minTs, max: maxTs };
}

/* === Set initial filter values === */
(function initFilters() {
  var bounds = getDataBounds();
  if (bounds.min) document.getElementById('filter-start').value = toLocalInput(new Date(bounds.min));
  if (bounds.max) document.getElementById('filter-end').value = toLocalInput(new Date(bounds.max));
})();

/* === Utility functions === */
function toLocalInput(d) {
  return d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate())+'T'+p2(d.getHours())+':'+p2(d.getMinutes());
}
function p2(n){ return String(n).padStart(2,'0'); }
function fmtTime(ts) {
  var d = new Date(ts);
  return p2(d.getHours())+':'+p2(d.getMinutes());
}
function fmtTimeSec(ts) {
  var d = new Date(ts);
  return p2(d.getHours())+':'+p2(d.getMinutes())+':'+p2(d.getSeconds());
}
function fmtDateTime(ts) {
  var d = new Date(ts);
  return d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate())+' '+p2(d.getHours())+':'+p2(d.getMinutes());
}
function inRange(ts, startTs, endTs) {
  if (startTs && ts < startTs) return false;
  if (endTs && ts > endTs) return false;
  return true;
}
function getFilterRange() {
  var startVal = document.getElementById('filter-start').value;
  var endVal = document.getElementById('filter-end').value;
  return {
    startTs: startVal ? new Date(startVal).getTime() : null,
    endTs: endVal ? new Date(endVal).getTime() : null
  };
}
function numFmt(n) { return n.toLocaleString(); }

/* =====================================================
   MAIN FILTER FUNCTION — updates EVERYTHING
   ===================================================== */
function applyFilters() {
  var severity = document.getElementById('filter-severity').value;
  var category = document.getElementById('filter-category').value;
  var range = getFilterRange();
  var startTs = range.startTs;
  var endTs = range.endTs;

  /* --- 1. Update subtitle time range --- */
  if (startTs || endTs) {
    var sLabel = startTs ? fmtDateTime(startTs) : '...';
    var eLabel = endTs ? fmtDateTime(endTs) : '...';
    document.getElementById('subtitle-time').textContent = sLabel + ' — ' + eLabel;
  } else {
    var origStart = REPORT_DATA.timeRange.start;
    var origEnd = REPORT_DATA.timeRange.end;
    if (origStart && origEnd) {
      document.getElementById('subtitle-time').textContent = fmtDateTime(origStart) + ' — ' + fmtDateTime(origEnd);
    }
  }

  /* --- 2. Recompute summary stat cards from filtered timeline --- */
  var filteredTimeline = REPORT_DATA.errorTimeline;
  if (startTs || endTs) {
    filteredTimeline = REPORT_DATA.errorTimeline.filter(function(t) { return inRange(t.timestamp, startTs, endTs); });
  }
  // Recount per category from filtered timeline buckets
  var catCounts = {};
  for (var ti = 0; ti < filteredTimeline.length; ti++) {
    var cats = filteredTimeline[ti].categories;
    for (var catKey in cats) {
      if (cats.hasOwnProperty(catKey)) {
        catCounts[catKey] = (catCounts[catKey] || 0) + cats[catKey];
      }
    }
  }
  // Update the 4 stat card values
  for (var si = 0; si < Math.min(4, REPORT_DATA.categories.length); si++) {
    var catName = REPORT_DATA.categories[si].name;
    var el = document.getElementById('stat-value-' + si);
    if (el) {
      var newCount = catCounts[catName] || 0;
      el.textContent = numFmt(newCount);
    }
  }

  /* --- 3. Filter issue cards by severity --- */
  var boxes = document.querySelectorAll('.issue-box');
  var visibleIssues = 0;
  boxes.forEach(function(box) {
    var sev = box.getAttribute('data-severity');
    var sevMatch = severity === 'all' || sev === severity;
    box.style.display = sevMatch ? '' : 'none';
    if (sevMatch) visibleIssues++;
  });
  document.getElementById('issues-title').textContent = 'Issues (' + visibleIssues + ' of ' + REPORT_DATA.issueCount + ' shown)';

  /* --- 4. Error Timeline (stacked bar) --- */
  if (chartMap.errorTimeline) {
    chartMap.errorTimeline.data.labels = filteredTimeline.map(function(t) { return fmtTime(t.timestamp); });
    chartMap.errorTimeline.data.datasets.forEach(function(ds) {
      var cn = ds.label.replace(/ /g, '_');
      ds.data = filteredTimeline.map(function(t) { return t.categories[cn] || 0; });
      ds.hidden = (category !== 'all') ? cn !== category : false;
    });
    chartMap.errorTimeline.update();
  }

  /* --- 5. Error Distribution (doughnut) — recalculate from filtered data --- */
  if (chartMap.errorDist) {
    // Update counts in doughnut from filtered timeline
    var doughnutData = REPORT_DATA.categories.slice(0, 10).map(function(c) {
      return catCounts[c.name] || 0;
    });
    chartMap.errorDist.data.datasets[0].data = doughnutData;
    // Update labels with new counts
    chartMap.errorDist.data.labels = REPORT_DATA.categories.slice(0, 10).map(function(c) {
      return c.name.replace(/_/g, ' ') + ' (' + numFmt(catCounts[c.name] || 0) + ')';
    });
    if (category !== 'all') {
      chartMap.errorDist.data.datasets[0].backgroundColor = REPORT_DATA.categories.slice(0,10).map(function(c, i) {
        return c.name === category ? COLORS[i] : 'rgba(100,100,100,0.2)';
      });
    } else {
      chartMap.errorDist.data.datasets[0].backgroundColor = COLORS.slice(0, chartMap.errorDist.data.labels.length);
    }
    chartMap.errorDist.update();
  }

  /* --- 6. Pod Errors (horizontal bar) — no time data, just show/hide --- */
  // Pod errors bar chart is static (aggregated), no time filtering possible

  /* --- 7. Node CPU (line) --- */
  if (chartMap.nodeCpu && REPORT_DATA.nodeCpu.length > 0) {
    var filtered = REPORT_DATA.nodeCpu.filter(function(e) { return inRange(e.timestamp, startTs, endTs); });
    chartMap.nodeCpu.data.labels = filtered.map(function(e) { return fmtTime(e.timestamp); });
    var nodeNames = Object.keys(REPORT_DATA.nodeCpu[0].nodes);
    chartMap.nodeCpu.data.datasets.forEach(function(ds, i) {
      ds.data = filtered.map(function(e) { return e.nodes[nodeNames[i]] || 0; });
    });
    chartMap.nodeCpu.update();
  }

  /* --- 8. Node Memory (line) --- */
  if (chartMap.nodeMemory && REPORT_DATA.nodeMemory.length > 0) {
    var filtered = REPORT_DATA.nodeMemory.filter(function(e) { return inRange(e.timestamp, startTs, endTs); });
    chartMap.nodeMemory.data.labels = filtered.map(function(e) { return fmtTime(e.timestamp); });
    var nodeNames = Object.keys(REPORT_DATA.nodeMemory[0].nodes);
    chartMap.nodeMemory.data.datasets.forEach(function(ds, i) {
      ds.data = filtered.map(function(e) { return e.nodes[nodeNames[i]] || 0; });
    });
    chartMap.nodeMemory.update();
  }

  /* --- 9. Hot Pod CPU (line) --- */
  if (chartMap.hotPodCpu && REPORT_DATA.hotPodDeployments.length > 0) {
    var allTs = {};
    REPORT_DATA.hotPodDeployments.forEach(function(depl) {
      (REPORT_DATA.hotPodCpu[depl] || []).forEach(function(p) {
        if (inRange(p.timestamp, startTs, endTs)) allTs[p.timestamp] = true;
      });
    });
    var sortedTs = Object.keys(allTs).map(Number).sort(function(a,b){return a-b;});
    chartMap.hotPodCpu.data.labels = sortedTs.map(function(ts) { return fmtTime(ts); });
    chartMap.hotPodCpu.data.datasets.forEach(function(ds, i) {
      var depl = REPORT_DATA.hotPodDeployments[i];
      var points = (REPORT_DATA.hotPodCpu[depl] || []).filter(function(p) { return inRange(p.timestamp, startTs, endTs); });
      var byTs = {};
      points.forEach(function(p) {
        if (!byTs[p.timestamp]) byTs[p.timestamp] = [];
        byTs[p.timestamp].push(p.value);
      });
      ds.data = sortedTs.map(function(ts) {
        var vals = byTs[ts];
        return vals ? Math.max.apply(null, vals) : null;
      });
    });
    chartMap.hotPodCpu.update();
  }

  /* --- 10. Scaling (line) --- */
  if (chartMap.scaling && Object.keys(REPORT_DATA.scaling).length > 0) {
    var allTs = {};
    Object.keys(REPORT_DATA.scaling).forEach(function(name) {
      REPORT_DATA.scaling[name].forEach(function(p) {
        if (inRange(p.timestamp, startTs, endTs)) allTs[p.timestamp] = true;
      });
    });
    var sortedTs = Object.keys(allTs).map(Number).sort(function(a,b){return a-b;});
    chartMap.scaling.data.labels = sortedTs.map(function(ts) { return fmtTime(ts); });
    var scalingNames = Object.keys(REPORT_DATA.scaling);
    chartMap.scaling.data.datasets.forEach(function(ds, i) {
      var name = scalingNames[i];
      var points = (REPORT_DATA.scaling[name] || []).filter(function(p) { return inRange(p.timestamp, startTs, endTs); });
      var byTs = {};
      points.forEach(function(p) { byTs[p.timestamp] = p.desired; });
      ds.data = sortedTs.map(function(ts) { return byTs[ts] !== undefined ? byTs[ts] : null; });
    });
    chartMap.scaling.update();
  }

  /* --- 11. DB Connections (line) --- */
  if (chartMap.dbConns && REPORT_DATA.dbConns.length > 0) {
    var filtered = REPORT_DATA.dbConns.filter(function(t) { return inRange(t.timestamp, startTs, endTs); });
    var step = Math.max(1, Math.floor(filtered.length / 50));
    var sampled = filtered.filter(function(_, i) { return i % step === 0; });
    chartMap.dbConns.data.labels = sampled.map(function(t) { return fmtTimeSec(t.timestamp); });
    chartMap.dbConns.data.datasets[0].data = sampled.map(function(t) { return t.total; });
    chartMap.dbConns.data.datasets[1].data = sampled.map(function(t) { return t.active; });
    chartMap.dbConns.update();
  }

  /* --- 12. Filter status bar --- */
  var parts = [];
  if (severity !== 'all') parts.push(severity + ' severity');
  if (category !== 'all') parts.push(category.replace(/_/g,' '));
  if (startTs || endTs) parts.push('time range');
  var statusEl = document.getElementById('filter-status');
  if (parts.length > 0) {
    statusEl.textContent = 'Active: ' + parts.join(' + ') + ' | ' + visibleIssues + ' issues shown';
    statusEl.style.display = '';
  } else {
    statusEl.style.display = 'none';
  }
}

/* === Reset all filters === */
function resetFilters() {
  document.getElementById('filter-severity').value = 'all';
  document.getElementById('filter-category').value = 'all';
  var bounds = getDataBounds();
  if (bounds.min) document.getElementById('filter-start').value = toLocalInput(new Date(bounds.min));
  if (bounds.max) document.getElementById('filter-end').value = toLocalInput(new Date(bounds.max));

  document.querySelectorAll('.issue-box').forEach(function(box) { box.style.display = ''; });
  document.getElementById('filter-status').style.display = 'none';

  // Highlight "All" button
  highlightQuickBtn(null);

  applyFilters();
}

/* === Quick range buttons === */
function setQuickRange(minutes) {
  // Find the actual latest data point across all sources
  var maxTs = REPORT_DATA.timeRange.end || 0;
  var tl = REPORT_DATA.errorTimeline;
  if (tl.length > 0) maxTs = Math.max(maxTs, tl[tl.length - 1].timestamp);
  var nc = REPORT_DATA.nodeCpu;
  if (nc.length > 0) maxTs = Math.max(maxTs, nc[nc.length - 1].timestamp);
  var dc = REPORT_DATA.dbConns;
  if (dc.length > 0) maxTs = Math.max(maxTs, dc[dc.length - 1].timestamp);
  if (!maxTs) return;

  // Find actual earliest data point
  var minTs = REPORT_DATA.timeRange.start || maxTs;
  if (tl.length > 0) minTs = Math.min(minTs, tl[0].timestamp);
  if (nc.length > 0) minTs = Math.min(minTs, nc[0].timestamp);
  if (dc.length > 0) minTs = Math.min(minTs, dc[0].timestamp);

  var endDate = new Date(maxTs);
  var startDate = new Date(endDate.getTime() - minutes * 60 * 1000);
  // Clamp start to actual data start
  if (startDate.getTime() < minTs) startDate = new Date(minTs);

  document.getElementById('filter-start').value = toLocalInput(startDate);
  document.getElementById('filter-end').value = toLocalInput(endDate);
  document.getElementById('filter-severity').value = 'all';
  document.getElementById('filter-category').value = 'all';
  highlightQuickBtn(minutes);
  applyFilters();
}

function highlightQuickBtn(minutes) {
  var btns = document.querySelectorAll('.btn-quick');
  btns.forEach(function(b) { b.classList.remove('btn-quick-active'); });
  if (minutes === null) {
    // highlight "All"
    var allBtn = document.querySelector('.btn-quick:last-of-type');
    if (allBtn) allBtn.classList.add('btn-quick-active');
  } else {
    btns.forEach(function(b) {
      if (b.textContent.trim() === (minutes < 60 ? minutes+'m' : minutes < 1440 ? (minutes/60)+'h' : (minutes/1440)+'d')) {
        b.classList.add('btn-quick-active');
      }
    });
  }
}
<\/script>
</body>
</html>`;

  fs.writeFileSync(outputPath, html, 'utf8');
}

module.exports = { generateReport };
