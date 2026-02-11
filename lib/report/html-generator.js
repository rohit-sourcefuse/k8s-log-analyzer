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

    chartCanvases.push(`<div class="card"><h3>${esc(title)}</h3><div class="chart-container"><canvas id="${canvasId}"></canvas></div></div>`);
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
    <button class="btn-secondary" onclick="setQuickRange(15)" style="padding:5px 10px;font-size:0.78rem;">15m</button>
    <button class="btn-secondary" onclick="setQuickRange(30)" style="padding:5px 10px;font-size:0.78rem;">30m</button>
    <button class="btn-secondary" onclick="setQuickRange(60)" style="padding:5px 10px;font-size:0.78rem;">1h</button>
    <button class="btn-secondary" onclick="setQuickRange(360)" style="padding:5px 10px;font-size:0.78rem;">6h</button>
    <button class="btn-secondary" onclick="setQuickRange(1440)" style="padding:5px 10px;font-size:0.78rem;">24h</button>
    <button class="btn-secondary" onclick="setQuickRange(2880)" style="padding:5px 10px;font-size:0.78rem;">2d</button>
    <button class="btn-secondary" onclick="resetFilters()" style="padding:5px 10px;font-size:0.78rem;">All</button>
    <span class="filter-status" id="filter-status"></span>
  </div>
  <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
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
const REPORT_DATA = ${JSON.stringify({
    timeRange: { start: stats.firstTimestamp, end: stats.lastTimestamp },
    errorTimeline: errorAnalysis.timeline.map(t => ({ timestamp: t.timestamp, categories: t.categories })),
    categories: errorAnalysis.categories.map(c => ({ name: c.name, count: c.count }))
  })};

const allCharts = [];
${chartInits.map(c => c.replace('new Chart(', 'allCharts.push(new Chart(')).map(c => c.endsWith(';') ? c.slice(0, -1) + ');' : c + ')').join('\n')}

// Set datetime-local inputs to report time range in local timezone
(function initFilters() {
  const s = REPORT_DATA.timeRange.start;
  const e = REPORT_DATA.timeRange.end;
  if (s) {
    const d = new Date(s);
    document.getElementById('filter-start').value = toLocalInput(d);
  }
  if (e) {
    const d = new Date(e);
    document.getElementById('filter-end').value = toLocalInput(d);
  }
})();

function toLocalInput(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  const h = String(d.getHours()).padStart(2,'0');
  const min = String(d.getMinutes()).padStart(2,'0');
  return y+'-'+m+'-'+day+'T'+h+':'+min;
}

function applyFilters() {
  const severity = document.getElementById('filter-severity').value;
  const category = document.getElementById('filter-category').value;
  const startVal = document.getElementById('filter-start').value;
  const endVal = document.getElementById('filter-end').value;
  const startTs = startVal ? new Date(startVal).getTime() : null;
  const endTs = endVal ? new Date(endVal).getTime() : null;

  // Filter issues by severity
  const boxes = document.querySelectorAll('.issue-box');
  let visibleIssues = 0;
  boxes.forEach(box => {
    const sev = box.getAttribute('data-severity');
    const sevMatch = severity === 'all' || sev === severity;
    box.style.display = sevMatch ? '' : 'none';
    if (sevMatch) visibleIssues++;
  });

  // Filter timeline chart by date range and category
  if (REPORT_DATA.errorTimeline.length > 0 && allCharts.length > 0) {
    const timelineChart = allCharts.find(c => c.config.type === 'bar' && c.config.data.datasets.length > 1);
    if (timelineChart) {
      const filtered = REPORT_DATA.errorTimeline.filter(t => {
        if (startTs && t.timestamp < startTs) return false;
        if (endTs && t.timestamp > endTs) return false;
        return true;
      });
      timelineChart.data.labels = filtered.map(t => {
        const d = new Date(t.timestamp);
        return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
      });
      timelineChart.data.datasets.forEach(ds => {
        const catName = ds.label.replace(/ /g, '_');
        ds.data = filtered.map(t => t.categories[catName] || 0);
        if (category !== 'all') {
          ds.hidden = catName !== category;
        } else {
          ds.hidden = false;
        }
      });
      timelineChart.update();
    }

    // Update the doughnut chart for category filter
    const doughnutChart = allCharts.find(c => c.config.type === 'doughnut');
    if (doughnutChart && category !== 'all') {
      const catIdx = REPORT_DATA.categories.findIndex(c => c.name === category);
      doughnutChart.data.datasets[0].backgroundColor = REPORT_DATA.categories.slice(0,10).map((c, i) =>
        c.name === category ? ['#f85149','#d29922','#e3b341','#3fb950','#58a6ff','#bc8cff','#f778ba','#22d3ee','#e879f9','#84cc16'][i] : 'rgba(100,100,100,0.2)'
      );
      doughnutChart.update();
    } else if (doughnutChart) {
      doughnutChart.data.datasets[0].backgroundColor = ['#f85149','#d29922','#e3b341','#3fb950','#58a6ff','#bc8cff','#f778ba','#22d3ee','#e879f9','#84cc16'].slice(0, doughnutChart.data.labels.length);
      doughnutChart.update();
    }
  }

  // Show filter status
  const parts = [];
  if (severity !== 'all') parts.push(severity + ' severity');
  if (category !== 'all') parts.push(category.replace(/_/g,' '));
  if (startTs || endTs) parts.push('time range applied');
  const statusEl = document.getElementById('filter-status');
  if (parts.length > 0) {
    statusEl.textContent = 'Filtered: ' + parts.join(', ') + ' (' + visibleIssues + ' issues)';
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

  // Reset charts
  allCharts.forEach(c => {
    if (c.config.type === 'bar') {
      const orig = REPORT_DATA.errorTimeline;
      c.data.labels = orig.map(t => {
        const d = new Date(t.timestamp);
        return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
      });
      c.data.datasets.forEach(ds => {
        const catName = ds.label.replace(/ /g, '_');
        ds.data = orig.map(t => t.categories[catName] || 0);
        ds.hidden = false;
      });
    }
    if (c.config.type === 'doughnut') {
      c.data.datasets[0].backgroundColor = ['#f85149','#d29922','#e3b341','#3fb950','#58a6ff','#bc8cff','#f778ba','#22d3ee','#e879f9','#84cc16'].slice(0, c.data.labels.length);
    }
    c.update();
  });
}

function setQuickRange(minutes) {
  const end = REPORT_DATA.timeRange.end;
  if (!end) return;
  const endDate = new Date(end);
  const startDate = new Date(endDate.getTime() - minutes * 60 * 1000);
  document.getElementById('filter-start').value = toLocalInput(startDate);
  document.getElementById('filter-end').value = toLocalInput(endDate);
  applyFilters();
}
<\/script>
</body>
</html>`;

  fs.writeFileSync(outputPath, html, 'utf8');
}

module.exports = { generateReport };
