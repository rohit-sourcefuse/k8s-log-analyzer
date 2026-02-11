'use strict';

const fs = require('fs');
const readline = require('readline');
const { parseDbTimestamp } = require('../utils/time-utils');

const TIMESTAMP_RE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\w+\s+\d+\s+[\d:]+\s+\w+\s+\d{4}/;
const HEADER_RE = /^Id\s+User\s+Host/;

async function parseDbDebug(filePath, options = {}) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { snapshots: [], stats: { snapshotCount: 0 } };
  }

  const { onProgress } = options;
  const snapshots = [];
  let currentSnapshot = null;
  let lineCount = 0;

  const fileStream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const line of rl) {
    lineCount++;
    if (onProgress && lineCount % 5000 === 0) onProgress(lineCount);

    const trimmed = line.trim();
    if (!trimmed) continue;

    if (TIMESTAMP_RE.test(trimmed)) {
      if (currentSnapshot) snapshots.push(currentSnapshot);
      currentSnapshot = {
        timestamp: parseDbTimestamp(trimmed),
        connections: [],
        stats: { total: 0, sleeping: 0, active: 0, byDatabase: {}, longestConnection: 0 }
      };
      continue;
    }

    if (HEADER_RE.test(trimmed)) continue;

    if (currentSnapshot) {
      const parts = trimmed.split('\t');
      if (parts.length >= 5) {
        const conn = {
          id: parseInt(parts[0], 10) || 0,
          user: parts[1] || '',
          host: parts[2] || '',
          db: parts[3] === 'NULL' ? null : parts[3],
          command: parts[4] || '',
          time: parseInt(parts[5], 10) || 0,
          state: parts[6] === '' ? null : parts[6],
          info: parts[7] === 'NULL' ? null : parts[7]
        };

        currentSnapshot.connections.push(conn);
        currentSnapshot.stats.total++;
        if (conn.command === 'Sleep') currentSnapshot.stats.sleeping++;
        else currentSnapshot.stats.active++;
        if (conn.db) {
          currentSnapshot.stats.byDatabase[conn.db] = (currentSnapshot.stats.byDatabase[conn.db] || 0) + 1;
        }
        if (conn.time > currentSnapshot.stats.longestConnection) {
          currentSnapshot.stats.longestConnection = conn.time;
        }
      }
    }
  }

  if (currentSnapshot) snapshots.push(currentSnapshot);

  const stats = {
    snapshotCount: snapshots.length,
    timeRange: {
      start: snapshots[0]?.timestamp || null,
      end: snapshots[snapshots.length - 1]?.timestamp || null
    },
    avgConnectionsPerSnapshot: snapshots.length > 0
      ? Math.round(snapshots.reduce((s, snap) => s + snap.stats.total, 0) / snapshots.length)
      : 0
  };

  return { snapshots, stats };
}

module.exports = { parseDbDebug };
