'use strict';

function parseIsoTimestamp(str) {
  if (!str) return null;
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

function parseDbTimestamp(str) {
  if (!str) return null;
  const cleaned = str.trim();
  const d = new Date(cleaned);
  return isNaN(d.getTime()) ? null : d;
}

function parseMetricsTimestamp(str) {
  if (!str) return null;
  const match = str.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/);
  if (!match) return null;
  const d = new Date(match[1].replace(' ', 'T') + 'Z');
  return isNaN(d.getTime()) ? null : d;
}

function parseFilenameTimestamp(filename) {
  const match = filename.match(/(\d{8})_(\d{6})/);
  if (!match) return null;
  const ds = match[1];
  const ts = match[2];
  const iso = `${ds.slice(0,4)}-${ds.slice(4,6)}-${ds.slice(6,8)}T${ts.slice(0,2)}:${ts.slice(2,4)}:${ts.slice(4,6)}Z`;
  return new Date(iso);
}

function bucketByInterval(events, intervalMs) {
  const buckets = new Map();
  for (const evt of events) {
    const ts = evt.timestamp instanceof Date ? evt.timestamp.getTime() : new Date(evt.timestamp).getTime();
    if (isNaN(ts)) continue;
    const key = Math.floor(ts / intervalMs) * intervalMs;
    if (!buckets.has(key)) {
      buckets.set(key, []);
    }
    buckets.get(key).push(evt);
  }
  return Array.from(buckets.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([ts, evts]) => ({ timestamp: new Date(ts), events: evts }));
}

function formatTimestamp(date) {
  if (!date) return 'N/A';
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return 'N/A';
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z/, ' UTC');
}

function formatDuration(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function isInTimeRange(timestamp, startTime, endTime) {
  const ts = timestamp instanceof Date ? timestamp.getTime() : new Date(timestamp).getTime();
  if (startTime && ts < new Date(startTime).getTime()) return false;
  if (endTime && ts > new Date(endTime).getTime()) return false;
  return true;
}

module.exports = {
  parseIsoTimestamp,
  parseDbTimestamp,
  parseMetricsTimestamp,
  parseFilenameTimestamp,
  bucketByInterval,
  formatTimestamp,
  formatDuration,
  isInTimeRange
};
