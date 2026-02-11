'use strict';

function analyzeDbConnections(snapshots) {
  if (!snapshots || snapshots.length === 0) {
    return { poolUsage: {}, longRunningQueries: [], connectionsByDatabase: {}, alerts: [], timeline: [] };
  }

  let totalActive = 0, totalIdle = 0, totalConns = 0;
  let peakActive = 0, peakTotal = 0;
  const dbCounts = {};
  const longRunningQueries = [];
  const timeline = [];

  for (const snap of snapshots) {
    const st = snap.stats;
    totalActive += st.active;
    totalIdle += st.sleeping;
    totalConns += st.total;
    if (st.active > peakActive) peakActive = st.active;
    if (st.total > peakTotal) peakTotal = st.total;

    for (const [db, count] of Object.entries(st.byDatabase)) {
      if (!dbCounts[db]) dbCounts[db] = { total: 0, snapshots: 0, peak: 0 };
      dbCounts[db].total += count;
      dbCounts[db].snapshots++;
      if (count > dbCounts[db].peak) dbCounts[db].peak = count;
    }

    for (const conn of snap.connections) {
      if (conn.time > 60 && conn.command !== 'Sleep' && conn.command !== 'Daemon') {
        longRunningQueries.push({
          timestamp: snap.timestamp,
          id: conn.id,
          user: conn.user,
          db: conn.db,
          duration: conn.time,
          command: conn.command,
          query: conn.info ? conn.info.substring(0, 200) : null
        });
      }
    }

    timeline.push({
      timestamp: snap.timestamp,
      total: st.total,
      active: st.active,
      sleeping: st.sleeping,
      longestSec: st.longestConnection
    });
  }

  const n = snapshots.length;
  const poolUsage = {
    avgActive: Math.round(totalActive / n * 10) / 10,
    avgIdle: Math.round(totalIdle / n * 10) / 10,
    avgTotal: Math.round(totalConns / n * 10) / 10,
    peakActive,
    peakTotal
  };

  const connectionsByDatabase = Object.entries(dbCounts)
    .map(([db, data]) => ({
      database: db,
      avgConnections: Math.round(data.total / data.snapshots * 10) / 10,
      peakConnections: data.peak
    }))
    .sort((a, b) => b.peakConnections - a.peakConnections);

  const alerts = [];
  if (peakActive > 50) {
    alerts.push({ severity: 'high', message: `Peak active DB connections: ${peakActive}` });
  }
  if (longRunningQueries.length > 0) {
    const maxDuration = Math.max(...longRunningQueries.map(q => q.duration));
    alerts.push({ severity: 'medium', message: `${longRunningQueries.length} long-running queries detected (max ${maxDuration}s)` });
  }

  const uniqueLong = [];
  const seen = new Set();
  for (const q of longRunningQueries.sort((a, b) => b.duration - a.duration)) {
    const key = `${q.db}:${q.query}`;
    if (!seen.has(key)) { seen.add(key); uniqueLong.push(q); }
    if (uniqueLong.length >= 20) break;
  }

  return { poolUsage, longRunningQueries: uniqueLong, connectionsByDatabase, alerts, timeline };
}

module.exports = { analyzeDbConnections };
