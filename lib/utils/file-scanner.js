'use strict';

const fs = require('fs');
const path = require('path');

function scanDir(dirPath, results = []) {
  if (!fs.existsSync(dirPath)) return results;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      scanDir(fullPath, results);
    } else {
      results.push(fullPath);
    }
  }
  return results;
}

function scanLogArchive(rootPath) {
  const allFiles = scanDir(rootPath);
  const baseName = (f) => path.basename(f);
  const relPath = (f) => path.relative(rootPath, f);

  const seen = new Set();
  const dedup = (files) => {
    return files.filter(f => {
      const base = baseName(f);
      if (seen.has(base)) return false;
      seen.add(base);
      return true;
    });
  };

  const errorLogs = dedup(
    allFiles.filter(f => /errors_\d{8}_\d{6}\.log$/i.test(baseName(f)))
  ).sort();

  seen.clear();
  const metricsFiles = dedup(
    allFiles.filter(f => /metrics_\d{8}_\d{6}\.txt$/i.test(baseName(f)))
  ).sort();

  const dbDebugLog = allFiles.find(f => baseName(f) === 'db_debug.log') || null;

  const dashboardLogs = allFiles.filter(f =>
    /monitoring_dashboard.*\.log$/i.test(baseName(f))
  ).sort();

  const slowQueryLogs = allFiles.filter(f => {
    const rel = relPath(f);
    return rel.includes('slow_queries') && /\.log$/i.test(f);
  });

  const podLogs = allFiles.filter(f => {
    const rel = relPath(f);
    return rel.includes('pod_logs') && f.endsWith('.log');
  });

  const manifestFile = allFiles.find(f => baseName(f) === 'MANIFEST.txt') || null;
  const logSourcesFile = allFiles.find(f => baseName(f) === 'LOG_SOURCES.txt') || null;

  let manifestData = {};
  if (manifestFile) {
    try {
      const content = fs.readFileSync(manifestFile, 'utf8').trim();
      const match = content.match(/from\s+(\S+)\s+\((.+)\)/i);
      if (match) {
        manifestData = { source: match[1], timestamp: match[2] };
      } else {
        manifestData = { raw: content };
      }
    } catch (e) { /* ignore */ }
  }

  const genericLogs = allFiles.filter(f => {
    const base = baseName(f);
    return /\.log$/i.test(base) &&
      !errorLogs.includes(f) &&
      !dashboardLogs.includes(f) &&
      !slowQueryLogs.includes(f) &&
      !podLogs.includes(f) &&
      f !== dbDebugLog &&
      base !== 'MANIFEST.txt';
  });

  return {
    rootPath,
    manifestData,
    errorLogs,
    metricsFiles,
    dbDebugLog,
    dashboardLogs,
    slowQueryLogs,
    podLogs,
    genericLogs,
    totalFiles: allFiles.length
  };
}

module.exports = { scanLogArchive };
