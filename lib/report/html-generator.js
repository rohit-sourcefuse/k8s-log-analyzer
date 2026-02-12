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
  const { manifestData, errorAnalysis, metricsAnalysis, dbAnalysis, podLogData, issues, recommendations, stats } = data;

  // ALL timestamps must be epoch milliseconds (numbers) for client-side comparison
  function toMs(ts) {
    if (typeof ts === 'number') return ts;
    if (ts instanceof Date) return ts.getTime();
    if (typeof ts === 'string') { const d = new Date(ts); return isNaN(d.getTime()) ? 0 : d.getTime(); }
    return 0;
  }

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

  // --- Chart canvases with download buttons ---
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

    chartCanvases.push(`<div class="card" id="card-${key}"><div class="card-header"><h3>${esc(title)}</h3><button class="btn-dl" onclick="downloadCSV('${key}')" title="Download CSV">&#x2B73; CSV</button></div><div class="chart-container"><canvas id="${canvasId}"></canvas></div></div>`);
    chartInits.push(`chartMap['${key}'] = new Chart(document.getElementById('${canvasId}'), ${JSON.stringify(cfg)});`);
  }

  const chartGrid = [];
  for (let i = 0; i < chartCanvases.length; i += 2) {
    const pair = chartCanvases.slice(i, i + 2);
    chartGrid.push(`<div class="grid grid-${pair.length}">${pair.join('\n')}</div>`);
  }

  const source = manifestData.source || 'unknown';
  const timeRange = stats.firstTimestamp && stats.lastTimestamp
    ? `${formatTimestamp(stats.firstTimestamp)} - ${formatTimestamp(stats.lastTimestamp)}`
    : 'N/A';

  // --- Build raw data for all time-series charts (client-side filtering) ---
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

  const rawDbConns = (dbAnalysis.timeline || []).map(t => ({
    timestamp: toMs(t.timestamp), total: t.total, active: t.active,
    sleeping: t.sleeping || 0, longestSec: t.longestSec || 0
  }));

  // Embed per-pod timeline data (each timeline bucket has per-pod breakdown from events)
  // We use the errorTimeline which already has per-category counts per 5-min bucket
  // For pods, we need the per-pod data from topPods — but topPods is aggregated.
  // To enable time-filtering on pods, embed per-pod timeline from error events' timeline buckets.
  // The classifier tracks per-pod per-bucket. We'll use per-timeline-bucket aggregation approach:
  // topPods are pre-aggregated so we embed their raw per-pod counts along with timeline for recomputation.
  const rawTopPods = errorAnalysis.topPods.slice(0, 20).map(p => ({
    name: p.name, count: p.count, categories: p.categories
  }));

  // Embed per-bot data for time-filtering the bot table
  const rawTopBots = errorAnalysis.topBots.slice(0, 20).map(b => ({
    id: b.id, count: b.count, categories: b.categories, pods: b.pods || []
  }));

  // Embed DB per-database data for time-filtering
  const rawDbByDatabase = (Array.isArray(dbAnalysis.connectionsByDatabase) ? dbAnalysis.connectionsByDatabase : []).map(d => ({
    database: d.database, avgConnections: d.avgConnections, peakConnections: d.peakConnections
  }));

  // Embed long-running queries with timestamps for time-filtering
  const rawLongQueries = (dbAnalysis.longRunningQueries || []).slice(0, 20).map(q => ({
    timestamp: toMs(q.timestamp), duration: q.duration, db: q.db,
    command: q.command, query: (q.query || 'N/A').substring(0, 200)
  }));

  // Issues and recommendations data for client-side recomputation
  const rawIssues = issues.map(i => ({
    id: i.id, severity: i.severity, title: i.title, description: i.description,
    evidence: i.evidence || [], impact: i.impact || '',
    rootCause: i.rootCause || '', action: i.action || '',
    affectedServices: i.affectedServices || []
  }));

  const rawRecs = recommendations.map(r => ({
    category: r.category, action: r.action, rationale: r.rationale,
    effort: r.effort, impact: r.impact, priority: r.priority
  }));

  const categoriesWithEvents = errorAnalysis.categories.map(c => ({
    name: c.name, count: c.count, severity: c.severity
  }));

  // Pod logs summary for dashboard
  const podLogSummary = (podLogData && podLogData.pods) ? podLogData.pods.map(p => ({
    podName: p.podName, deployment: p.deployment, totalLines: p.totalLines,
    errorLines: p.errorLines, warnLines: p.warnLines, apiRequests: p.apiRequests,
    healthChecks: p.healthChecks, serviceName: p.serviceName,
    httpCodes: p.httpCodes, topEndpoints: (p.topEndpoints || []).slice(0, 5),
    errors: (p.errors || []).slice(0, 5),
    firstTimestamp: p.firstTimestamp ? toMs(p.firstTimestamp) : null,
    lastTimestamp: p.lastTimestamp ? toMs(p.lastTimestamp) : null
  })) : [];

  const reportData = {
    timeRange: { start: toMs(stats.firstTimestamp), end: toMs(stats.lastTimestamp) },
    totalLines: stats.totalLines || 0,
    fileCount: stats.fileCount || 0,
    errorTimeline: errorAnalysis.timeline.map(t => ({
      timestamp: toMs(t.timestamp), categories: t.categories, total: t.total || 0
    })).filter(t => t.timestamp > 0),
    categories: categoriesWithEvents,
    nodeCpu: rawNodeCpu,
    nodeMemory: rawNodeMemory,
    hotPodCpu: rawHotPodCpu,
    hotPodDeployments: hotPodDeployments,
    scaling: rawScaling,
    dbConns: rawDbConns,
    topPods: rawTopPods,
    topBots: rawTopBots,
    dbByDatabase: rawDbByDatabase,
    longQueries: rawLongQueries,
    issues: rawIssues,
    recs: rawRecs,
    podLogs: podLogSummary,
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
<style>${getCssStyles()}
/* === Extra styles for download buttons and enhanced layout === */
.card-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:14px; }
.card-header h3 { margin-bottom:0; }
.btn-dl { background:var(--surface2); color:var(--muted); border:1px solid var(--border); padding:4px 10px; border-radius:5px; font-size:0.72rem; cursor:pointer; transition:all 0.2s; white-space:nowrap; }
.btn-dl:hover { background:var(--accent); color:#0d1117; border-color:var(--accent); }
.section-header { display:flex; align-items:center; justify-content:space-between; margin:32px 0 16px 0; padding-bottom:10px; border-bottom:1px solid var(--border); }
.section-header h2 { font-size:1.1rem; font-weight:600; margin:0; }
.table-wrap { overflow-x:auto; }
.table-wrap table { min-width:500px; }
.total-errors-card { background:linear-gradient(135deg, var(--surface) 0%, var(--surface2) 100%); }
.total-errors-card .value { color:var(--accent); font-size:2.4rem; }
.total-errors-card .label { color:var(--muted); }
.dl-group { display:flex; gap:6px; }
.data-ranges { display:flex; gap:16px; flex-wrap:wrap; font-size:0.73rem; color:var(--muted); padding:6px 0 2px 0; }
.data-ranges .range-item { display:flex; align-items:center; gap:4px; }
.data-ranges .range-dot { width:8px; height:8px; border-radius:50%; display:inline-block; }
.data-ranges .range-dot.errors { background:#f85149; }
.data-ranges .range-dot.metrics { background:#58a6ff; }
.data-ranges .range-dot.db { background:#3fb950; }
.data-ranges .range-dot.pods { background:#bc8cff; }
</style>
</head>
<body>
<h1>K8s Log Analysis Report</h1>
<p class="subtitle" id="report-subtitle">Source: ${esc(source)} | Time: <span id="subtitle-time">${esc(timeRange)}</span> | Lines: ${(stats.totalLines || 0).toLocaleString()} | Files: ${stats.fileCount || 0}${podLogSummary.length > 0 ? ` | Pods: ${podLogSummary.length}` : ''}${metricsAnalysis.nodeTrends.cpu.length > 0 ? ` | Metrics: ${metricsAnalysis.nodeTrends.cpu.length} snapshots` : ''}</p>

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
    <select id="filter-severity" onchange="applyFilters()">
      <option value="all">All</option>
      <option value="critical">Critical (5)</option>
      <option value="high">High (4)</option>
      <option value="medium">Medium (3)</option>
      <option value="low">Low (1-2)</option>
    </select>
    <label>Category:</label>
    <select id="filter-category" onchange="applyFilters()">
      <option value="all">All Categories</option>
      ${errorAnalysis.categories.map(c => `<option value="${esc(c.name)}">${esc(c.name.replace(/_/g,' '))} (${c.count.toLocaleString()})</option>`).join('\n')}
    </select>
    <label>Deployment:</label>
    <select id="filter-deployment" onchange="applyFilters()">
      <option value="all">All Deployments</option>
      ${[...new Set([...Object.keys(metricsAnalysis.deploymentTimelines || {}), ...(podLogData && podLogData.pods ? podLogData.pods.map(p => p.deployment) : [])])].sort().map(d => `<option value="${esc(d)}">${esc(d)}</option>`).join('\n')}
    </select>
    <button class="btn-primary" onclick="applyFilters()">Apply Filters</button>
    <button class="btn-secondary" onclick="resetFilters()">Reset</button>
  </div>
  <div class="data-ranges" id="data-ranges"></div>
</div>

<div class="section-title">Summary</div>
<div class="grid grid-4" id="summary-grid">${statCardsHtml.join('\n')}</div>

<div class="section-title">Charts</div>
${chartGrid.join('\n')}

<div class="section-header"><h2 id="issues-title">Issues (${issues.length} detected)</h2><div class="dl-group"><button class="btn-dl" onclick="downloadCSV('issues')" title="Download issues CSV">&#x2B73; Issues CSV</button></div></div>
<div id="issues-container" style="margin-bottom:24px;">${issueCards || '<p style="color:var(--muted)">No issues detected.</p>'}</div>

<div class="section-header"><h2>Recommendations</h2><div class="dl-group"><button class="btn-dl" onclick="downloadCSV('recs')" title="Download recommendations CSV">&#x2B73; Recs CSV</button></div></div>
<div id="recs-container" style="margin-bottom:24px;">${recCards || '<p style="color:var(--muted)">No recommendations.</p>'}</div>

<div class="section-header"><h2 id="bot-table-title">Affected Bots / Entities</h2><div class="dl-group"><button class="btn-dl" onclick="downloadCSV('bots')" title="Download bot data CSV">&#x2B73; CSV</button></div></div>
<div id="bot-table-container" class="card table-wrap" style="margin-bottom:20px;">
  <table id="bot-table">
    <thead><tr><th>Bot ID</th><th>Error Count</th><th>Top Category</th><th>Pods</th></tr></thead>
    <tbody id="bot-table-body"></tbody>
  </table>
</div>

<div class="section-header"><h2 id="db-table-title">Database Connection Summary</h2><div class="dl-group"><button class="btn-dl" onclick="downloadCSV('dbSummary')" title="Download DB summary CSV">&#x2B73; CSV</button></div></div>
<div id="db-table-container" class="card table-wrap" style="margin-bottom:20px;">
  <table id="db-summary-table">
    <thead><tr><th>Database</th><th>Avg Connections</th><th>Peak Connections</th></tr></thead>
    <tbody id="db-summary-body"></tbody>
  </table>
  <h3 style="margin-top:16px;" id="long-query-title">Long Running Queries (&gt;60s)</h3>
  <table id="long-query-table">
    <thead><tr><th>Time</th><th>Duration</th><th>Database</th><th>Command</th><th>Query</th></tr></thead>
    <tbody id="long-query-body"></tbody>
  </table>
</div>

${podLogSummary.length > 0 ? `
<div class="section-header"><h2 id="pod-logs-title">Pod Logs (kubectl) — ${podLogSummary.length} pods</h2><div class="dl-group"><button class="btn-dl" onclick="downloadCSV('podLogs')" title="Download pod logs summary CSV">&#x2B73; CSV</button></div></div>
<div class="card table-wrap" style="margin-bottom:20px;">
  <table id="pod-logs-table">
    <thead><tr><th>Pod</th><th>Deployment</th><th>Lines</th><th>Errors</th><th>Warnings</th><th>API Reqs</th><th>Health Checks</th><th>HTTP Codes</th><th>Time Range</th></tr></thead>
    <tbody id="pod-logs-body"></tbody>
  </table>
  <h3 style="margin-top:16px;" id="top-endpoints-title">Top API Endpoints (across all pods)</h3>
  <table id="top-endpoints-table">
    <thead><tr><th>Endpoint</th><th>Total Requests</th></tr></thead>
    <tbody id="top-endpoints-body"></tbody>
  </table>
</div>
` : ''}

<p style="text-align:center;color:var(--muted);font-size:0.8rem;padding:20px 0;">
  Generated by k8s-log-analyzer | ${new Date().toISOString()}
</p>

<script>
/* === Global state (var for file:// scope access) === */
var REPORT_DATA = ${JSON.stringify(reportData)};
var COLORS = ['#f85149','#d29922','#e3b341','#3fb950','#58a6ff','#bc8cff','#f778ba','#22d3ee','#e879f9','#84cc16'];
var chartMap = {};
var activeQuickBtn = null;

/* === Severity number → label mapping (from ERROR_PATTERNS) === */
var SEV_MAP = { critical: [5], high: [4], medium: [3], low: [1, 2] };
var CAT_SEVERITY = {};
REPORT_DATA.categories.forEach(function(c) { CAT_SEVERITY[c.name] = c.severity; });

/* Check if a category name passes the current severity + category filters */
function catMatchesFilters(catName, severity, category) {
  if (category !== 'all' && catName !== category) return false;
  if (severity !== 'all') {
    var sev = CAT_SEVERITY[catName] || 1;
    if (SEV_MAP[severity] && SEV_MAP[severity].indexOf(sev) === -1) return false;
  }
  return true;
}

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

  // Per-source bounds
  var errorMin = Infinity, errorMax = 0;
  var metricsMin = Infinity, metricsMax = 0;
  var dbMin = Infinity, dbMax = 0;
  var podMin = Infinity, podMax = 0;

  var tl = REPORT_DATA.errorTimeline;
  if (tl.length > 0) {
    errorMin = tl[0].timestamp; errorMax = tl[tl.length-1].timestamp;
    minTs = Math.min(minTs, errorMin); maxTs = Math.max(maxTs, errorMax);
  }
  var nc = REPORT_DATA.nodeCpu;
  if (nc.length > 0) {
    metricsMin = nc[0].timestamp; metricsMax = nc[nc.length-1].timestamp;
    minTs = Math.min(minTs, metricsMin); maxTs = Math.max(maxTs, metricsMax);
  }
  var dc = REPORT_DATA.dbConns;
  if (dc.length > 0) {
    dbMin = dc[0].timestamp; dbMax = dc[dc.length-1].timestamp;
    minTs = Math.min(minTs, dbMin); maxTs = Math.max(maxTs, dbMax);
  }
  var pl = REPORT_DATA.podLogs || [];
  pl.forEach(function(p) {
    if (p.firstTimestamp) { podMin = Math.min(podMin, p.firstTimestamp); minTs = Math.min(minTs, p.firstTimestamp); }
    if (p.lastTimestamp) { podMax = Math.max(podMax, p.lastTimestamp); maxTs = Math.max(maxTs, p.lastTimestamp); }
  });
  if (minTs === Infinity) minTs = 0;
  if (errorMin === Infinity) errorMin = 0;
  if (metricsMin === Infinity) metricsMin = 0;
  if (dbMin === Infinity) dbMin = 0;
  if (podMin === Infinity) podMin = 0;
  return {
    min: minTs, max: maxTs,
    errors: { min: errorMin, max: errorMax },
    metrics: { min: metricsMin, max: metricsMax },
    db: { min: dbMin, max: dbMax },
    pods: { min: podMin, max: podMax }
  };
}

/* === Set initial filter values and show data range info === */
(function initFilters() {
  var bounds = getDataBounds();
  if (bounds.min) document.getElementById('filter-start').value = toLocalInput(new Date(bounds.min));
  if (bounds.max) document.getElementById('filter-end').value = toLocalInput(new Date(bounds.max));

  // Show per-source time ranges so user knows where data exists
  var rangesEl = document.getElementById('data-ranges');
  if (rangesEl) {
    var parts = [];
    parts.push('<span style="color:var(--text-secondary)">Data spans:</span>');
    if (bounds.errors.max > 0) {
      parts.push('<span class="range-item"><span class="range-dot errors"></span>Errors: ' + fmtDateTime(bounds.errors.min) + ' – ' + fmtDateTime(bounds.errors.max) + '</span>');
    }
    if (bounds.metrics.max > 0) {
      parts.push('<span class="range-item"><span class="range-dot metrics"></span>Metrics: ' + fmtDateTime(bounds.metrics.min) + ' – ' + fmtDateTime(bounds.metrics.max) + '</span>');
    }
    if (bounds.db.max > 0) {
      parts.push('<span class="range-item"><span class="range-dot db"></span>DB: ' + fmtDateTime(bounds.db.min) + ' – ' + fmtDateTime(bounds.db.max) + '</span>');
    }
    if (bounds.pods.max > 0) {
      parts.push('<span class="range-item"><span class="range-dot pods"></span>Pod Logs: ' + fmtDateTime(bounds.pods.min) + ' – ' + fmtDateTime(bounds.pods.max) + '</span>');
    }
    rangesEl.innerHTML = parts.join('');
  }
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
function fmtDateTimeFull(ts) {
  var d = new Date(ts);
  return d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate())+' '+p2(d.getHours())+':'+p2(d.getMinutes())+':'+p2(d.getSeconds());
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
function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

/* === CSV Download Helper === */
function downloadCSV(type) {
  var range = getFilterRange();
  var startTs = range.startTs;
  var endTs = range.endTs;
  var csv = '';
  var filename = type + '_export.csv';

  if (type === 'errorTimeline') {
    var tl = REPORT_DATA.errorTimeline.filter(function(t) { return inRange(t.timestamp, startTs, endTs); });
    var allCats = {};
    tl.forEach(function(t) { for (var k in t.categories) allCats[k] = true; });
    var catNames = Object.keys(allCats).sort();
    csv = 'Timestamp,' + catNames.join(',') + ',Total\\n';
    tl.forEach(function(t) {
      var total = 0;
      var vals = catNames.map(function(c) { var v = t.categories[c] || 0; total += v; return v; });
      csv += fmtDateTimeFull(t.timestamp) + ',' + vals.join(',') + ',' + total + '\\n';
    });
    filename = 'error_timeline.csv';

  } else if (type === 'errorDist') {
    var tl = REPORT_DATA.errorTimeline.filter(function(t) { return inRange(t.timestamp, startTs, endTs); });
    var catCounts = {};
    tl.forEach(function(t) { for (var k in t.categories) catCounts[k] = (catCounts[k]||0) + t.categories[k]; });
    csv = 'Category,Count,Severity\\n';
    REPORT_DATA.categories.forEach(function(c) {
      csv += c.name + ',' + (catCounts[c.name]||0) + ',' + c.severity + '\\n';
    });
    filename = 'error_distribution.csv';

  } else if (type === 'podErrors') {
    var tl = REPORT_DATA.errorTimeline.filter(function(t) { return inRange(t.timestamp, startTs, endTs); });
    // Pod data is in filtered timeline per-category, but pod bar is aggregate — download pod data
    csv = 'Pod,Error Count,Top Category\\n';
    REPORT_DATA.topPods.forEach(function(p) {
      var topCat = Object.keys(p.categories).sort(function(a,b){return p.categories[b]-p.categories[a];})[0] || '-';
      csv += '"' + p.name + '",' + p.count + ',' + topCat + '\\n';
    });
    filename = 'pod_errors.csv';

  } else if (type === 'nodeCpu') {
    var data = REPORT_DATA.nodeCpu.filter(function(e) { return inRange(e.timestamp, startTs, endTs); });
    if (data.length > 0) {
      var nodes = Object.keys(data[0].nodes);
      csv = 'Timestamp,' + nodes.join(',') + '\\n';
      data.forEach(function(e) {
        csv += fmtDateTimeFull(e.timestamp) + ',' + nodes.map(function(n){return e.nodes[n]||0;}).join(',') + '\\n';
      });
    }
    filename = 'node_cpu.csv';

  } else if (type === 'nodeMemory') {
    var data = REPORT_DATA.nodeMemory.filter(function(e) { return inRange(e.timestamp, startTs, endTs); });
    if (data.length > 0) {
      var nodes = Object.keys(data[0].nodes);
      csv = 'Timestamp,' + nodes.join(',') + '\\n';
      data.forEach(function(e) {
        csv += fmtDateTimeFull(e.timestamp) + ',' + nodes.map(function(n){return e.nodes[n]||0;}).join(',') + '\\n';
      });
    }
    filename = 'node_memory.csv';

  } else if (type === 'hotPodCpu') {
    csv = 'Timestamp,Deployment,CPU_millicores\\n';
    REPORT_DATA.hotPodDeployments.forEach(function(depl) {
      (REPORT_DATA.hotPodCpu[depl]||[]).filter(function(p){return inRange(p.timestamp,startTs,endTs);}).forEach(function(p) {
        csv += fmtDateTimeFull(p.timestamp) + ',"' + depl + '",' + p.value + '\\n';
      });
    });
    filename = 'hot_pod_cpu.csv';

  } else if (type === 'scaling') {
    csv = 'Timestamp,Deployment,Replicas\\n';
    Object.keys(REPORT_DATA.scaling).forEach(function(name) {
      REPORT_DATA.scaling[name].filter(function(p){return inRange(p.timestamp,startTs,endTs);}).forEach(function(p) {
        csv += fmtDateTimeFull(p.timestamp) + ',"' + name + '",' + p.desired + '\\n';
      });
    });
    filename = 'scaling_events.csv';

  } else if (type === 'dbConns') {
    csv = 'Timestamp,Total,Active\\n';
    REPORT_DATA.dbConns.filter(function(t){return inRange(t.timestamp,startTs,endTs);}).forEach(function(t) {
      csv += fmtDateTimeFull(t.timestamp) + ',' + t.total + ',' + t.active + '\\n';
    });
    filename = 'db_connections.csv';

  } else if (type === 'issues') {
    csv = 'ID,Severity,Title,Description,Impact,Root Cause,Action,Services\\n';
    REPORT_DATA.issues.forEach(function(i) {
      csv += i.id + ',' + i.severity + ',"' + i.title.replace(/"/g,'""') + '","' + i.description.replace(/"/g,'""') + '","' + i.impact.replace(/"/g,'""') + '","' + i.rootCause.replace(/"/g,'""') + '","' + i.action.replace(/"/g,'""') + '","' + i.affectedServices.join('; ') + '"\\n';
    });
    filename = 'issues.csv';

  } else if (type === 'recs') {
    csv = 'Priority,Category,Action,Rationale,Effort,Impact\\n';
    REPORT_DATA.recs.forEach(function(r) {
      var pLabel = r.priority >= 8 ? 'P0' : r.priority >= 5 ? 'P1' : r.priority >= 3 ? 'P2' : 'P3';
      csv += pLabel + ',' + r.category + ',"' + r.action.replace(/"/g,'""') + '","' + r.rationale.replace(/"/g,'""') + '",' + r.effort + ',' + r.impact + '\\n';
    });
    filename = 'recommendations.csv';

  } else if (type === 'bots') {
    csv = 'Bot ID,Error Count,Top Category,Pod Count\\n';
    REPORT_DATA.topBots.forEach(function(b) {
      var topCat = Object.keys(b.categories).sort(function(a,c){return b.categories[c]-b.categories[a];})[0] || '-';
      csv += '"' + b.id + '",' + b.count + ',' + topCat + ',' + (b.pods?b.pods.length:0) + '\\n';
    });
    filename = 'affected_bots.csv';

  } else if (type === 'dbSummary') {
    csv = 'Database,Avg Connections,Peak Connections\\n';
    REPORT_DATA.dbByDatabase.forEach(function(d) {
      csv += d.database + ',' + d.avgConnections + ',' + d.peakConnections + '\\n';
    });
    filename = 'db_summary.csv';

  } else if (type === 'podLogs') {
    var pods = (REPORT_DATA.podLogs || []).filter(function(p) {
      if (!startTs && !endTs) return true;
      if (!p.firstTimestamp && !p.lastTimestamp) return true;
      var pStart = p.firstTimestamp || 0;
      var pEnd = p.lastTimestamp || Infinity;
      if (endTs && pStart > endTs) return false;
      if (startTs && pEnd < startTs) return false;
      return true;
    });
    csv = 'Pod,Deployment,Total Lines,Errors,Warnings,API Requests,Health Checks,Service,First Timestamp,Last Timestamp\\n';
    pods.forEach(function(p) {
      csv += '"' + p.podName + '","' + p.deployment + '",' + p.totalLines + ',' + p.errorLines + ',' + p.warnLines + ',' + p.apiRequests + ',' + p.healthChecks + ',"' + (p.serviceName||'') + '",' + (p.firstTimestamp ? fmtDateTimeFull(p.firstTimestamp) : '') + ',' + (p.lastTimestamp ? fmtDateTimeFull(p.lastTimestamp) : '') + '\\n';
    });
    filename = 'pod_logs_summary.csv';
  }

  if (!csv) return;
  var blob = new Blob([csv], {type: 'text/csv'});
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* =====================================================
   MAIN FILTER FUNCTION — updates EVERYTHING
   ===================================================== */
function applyFilters() {
  var severity = document.getElementById('filter-severity').value;
  var category = document.getElementById('filter-category').value;
  var deployment = document.getElementById('filter-deployment') ? document.getElementById('filter-deployment').value : 'all';
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

  /* --- 2. Recompute summary stat cards from filtered timeline + severity/category --- */
  var filteredTimeline = REPORT_DATA.errorTimeline;
  if (startTs || endTs) {
    filteredTimeline = REPORT_DATA.errorTimeline.filter(function(t) { return inRange(t.timestamp, startTs, endTs); });
  }
  var catCounts = {};
  var totalFilteredErrors = 0;
  for (var ti = 0; ti < filteredTimeline.length; ti++) {
    var cats = filteredTimeline[ti].categories;
    for (var catKey in cats) {
      if (cats.hasOwnProperty(catKey)) {
        /* Apply severity + category filters to error counts */
        if (!catMatchesFilters(catKey, severity, category)) continue;
        catCounts[catKey] = (catCounts[catKey] || 0) + cats[catKey];
        totalFilteredErrors += cats[catKey];
      }
    }
  }
  /* Update stat cards — show matching categories, dim non-matching */
  for (var si = 0; si < Math.min(4, REPORT_DATA.categories.length); si++) {
    var catName = REPORT_DATA.categories[si].name;
    var el = document.getElementById('stat-value-' + si);
    var cardEl = el ? el.closest('.stat-card') : null;
    if (el) {
      var newCount = catCounts[catName] || 0;
      el.textContent = numFmt(newCount);
      /* Dim cards that don't match current filters */
      if (cardEl) {
        var matches = catMatchesFilters(catName, severity, category);
        cardEl.style.opacity = matches ? '1' : '0.35';
      }
    }
  }

  /* --- 3. Filter issue cards by severity + category + deployment --- */
  var boxes = document.querySelectorAll('.issue-box');
  var visibleIssues = 0;
  boxes.forEach(function(box) {
    var sev = box.getAttribute('data-severity');
    var sevMatch = severity === 'all' || sev === severity;
    var deplMatch = deployment === 'all' || (box.getAttribute('data-services') || '').indexOf(deployment) >= 0;
    box.style.display = (sevMatch && deplMatch) ? '' : 'none';
    if (sevMatch && deplMatch) visibleIssues++;
  });
  document.getElementById('issues-title').textContent = 'Issues (' + visibleIssues + ' of ' + REPORT_DATA.issueCount + ' shown)';

  /* --- 4. Error Timeline (stacked bar) — apply severity+category filter --- */
  if (chartMap.errorTimeline) {
    chartMap.errorTimeline.data.labels = filteredTimeline.map(function(t) { return fmtTime(t.timestamp); });
    chartMap.errorTimeline.data.datasets.forEach(function(ds) {
      var cn = ds.label.replace(/ /g, '_');
      var passesFilter = catMatchesFilters(cn, severity, category);
      ds.data = filteredTimeline.map(function(t) { return passesFilter ? (t.categories[cn] || 0) : 0; });
      ds.hidden = !passesFilter;
    });
    chartMap.errorTimeline.update();
  }

  /* --- 5. Error Distribution (doughnut) — apply severity+category filter --- */
  if (chartMap.errorDist) {
    var doughnutData = REPORT_DATA.categories.slice(0, 10).map(function(c) {
      return catMatchesFilters(c.name, severity, category) ? (catCounts[c.name] || 0) : 0;
    });
    chartMap.errorDist.data.datasets[0].data = doughnutData;
    chartMap.errorDist.data.labels = REPORT_DATA.categories.slice(0, 10).map(function(c) {
      return c.name.replace(/_/g, ' ') + ' (' + numFmt(catMatchesFilters(c.name, severity, category) ? (catCounts[c.name] || 0) : 0) + ')';
    });
    /* Color: highlight matching, dim non-matching */
    chartMap.errorDist.data.datasets[0].backgroundColor = REPORT_DATA.categories.slice(0,10).map(function(c, i) {
      if (!catMatchesFilters(c.name, severity, category)) return 'rgba(100,100,100,0.15)';
      return COLORS[i];
    });
    chartMap.errorDist.update();
  }

  /* --- 6. Proportional scaling ratio (used by pod errors, bot table) --- */
  /* Compute ratio against the total that matches severity+category (unfiltered by time) */
  var totalOriginal = 0;
  REPORT_DATA.categories.forEach(function(c) {
    if (catMatchesFilters(c.name, severity, category)) totalOriginal += c.count;
  });
  var ratio = totalOriginal > 0 ? totalFilteredErrors / totalOriginal : 0;

  /* --- 6b. Pod Errors (horizontal bar) — apply proportional scaling + category filter --- */
  if (chartMap.podErrors) {
    var pods = REPORT_DATA.topPods.slice(0, 12);
    chartMap.podErrors.data.labels = pods.map(function(p) {
      return p.name.length > 30 ? p.name.substring(0,30) + '...' : p.name;
    });
    chartMap.podErrors.data.datasets[0].data = pods.map(function(p) {
      /* If category filter is active, use only that category's count for this pod */
      var podTotal = 0;
      for (var cn in p.categories) {
        if (p.categories.hasOwnProperty(cn) && catMatchesFilters(cn, severity, category)) {
          podTotal += p.categories[cn];
        }
      }
      return Math.round(podTotal * ratio);
    });
    chartMap.podErrors.update();
  }

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

  /* --- 9. Hot Pod CPU (line) — filter by deployment --- */
  if (chartMap.hotPodCpu && REPORT_DATA.hotPodDeployments.length > 0) {
    var allTs = {};
    REPORT_DATA.hotPodDeployments.forEach(function(depl) {
      if (deployment !== 'all' && depl !== deployment) return;
      (REPORT_DATA.hotPodCpu[depl] || []).forEach(function(p) {
        if (inRange(p.timestamp, startTs, endTs)) allTs[p.timestamp] = true;
      });
    });
    var sortedTs = Object.keys(allTs).map(Number).sort(function(a,b){return a-b;});
    chartMap.hotPodCpu.data.labels = sortedTs.map(function(ts) { return fmtTime(ts); });
    chartMap.hotPodCpu.data.datasets.forEach(function(ds, i) {
      var depl = REPORT_DATA.hotPodDeployments[i];
      var hide = deployment !== 'all' && depl !== deployment;
      var points = hide ? [] : (REPORT_DATA.hotPodCpu[depl] || []).filter(function(p) { return inRange(p.timestamp, startTs, endTs); });
      var byTs = {};
      points.forEach(function(p) {
        if (!byTs[p.timestamp]) byTs[p.timestamp] = [];
        byTs[p.timestamp].push(p.value);
      });
      ds.data = sortedTs.map(function(ts) {
        var vals = byTs[ts];
        return vals ? Math.max.apply(null, vals) : null;
      });
      ds.hidden = hide;
    });
    chartMap.hotPodCpu.update();
  }

  /* --- 10. Scaling (line) — filter by deployment --- */
  if (chartMap.scaling && Object.keys(REPORT_DATA.scaling).length > 0) {
    var allTs = {};
    Object.keys(REPORT_DATA.scaling).forEach(function(name) {
      if (deployment !== 'all' && name !== deployment) return;
      REPORT_DATA.scaling[name].forEach(function(p) {
        if (inRange(p.timestamp, startTs, endTs)) allTs[p.timestamp] = true;
      });
    });
    var sortedTs = Object.keys(allTs).map(Number).sort(function(a,b){return a-b;});
    chartMap.scaling.data.labels = sortedTs.map(function(ts) { return fmtTime(ts); });
    var scalingNames = Object.keys(REPORT_DATA.scaling);
    chartMap.scaling.data.datasets.forEach(function(ds, i) {
      var name = scalingNames[i];
      var hide = deployment !== 'all' && name !== deployment;
      var points = hide ? [] : (REPORT_DATA.scaling[name] || []).filter(function(p) { return inRange(p.timestamp, startTs, endTs); });
      var byTs = {};
      points.forEach(function(p) { byTs[p.timestamp] = p.desired; });
      ds.data = sortedTs.map(function(ts) { return byTs[ts] !== undefined ? byTs[ts] : null; });
      ds.hidden = hide;
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

  /* --- 12. Bot table — apply severity+category filter to per-bot counts --- */
  var botBody = document.getElementById('bot-table-body');
  if (botBody && REPORT_DATA.topBots.length > 0) {
    var html = '';
    REPORT_DATA.topBots.forEach(function(b) {
      var filteredCount = 0;
      var filteredTopCat = '';
      var filteredCatMax = 0;
      for (var cn in b.categories) {
        if (b.categories.hasOwnProperty(cn) && catMatchesFilters(cn, severity, category)) {
          var cnt = b.categories[cn];
          filteredCount += cnt;
          if (cnt > filteredCatMax) { filteredCatMax = cnt; filteredTopCat = cn; }
        }
      }
      var scaledCount = totalOriginal > 0 ? Math.round(filteredCount * ratio) : filteredCount;
      if (scaledCount === 0 && (severity !== 'all' || category !== 'all')) return; /* hide bots with zero matching errors */
      html += '<tr><td><code>' + escHtml(b.id) + '</code></td><td>' + numFmt(scaledCount) + '</td><td>' + (filteredTopCat || '-').replace(/_/g,' ') + '</td><td>' + (b.pods?b.pods.length:0) + '</td></tr>';
    });
    botBody.innerHTML = html || '<tr><td colspan="4" style="color:var(--muted)">No bots match current filters</td></tr>';
  }

  /* --- 13. DB summary table --- */
  var dbBody = document.getElementById('db-summary-body');
  if (dbBody && REPORT_DATA.dbByDatabase.length > 0) {
    var filteredDb = REPORT_DATA.dbConns.filter(function(t) { return inRange(t.timestamp, startTs, endTs); });
    var html = '';
    REPORT_DATA.dbByDatabase.forEach(function(d) {
      html += '<tr><td>' + escHtml(d.database) + '</td><td>' + d.avgConnections + '</td><td>' + d.peakConnections + '</td></tr>';
    });
    dbBody.innerHTML = html;
  }

  /* --- 14. Long-running queries table (filtered by time) --- */
  var lqBody = document.getElementById('long-query-body');
  if (lqBody) {
    var filteredLQ = REPORT_DATA.longQueries.filter(function(q) { return inRange(q.timestamp, startTs, endTs); });
    var html = '';
    filteredLQ.forEach(function(q) {
      html += '<tr><td>' + fmtDateTimeFull(q.timestamp) + '</td><td>' + q.duration + 's</td><td>' + escHtml(q.db) + '</td><td>' + escHtml(q.command) + '</td><td><code>' + escHtml(q.query) + '</code></td></tr>';
    });
    lqBody.innerHTML = html || '<tr><td colspan="5" style="color:var(--muted)">No long-running queries in selected range</td></tr>';
    document.getElementById('long-query-title').textContent = 'Long Running Queries >60s (' + filteredLQ.length + ')';
  }

  /* --- 15. Pod Logs table (filtered by time overlap + deployment) --- */
  var podLogsBody = document.getElementById('pod-logs-body');
  if (podLogsBody && REPORT_DATA.podLogs && REPORT_DATA.podLogs.length > 0) {
    var filteredPods = REPORT_DATA.podLogs.filter(function(p) {
      // Deployment filter
      if (deployment !== 'all' && p.deployment !== deployment) return false;
      // Show pod if its time range overlaps with the selected filter range
      if (!startTs && !endTs) return true;
      if (!p.firstTimestamp && !p.lastTimestamp) return true; // no timestamps = always show
      var pStart = p.firstTimestamp || 0;
      var pEnd = p.lastTimestamp || Infinity;
      // Overlap check: pod range [pStart, pEnd] overlaps [startTs, endTs]
      if (endTs && pStart > endTs) return false;
      if (startTs && pEnd < startTs) return false;
      return true;
    });
    var plHtml = '';
    filteredPods.forEach(function(p) {
      var httpSummary = Object.keys(p.httpCodes || {}).sort(function(a,b){return (p.httpCodes[b]||0)-(p.httpCodes[a]||0);}).map(function(c){return c+':'+p.httpCodes[c];}).join(', ');
      var errStyle = p.errorLines > 0 ? ' style="color:var(--red)"' : '';
      var timeStr = '';
      if (p.firstTimestamp && p.lastTimestamp) {
        timeStr = fmtTime(p.firstTimestamp) + ' – ' + fmtTime(p.lastTimestamp);
      } else if (p.firstTimestamp) {
        timeStr = fmtTime(p.firstTimestamp) + ' – ?';
      }
      var podLabel = p.podName.length > 45 ? p.podName.substring(0,45) + '...' : p.podName;
      plHtml += '<tr><td><code>' + escHtml(podLabel) + '</code></td><td>' + escHtml(p.deployment) + '</td><td>' + numFmt(p.totalLines) + '</td><td' + errStyle + '>' + p.errorLines + '</td><td>' + p.warnLines + '</td><td>' + numFmt(p.apiRequests) + '</td><td>' + numFmt(p.healthChecks) + '</td><td style="font-size:0.75rem">' + (httpSummary||'-') + '</td><td style="font-size:0.75rem;white-space:nowrap">' + timeStr + '</td></tr>';
    });
    podLogsBody.innerHTML = plHtml || '<tr><td colspan="9" style="color:var(--muted)">No pod logs in selected time range</td></tr>';
    var plTitle = document.getElementById('pod-logs-title');
    if (plTitle) plTitle.textContent = 'Pod Logs (kubectl) — ' + filteredPods.length + ' of ' + REPORT_DATA.podLogs.length + ' pods';

    // Update Top API Endpoints from filtered pods
    var epBody = document.getElementById('top-endpoints-body');
    if (epBody) {
      var merged = {};
      filteredPods.forEach(function(p) {
        (p.topEndpoints || []).forEach(function(e) { merged[e.endpoint] = (merged[e.endpoint] || 0) + e.count; });
      });
      var sorted = Object.keys(merged).sort(function(a,b){return merged[b]-merged[a];}).slice(0,15);
      var epHtml = '';
      sorted.forEach(function(ep) {
        epHtml += '<tr><td><code>' + escHtml(ep) + '</code></td><td>' + numFmt(merged[ep]) + '</td></tr>';
      });
      epBody.innerHTML = epHtml || '<tr><td colspan="2" style="color:var(--muted)">No endpoints in selected range</td></tr>';
      var epTitle = document.getElementById('top-endpoints-title');
      if (epTitle) epTitle.textContent = 'Top API Endpoints (' + sorted.length + ' endpoints from ' + filteredPods.length + ' pods)';
    }
  }

  /* --- 16. Filter status bar --- */
  var parts = [];
  if (severity !== 'all') parts.push(severity + ' severity');
  if (category !== 'all') parts.push(category.replace(/_/g,' '));
  if (deployment !== 'all') parts.push(deployment.replace(/-deployment$/, ''));
  if (startTs || endTs) parts.push('time range');
  var statusEl = document.getElementById('filter-status');
  if (parts.length > 0) {
    statusEl.textContent = 'Active: ' + parts.join(' + ') + ' | ' + numFmt(totalFilteredErrors) + ' events | ' + visibleIssues + ' issues';
    statusEl.style.display = '';
  } else {
    statusEl.style.display = 'none';
  }
}

/* === Reset all filters === */
function resetFilters() {
  document.getElementById('filter-severity').value = 'all';
  document.getElementById('filter-category').value = 'all';
  if (document.getElementById('filter-deployment')) document.getElementById('filter-deployment').value = 'all';
  var bounds = getDataBounds();
  if (bounds.min) document.getElementById('filter-start').value = toLocalInput(new Date(bounds.min));
  if (bounds.max) document.getElementById('filter-end').value = toLocalInput(new Date(bounds.max));

  document.querySelectorAll('.issue-box').forEach(function(box) { box.style.display = ''; });
  document.getElementById('filter-status').style.display = 'none';
  highlightQuickBtn(null);
  applyFilters();
}

/* === Quick range buttons === */
function setQuickRange(minutes) {
  var bounds = getDataBounds();
  if (!bounds.max) return;

  // Anchor strategy: error data is the primary focus of this dashboard.
  // Always anchor the quick-range window at the error data end (+ small buffer)
  // so the window captures the most recent errors. This prevents the case where
  // metrics data extends beyond errors and pushes the window past all error data.
  // For very large ranges (24h+), use global max since it will cover everything anyway.
  var errBounds = bounds.errors;
  var hasErrors = errBounds.max > 0;
  var endMs;

  if (hasErrors && minutes <= 1440) {
    // Anchor at error data end + 5min buffer (capped at global max)
    endMs = Math.min(errBounds.max + 5 * 60 * 1000, bounds.max);
  } else {
    endMs = bounds.max;
  }
  var startMs = endMs - minutes * 60 * 1000;

  if (startMs < bounds.min) startMs = bounds.min;

  document.getElementById('filter-start').value = toLocalInput(new Date(startMs));
  document.getElementById('filter-end').value = toLocalInput(new Date(endMs));
  document.getElementById('filter-severity').value = 'all';
  document.getElementById('filter-category').value = 'all';
  highlightQuickBtn(minutes);
  applyFilters();
}

function highlightQuickBtn(minutes) {
  var btns = document.querySelectorAll('.btn-quick');
  btns.forEach(function(b) { b.classList.remove('btn-quick-active'); });
  if (minutes === null) {
    var allBtn = document.querySelector('.btn-quick:last-of-type');
    if (allBtn) allBtn.classList.add('btn-quick-active');
  } else {
    // Build label to match button text: 15m, 30m, 1h, 6h, 24h, 2d
    var label;
    if (minutes < 60) label = minutes + 'm';
    else if (minutes <= 1440) label = (minutes / 60) + 'h';
    else label = (minutes / 1440) + 'd';
    btns.forEach(function(b) {
      if (b.textContent.trim() === label) {
        b.classList.add('btn-quick-active');
      }
    });
  }
}

/* === Initial render of dynamic tables === */
applyFilters();
<\/script>
</body>
</html>`;

  fs.writeFileSync(outputPath, html, 'utf8');
}

module.exports = { generateReport };
