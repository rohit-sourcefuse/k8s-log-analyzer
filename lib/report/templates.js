'use strict';

function getCssStyles() {
  return `
  :root { --bg:#0d1117; --surface:#161b22; --surface2:#21262d; --surface3:#30363d; --text:#e6edf3; --muted:#8b949e; --accent:#58a6ff; --red:#f85149; --orange:#d29922; --yellow:#e3b341; --green:#3fb950; --purple:#bc8cff; --pink:#f778ba; --border:#30363d; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif; background:var(--bg); color:var(--text); padding:24px; max-width:1600px; margin:0 auto; line-height:1.5; }
  h1 { text-align:center; font-size:1.6rem; font-weight:600; margin-bottom:4px; }
  .subtitle { text-align:center; color:var(--muted); margin-bottom:24px; font-size:0.85rem; word-break:break-all; }
  .grid { display:grid; gap:16px; margin-bottom:24px; }
  .grid-4 { grid-template-columns:repeat(4,1fr); }
  .grid-2 { grid-template-columns:repeat(2,1fr); }
  .grid-3 { grid-template-columns:repeat(3,1fr); }
  .card { background:var(--surface); border-radius:8px; padding:20px; border:1px solid var(--border); }
  .card h3 { color:var(--accent); font-size:0.8rem; text-transform:uppercase; letter-spacing:0.8px; margin-bottom:14px; font-weight:600; }
  .stat-card { text-align:center; padding:24px 16px; }
  .stat-card .value { font-size:2rem; font-weight:700; font-variant-numeric:tabular-nums; }
  .stat-card .label { color:var(--muted); font-size:0.8rem; margin-top:6px; text-transform:capitalize; }
  .sev-critical .value { color:var(--red); }
  .sev-high .value { color:var(--orange); }
  .sev-medium .value { color:var(--yellow); }
  .sev-low .value { color:var(--green); }
  table { width:100%; border-collapse:collapse; font-size:0.85rem; }
  th { color:var(--accent); text-align:left; padding:10px 12px; border-bottom:1px solid var(--border); font-weight:600; font-size:0.8rem; text-transform:uppercase; letter-spacing:0.5px; }
  td { padding:10px 12px; border-bottom:1px solid var(--surface2); }
  tr:hover td { background:rgba(88,166,255,0.04); }
  .badge { display:inline-block; padding:3px 10px; border-radius:20px; font-size:0.7rem; font-weight:600; text-transform:uppercase; letter-spacing:0.3px; }
  .badge-critical { background:rgba(248,81,73,0.15); color:var(--red); border:1px solid rgba(248,81,73,0.3); }
  .badge-high { background:rgba(210,153,34,0.15); color:var(--orange); border:1px solid rgba(210,153,34,0.3); }
  .badge-medium { background:rgba(227,179,65,0.15); color:var(--yellow); border:1px solid rgba(227,179,65,0.3); }
  .badge-low { background:rgba(63,185,80,0.15); color:var(--green); border:1px solid rgba(63,185,80,0.3); }
  .issue-box { background:var(--surface2); border-radius:8px; padding:16px 20px; margin-bottom:14px; border-left:4px solid var(--red); transition:all 0.2s; }
  .issue-box:hover { background:var(--surface3); }
  .issue-box.high { border-left-color:var(--orange); }
  .issue-box.medium { border-left-color:var(--yellow); }
  .issue-box.low { border-left-color:var(--green); }
  .issue-box h4 { font-size:0.95rem; margin-bottom:8px; font-weight:600; }
  .issue-box p { font-size:0.85rem; color:var(--muted); line-height:1.6; margin-bottom:4px; }
  .issue-box p strong { color:var(--text); }
  .issue-box ul { margin:4px 0 8px 20px; font-size:0.83rem; color:var(--muted); line-height:1.6; }
  .issue-box .meta { display:flex; gap:12px; margin-top:10px; font-size:0.8rem; flex-wrap:wrap; align-items:center; }
  .chart-container { position:relative; height:320px; }
  .rec-item { background:var(--surface2); border:1px solid var(--border); border-radius:8px; padding:14px 18px; margin-bottom:10px; transition:background 0.2s; }
  .rec-item:hover { background:var(--surface3); }
  .rec-item strong { color:var(--accent); }
  .rec-item .rec-meta { font-size:0.8rem; color:var(--muted); margin-top:6px; }
  .filter-bar { background:var(--surface); border-radius:8px; padding:14px 20px; margin-bottom:24px; border:1px solid var(--border); display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
  .filter-bar label { color:var(--muted); font-size:0.82rem; font-weight:500; white-space:nowrap; }
  .filter-bar input, .filter-bar select { background:var(--surface2); border:1px solid var(--border); color:var(--text); padding:6px 10px; border-radius:6px; font-size:0.82rem; }
  .filter-bar input:focus, .filter-bar select:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 2px rgba(88,166,255,0.2); }
  .filter-bar .btn-primary { background:var(--accent); color:#0d1117; border:none; padding:7px 16px; border-radius:6px; font-weight:600; cursor:pointer; font-size:0.82rem; transition:opacity 0.2s; }
  .filter-bar .btn-primary:hover { opacity:0.85; }
  .filter-bar .btn-secondary { background:var(--surface2); color:var(--text); border:1px solid var(--border); padding:7px 16px; border-radius:6px; font-weight:500; cursor:pointer; font-size:0.82rem; transition:background 0.2s; }
  .filter-bar .btn-secondary:hover { background:var(--surface3); }
  .btn-quick-active { background:var(--accent) !important; color:#0d1117 !important; border-color:var(--accent) !important; }
  .filter-active { border-color:var(--accent) !important; box-shadow:0 0 0 1px var(--accent); }
  code { background:var(--surface2); padding:2px 6px; border-radius:4px; font-size:0.83em; font-family:'SFMono-Regular',Consolas,monospace; }
  .section-title { font-size:1.1rem; font-weight:600; margin:32px 0 16px 0; padding-bottom:10px; border-bottom:1px solid var(--border); }
  .filter-status { font-size:0.8rem; color:var(--accent); padding:4px 10px; background:rgba(88,166,255,0.1); border-radius:4px; display:none; }
  .hidden { display:none !important; }
  @media(max-width:1200px) { .grid-4{grid-template-columns:repeat(2,1fr);} }
  @media(max-width:900px) { .grid-4{grid-template-columns:repeat(2,1fr);} .grid-2,.grid-3{grid-template-columns:1fr;} }
  @media(max-width:600px) { .grid-4{grid-template-columns:1fr;} body{padding:12px;} .filter-bar{flex-direction:column;align-items:stretch;} }
  `;
}

function getIssueSeverityClass(severity) {
  if (severity === 'critical') return '';
  return severity;
}

function renderIssueCard(issue) {
  const cls = getIssueSeverityClass(issue.severity);
  const evidence = (issue.evidence || []).map(e => `<li>${esc(e)}</li>`).join('');
  const services = (issue.affectedServices || []).join(',');
  return `
    <div class="issue-box ${cls}" data-severity="${issue.severity}" data-services="${esc(services)}">
      <h4>${esc(issue.id)}: ${esc(issue.title)}</h4>
      <p><strong>Description:</strong> ${esc(issue.description)}</p>
      ${evidence ? `<p><strong>Evidence:</strong></p><ul>${evidence}</ul>` : ''}
      <p><strong>Impact:</strong> ${esc(issue.impact || '')}</p>
      ${issue.rootCause ? `<p><strong>Root Cause:</strong> ${esc(issue.rootCause)}</p>` : ''}
      ${issue.action ? `<p><strong>Action:</strong> ${esc(issue.action)}</p>` : ''}
      <div class="meta">
        <span class="badge badge-${issue.severity}">${issue.severity.toUpperCase()}</span>
        ${(issue.affectedServices || []).length > 0 ? `<span style="color:var(--muted)">Services: ${issue.affectedServices.join(', ')}</span>` : ''}
      </div>
    </div>`;
}

function renderRecommendation(rec, index) {
  const pLabel = rec.priority >= 8 ? 'P0' : rec.priority >= 5 ? 'P1' : rec.priority >= 3 ? 'P2' : 'P3';
  return `
    <div class="rec-item">
      <strong>${pLabel} [${esc(rec.category)}]:</strong> ${esc(rec.action)}
      <div class="rec-meta">Rationale: ${esc(rec.rationale)} | Effort: ${rec.effort} | Impact: ${rec.impact}</div>
    </div>`;
}

function renderStatCard(value, label, sevClass) {
  return `
    <div class="card stat-card ${sevClass}">
      <div class="value">${value}</div>
      <div class="label">${esc(label)}</div>
    </div>`;
}

function esc(text) {
  if (!text) return '';
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = { getCssStyles, renderIssueCard, renderRecommendation, renderStatCard, esc };
