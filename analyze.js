#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');

const { scanLogArchive } = require('./lib/utils/file-scanner');
const { parseAllErrorLogs } = require('./lib/parsers/error-log-parser');
const { parseAllMetrics } = require('./lib/parsers/metrics-parser');
const { parseDbDebug } = require('./lib/parsers/db-debug-parser');
const { classifyErrors } = require('./lib/analyzers/error-classifier');
const { analyzeMetrics } = require('./lib/analyzers/metrics-analyzer');
const { analyzeDbConnections } = require('./lib/analyzers/db-analyzer');
const { detectIssues } = require('./lib/analyzers/issue-detector');
const { generateRecommendations } = require('./lib/analyzers/recommendation-engine');
const { generateReport } = require('./lib/report/html-generator');

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = { logDir: null, output: null, startTime: null, endTime: null, help: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') { options.help = true; }
    else if ((arg === '--output' || arg === '-o') && args[i + 1]) { options.output = args[++i]; }
    else if ((arg === '--start' || arg === '-s') && args[i + 1]) { options.startTime = args[++i]; }
    else if ((arg === '--end' || arg === '-e') && args[i + 1]) { options.endTime = args[++i]; }
    else if (!arg.startsWith('-')) { options.logDir = arg; }
  }

  return options;
}

function printUsage() {
  console.log(`
  k8s-log-analyzer - Analyze Kubernetes monitoring logs and generate HTML dashboards

  USAGE:
    k8s-log-analyzer <log-directory> [options]
    node analyze.js <log-directory> [options]

  OPTIONS:
    -o, --output <path>    Output HTML file path (default: <log-dir>/log-analysis-report.html)
    -s, --start <datetime> Filter logs from this time (ISO 8601, e.g. 2026-02-11T14:00:00Z)
    -e, --end <datetime>   Filter logs until this time (ISO 8601)
    -h, --help             Show this help message

  EXAMPLES:
    k8s-log-analyzer ./monitor-logs_20260211_204624/
    k8s-log-analyzer ./logs/ -o report.html
    k8s-log-analyzer ./logs/ --start 2026-02-11T14:00:00Z --end 2026-02-11T15:00:00Z

  SUPPORTED LOG TYPES:
    - errors_*.log         Kubernetes pod error streams (Redis, MySQL, timeout, OOM, 5xx, etc.)
    - metrics_*.txt        Cluster metrics snapshots (CPU, memory, replicas, DB pools)
    - db_debug.log         MySQL processlist snapshots
    - monitoring_dashboard_*.log  Dashboard terminal output
    - slow_queries/        Slow query logs
    - pod_logs/            Raw kubectl logs

  INSTALL GLOBALLY:
    cd log-analyzer && npm link
    # Then use from anywhere:
    k8s-log-analyzer /path/to/logs/
  `);
}

function log(msg) {
  process.stdout.write(`  ${msg}\n`);
}

function progress(current, file) {
  process.stdout.write(`\r  Parsing ${file}... ${current.toLocaleString()} lines`);
}

async function main() {
  const startMs = Date.now();
  const options = parseArgs(process.argv);

  if (options.help || !options.logDir) {
    printUsage();
    process.exit(options.help ? 0 : 1);
  }

  const logDir = path.resolve(options.logDir);
  if (!fs.existsSync(logDir)) {
    console.error(`Error: Directory not found: ${logDir}`);
    process.exit(1);
  }

  const outputPath = options.output
    ? path.resolve(options.output)
    : path.join(logDir, 'log-analysis-report.html');

  console.log('\n  K8s Log Analyzer');
  console.log('  ================\n');
  log(`Input:  ${logDir}`);
  log(`Output: ${outputPath}`);
  if (options.startTime) log(`Start:  ${options.startTime}`);
  if (options.endTime) log(`End:    ${options.endTime}`);
  console.log('');

  // Step 1: Scan
  log('Scanning log archive...');
  const manifest = scanLogArchive(logDir);
  log(`  Found ${manifest.errorLogs.length} error logs, ${manifest.metricsFiles.length} metrics files`);
  if (manifest.dbDebugLog) log(`  Found DB debug log`);
  if (manifest.slowQueryLogs.length > 0) log(`  Found ${manifest.slowQueryLogs.length} slow query logs`);
  console.log('');

  // Step 2: Parse error logs
  let errorData = { events: [], stats: { totalLines: 0, errorCount: 0, warningCount: 0, byPod: {}, byDeployment: {}, byCategory: {}, firstTimestamp: null, lastTimestamp: null, fileCount: 0, files: [] } };
  if (manifest.errorLogs.length > 0) {
    log('Parsing error logs...');
    errorData = await parseAllErrorLogs(manifest.errorLogs, {
      startTime: options.startTime,
      endTime: options.endTime,
      onProgress: progress
    });
    process.stdout.write('\n');
    log(`  ${errorData.stats.totalLines.toLocaleString()} lines, ${errorData.events.length.toLocaleString()} events parsed`);
    console.log('');
  }

  // Step 3: Parse metrics
  let metricsData = { snapshots: [], stats: { snapshotCount: 0 } };
  if (manifest.metricsFiles.length > 0) {
    log('Parsing metrics snapshots...');
    metricsData = parseAllMetrics(manifest.metricsFiles);
    log(`  ${metricsData.stats.snapshotCount} snapshots parsed`);
    console.log('');
  }

  // Step 4: Parse DB debug
  let dbData = { snapshots: [], stats: { snapshotCount: 0 } };
  if (manifest.dbDebugLog) {
    log('Parsing database debug log...');
    dbData = await parseDbDebug(manifest.dbDebugLog, {
      onProgress: (n) => process.stdout.write(`\r  Parsing db_debug.log... ${n.toLocaleString()} lines`)
    });
    process.stdout.write('\n');
    log(`  ${dbData.stats.snapshotCount} snapshots parsed`);
    console.log('');
  }

  // Step 5: Analyze
  log('Classifying errors...');
  const errorAnalysis = classifyErrors(errorData.events);
  log(`  ${errorAnalysis.categories.length} error categories detected`);

  log('Analyzing metrics...');
  const metricsAnalysis = analyzeMetrics(metricsData.snapshots);
  log(`  ${metricsAnalysis.scalingEvents.length} scaling events, ${metricsAnalysis.hotPods.length} hot pods`);

  log('Analyzing database connections...');
  const dbAnalysis = analyzeDbConnections(dbData.snapshots);

  log('Detecting issues...');
  const { issues } = detectIssues(errorAnalysis, metricsAnalysis, dbAnalysis);
  log(`  ${issues.length} issues found`);

  log('Generating recommendations...');
  const { recommendations } = generateRecommendations(issues);
  log(`  ${recommendations.length} recommendations`);
  console.log('');

  // Step 6: Generate report
  log('Generating HTML report...');
  await generateReport({
    manifestData: manifest.manifestData,
    errorAnalysis,
    metricsAnalysis,
    dbAnalysis,
    issues,
    recommendations,
    stats: errorData.stats
  }, outputPath);

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);

  console.log('');
  console.log('  ============ SUMMARY ============');
  console.log(`  Lines analyzed:   ${errorData.stats.totalLines.toLocaleString()}`);
  console.log(`  Events parsed:    ${errorData.events.length.toLocaleString()}`);
  console.log(`  Error categories: ${errorAnalysis.categories.length}`);
  console.log(`  Issues found:     ${issues.length}`);
  const critical = issues.filter(i => i.severity === 'critical').length;
  const high = issues.filter(i => i.severity === 'high').length;
  if (critical > 0) console.log(`  Critical issues:  ${critical}`);
  if (high > 0) console.log(`  High issues:      ${high}`);
  console.log(`  Time taken:       ${elapsed}s`);
  console.log(`  Report:           ${outputPath}`);
  console.log('  =================================\n');
}

main().catch(err => {
  console.error('\n  Fatal error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
