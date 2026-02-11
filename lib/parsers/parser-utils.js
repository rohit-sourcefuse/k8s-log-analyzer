'use strict';

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m|\[(?:\d+m)?(?:error|warn|info|debug)(?:\x1b\[\d+m)?/gi;

function stripAnsi(text) {
  return text.replace(ANSI_RE, '').replace(/\[\d+m/g, '');
}

function parseCpu(text) {
  if (!text || text === '-') return null;
  text = text.trim();
  const mMatch = text.match(/^(\d+)m$/);
  if (mMatch) return parseInt(mMatch[1], 10);
  const numMatch = text.match(/^(\d+(?:\.\d+)?)$/);
  if (numMatch) return Math.round(parseFloat(numMatch[1]) * 1000);
  return null;
}

function parseMemory(text) {
  if (!text || text === '-') return null;
  text = text.trim();
  const miMatch = text.match(/^(\d+)Mi$/);
  if (miMatch) return parseInt(miMatch[1], 10);
  const giMatch = text.match(/^(\d+(?:\.\d+)?)Gi$/);
  if (giMatch) return Math.round(parseFloat(giMatch[1]) * 1024);
  const kiMatch = text.match(/^(\d+)Ki$/);
  if (kiMatch) return Math.round(parseInt(kiMatch[1], 10) / 1024);
  return null;
}

function parsePercent(text) {
  if (!text || text === '-') return null;
  const match = text.trim().match(/(\d+)%/);
  return match ? parseInt(match[1], 10) : null;
}

function parseIntSafe(text) {
  if (!text || text === '-') return null;
  const n = parseInt(text.trim(), 10);
  return isNaN(n) ? null : n;
}

function extractPodInfo(podName) {
  if (!podName) return { pod: null, deployment: null, replicaSet: null };
  const parts = podName.split('-');
  if (parts.length < 3) return { pod: podName, deployment: podName, replicaSet: null };
  const podHash = parts[parts.length - 1];
  const rsHash = parts[parts.length - 2];
  const deployment = parts.slice(0, -2).join('-');
  return { pod: podName, deployment, replicaSet: rsHash };
}

function extractDeploymentName(podName) {
  const { deployment } = extractPodInfo(podName);
  return deployment || podName;
}

module.exports = {
  stripAnsi,
  parseCpu,
  parseMemory,
  parsePercent,
  parseIntSafe,
  extractPodInfo,
  extractDeploymentName
};
