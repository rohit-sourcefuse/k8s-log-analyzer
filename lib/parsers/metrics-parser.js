'use strict';

const fs = require('fs');
const path = require('path');
const { parseCpu, parseMemory, parsePercent, parseIntSafe } = require('./parser-utils');
const { parseMetricsTimestamp } = require('../utils/time-utils');

function parseMetricsFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');

  const snapshot = {
    timestamp: null,
    file: path.basename(filePath),
    nodes: [],
    pods: [],
    deployments: [],
    podStatus: { running: 0, pending: 0, failed: 0 },
    dbPoolSummary: { available: false, error: null },
    dbConnections: [],
    podConfig: []
  };

  let section = null;
  let headerParsed = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (/METRICS.*namespace.*\d{4}-\d{2}-\d{2}/.test(trimmed)) {
      snapshot.timestamp = parseMetricsTimestamp(trimmed);
      continue;
    }

    if (/^---\s*NODES/.test(trimmed)) { section = 'nodes'; headerParsed = false; continue; }
    if (/^---\s*PODS.*CPU.*Memory/i.test(trimmed)) { section = 'pods'; headerParsed = false; continue; }
    if (/^---\s*DEPLOYMENTS/i.test(trimmed)) { section = 'deployments'; headerParsed = false; continue; }
    if (/^---\s*POD STATUS/i.test(trimmed)) { section = 'podStatus'; continue; }
    if (/^---\s*DB CONNECTION POOL.*Summary/i.test(trimmed)) { section = 'dbPoolSummary'; continue; }
    if (/^---\s*DB CONNECTIONS.*Per Pod/i.test(trimmed)) { section = 'dbConnections'; headerParsed = false; continue; }
    if (/^---\s*POD CONFIG/i.test(trimmed)) { section = 'podConfig'; headerParsed = false; continue; }
    if (/^={5,}/.test(trimmed) || !trimmed) continue;

    if (section === 'nodes') {
      if (/^NAME\s/.test(trimmed)) { headerParsed = true; continue; }
      if (!headerParsed) continue;
      const parts = trimmed.split(/\s+/).filter(Boolean);
      if (parts.length >= 5) {
        snapshot.nodes.push({
          name: parts[0],
          cpuMillicores: parseCpu(parts[1]),
          cpuPercent: parsePercent(parts[2]),
          memoryMi: parseMemory(parts[3]),
          memoryPercent: parsePercent(parts[4])
        });
      }
    }

    if (section === 'pods') {
      const parts = trimmed.split(/\s+/).filter(Boolean);
      if (parts.length >= 3 && /\d+m?$/.test(parts[1])) {
        snapshot.pods.push({
          name: parts[0],
          cpuMillicores: parseCpu(parts[1]),
          memoryMi: parseMemory(parts[2])
        });
      }
    }

    if (section === 'deployments') {
      if (/^DEPLOYMENT\s/.test(trimmed)) { headerParsed = true; continue; }
      if (!headerParsed) continue;
      const parts = trimmed.split(/\s+/).filter(Boolean);
      if (parts.length >= 3) {
        const name = parts[0];
        const desired = parseIntSafe(parts[1]);
        const ready = parseIntSafe(parts[2]);
        snapshot.deployments.push({
          name,
          desired,
          ready,
          cpuRequest: parts[3] ? parseCpu(parts[3]) : null,
          cpuLimit: parts[4] ? parseCpu(parts[4]) : null,
          memRequest: parts[5] ? parseMemory(parts[5]) : null,
          memLimit: parts[6] ? parseMemory(parts[6]) : null
        });
      }
    }

    if (section === 'podStatus') {
      const match = trimmed.match(/(\d+)\s+(Running|Pending|Failed|CrashLoopBackOff)/i);
      if (match) {
        const count = parseInt(match[1], 10);
        const status = match[2].toLowerCase();
        if (status === 'running') snapshot.podStatus.running += count;
        else if (status === 'pending') snapshot.podStatus.pending += count;
        else snapshot.podStatus.failed += count;
      }
    }

    if (section === 'dbPoolSummary') {
      if (/DB query failed/i.test(trimmed)) {
        snapshot.dbPoolSummary.error = 'DB query failed';
      } else if (/\d/.test(trimmed)) {
        snapshot.dbPoolSummary.available = true;
      }
    }

    if (section === 'dbConnections') {
      if (/^POD_NAME/.test(trimmed)) { headerParsed = true; continue; }
      if (!headerParsed) continue;
      const parts = trimmed.split(/\s+/).filter(Boolean);
      if (parts.length >= 4) {
        const numericParts = parts.slice(-4);
        const podParts = parts.slice(0, -4);
        const total = parseIntSafe(numericParts[0]);
        if (total !== null) {
          snapshot.dbConnections.push({
            pod: podParts.join(' ') || 'unknown',
            total,
            idle: parseIntSafe(numericParts[1]) || 0,
            active: parseIntSafe(numericParts[2]) || 0,
            maxSec: parseIntSafe(numericParts[3]) || 0
          });
        }
      }
    }

    if (section === 'podConfig') {
      if (/^DEPLOYMENT/.test(trimmed)) { headerParsed = true; continue; }
      if (!headerParsed) continue;
      const parts = trimmed.split(/\s+/).filter(Boolean);
      if (parts.length >= 2) {
        snapshot.podConfig.push({
          deployment: parts[0],
          dbPoolMax: parseIntSafe(parts[1]),
          dbPoolMin: parseIntSafe(parts[2]),
          dbMaxConn: parseIntSafe(parts[3]),
          acquireMs: parseIntSafe(parts[4]),
          idleMs: parseIntSafe(parts[5])
        });
      }
    }
  }

  return snapshot;
}

function parseAllMetrics(filePaths) {
  const snapshots = filePaths.map(f => parseMetricsFile(f));
  snapshots.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  const stats = {
    snapshotCount: snapshots.length,
    timeRange: {
      start: snapshots[0]?.timestamp || null,
      end: snapshots[snapshots.length - 1]?.timestamp || null
    },
    nodeCount: snapshots[0]?.nodes?.length || 0,
    podCount: snapshots.reduce((max, s) => Math.max(max, s.pods.length), 0)
  };

  return { snapshots, stats };
}

module.exports = { parseMetricsFile, parseAllMetrics };
