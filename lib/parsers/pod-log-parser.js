'use strict';

const fs = require('fs');
const readline = require('readline');
const path = require('path');
const { extractDeploymentName } = require('./parser-utils');

/**
 * Parse kubectl pod log files from pod_logs/ directory.
 * Extracts per-pod summary: line counts, error counts, request patterns,
 * service name, and notable events (model loads, timeouts, etc.)
 */
async function parsePodLogs(podLogFiles, options = {}) {
  const results = [];

  for (const filePath of podLogFiles) {
    const podName = path.basename(filePath, '.log');
    const deployment = extractDeploymentName(podName);

    const summary = {
      podName,
      deployment,
      filePath,
      totalLines: 0,
      errorLines: 0,
      warnLines: 0,
      infoLines: 0,
      healthChecks: 0,
      apiRequests: 0,
      serviceName: null,
      firstTimestamp: null,
      lastTimestamp: null,
      errors: [],        // unique error messages (max 10)
      httpCodes: {},      // { 200: count, 500: count, ... }
      endpoints: {},      // { 'GET /api/v1/process': count, ... }
      notableEvents: []   // model loads, unloads, crashes
    };

    const errorSet = new Set();

    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      summary.totalLines++;
      if (!line.trim()) continue;

      // Extract timestamp patterns
      // Format 1: 2026-02-12 12:30:17 [info]: ...
      // Format 2: {"timestamp":"2026-02-12T12:29:23.350Z"}
      // Format 3: 2026-02-12 10:01:06 [debug    ] ...
      let ts = null;
      const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})/);
      if (tsMatch) {
        ts = new Date(tsMatch[1].replace(' ', 'T') + (tsMatch[1].includes('T') ? '' : 'Z'));
        if (!isNaN(ts.getTime())) {
          if (!summary.firstTimestamp || ts < summary.firstTimestamp) summary.firstTimestamp = ts;
          if (!summary.lastTimestamp || ts > summary.lastTimestamp) summary.lastTimestamp = ts;
        }
      } else {
        // Try JSON timestamp
        const jsonTs = line.match(/"timestamp"\s*:\s*"([^"]+)"/);
        if (jsonTs) {
          ts = new Date(jsonTs[1]);
          if (!isNaN(ts.getTime())) {
            if (!summary.firstTimestamp || ts < summary.firstTimestamp) summary.firstTimestamp = ts;
            if (!summary.lastTimestamp || ts > summary.lastTimestamp) summary.lastTimestamp = ts;
          }
        }
      }

      // Classify line level
      if (/\[31merror\[39m|\[error\]|\berror\b/i.test(line) && !/ELB-HealthChecker/i.test(line)) {
        summary.errorLines++;
        // Collect unique error messages
        const errMsg = line.replace(/\[.*?\]/g, '').replace(/\{.*\}$/s, '').trim().substring(0, 150);
        if (!errorSet.has(errMsg) && errorSet.size < 10) {
          errorSet.add(errMsg);
          summary.errors.push({ message: errMsg, timestamp: ts ? ts.toISOString() : null });
        }
      } else if (/\[33mwarn\[39m|\[warn\]|\bwarn(ing)?\b/i.test(line)) {
        summary.warnLines++;
      } else if (/\[32minfo\[39m|\[info\]|INFO:/i.test(line)) {
        summary.infoLines++;
      }

      // Health check detection
      if (/ELB-HealthChecker|health|readiness|liveness/i.test(line) && /GET\s+\//i.test(line)) {
        summary.healthChecks++;
      }

      // HTTP request/response patterns
      const httpMatch = line.match(/"(GET|POST|PUT|DELETE|PATCH)\s+([^\s"]+)\s+HTTP\/\d\.\d"\s+(\d{3})/);
      if (httpMatch) {
        const method = httpMatch[1];
        const endpoint = httpMatch[2].split('?')[0]; // strip query params
        const code = httpMatch[3];

        summary.httpCodes[code] = (summary.httpCodes[code] || 0) + 1;

        // Skip health checks for endpoint tracking
        if (endpoint !== '/' && !/health|readiness|liveness/i.test(endpoint)) {
          summary.apiRequests++;
          const key = `${method} ${endpoint.length > 60 ? endpoint.substring(0, 60) + '...' : endpoint}`;
          summary.endpoints[key] = (summary.endpoints[key] || 0) + 1;
        }
      }

      // Alternative HTTP pattern: INFO: ip:port - "METHOD /path HTTP/1.1" code
      const httpAlt = line.match(/INFO:\s+[\d.]+:\d+\s+-\s+"(GET|POST|PUT|DELETE|PATCH)\s+([^\s"]+)\s+HTTP\/\d\.\d"\s+(\d{3})/);
      if (httpAlt) {
        const method = httpAlt[1];
        const endpoint = httpAlt[2].split('?')[0];
        const code = httpAlt[3];
        summary.httpCodes[code] = (summary.httpCodes[code] || 0) + 1;
        if (!/metrics|health/i.test(endpoint)) {
          summary.apiRequests++;
          const key = `${method} ${endpoint.length > 60 ? endpoint.substring(0, 60) + '...' : endpoint}`;
          summary.endpoints[key] = (summary.endpoints[key] || 0) + 1;
        }
      }

      // Service name extraction
      if (!summary.serviceName) {
        const svcMatch = line.match(/"service"\s*:\s*"([^"]+)"/);
        if (svcMatch) summary.serviceName = svcMatch[1];
      }

      // Notable events
      if (/model.*unloaded|model.*loaded|cleanup.*models/i.test(line)) {
        summary.notableEvents.push({
          type: 'model_lifecycle',
          message: line.replace(/\{.*\}$/s, '').trim().substring(0, 150),
          timestamp: ts ? ts.toISOString() : null
        });
      }
      if (/OOMKilled|oom|out.of.memory/i.test(line)) {
        summary.notableEvents.push({ type: 'oom', message: line.trim().substring(0, 150), timestamp: ts ? ts.toISOString() : null });
      }
      if (/CrashLoopBackOff|crash.*restart|BackOff/i.test(line)) {
        summary.notableEvents.push({ type: 'crash', message: line.trim().substring(0, 150), timestamp: ts ? ts.toISOString() : null });
      }
    }

    // Sort endpoints by count
    summary.topEndpoints = Object.entries(summary.endpoints)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([endpoint, count]) => ({ endpoint, count }));

    // Limit notable events
    if (summary.notableEvents.length > 20) {
      summary.notableEvents = summary.notableEvents.slice(0, 20);
    }

    results.push(summary);

    if (options.onProgress) {
      options.onProgress(podName, summary.totalLines);
    }
  }

  // Sort by error count desc
  results.sort((a, b) => b.errorLines - a.errorLines);

  return {
    pods: results,
    stats: {
      podCount: results.length,
      totalLines: results.reduce((s, p) => s + p.totalLines, 0),
      totalErrors: results.reduce((s, p) => s + p.errorLines, 0),
      totalRequests: results.reduce((s, p) => s + p.apiRequests, 0)
    }
  };
}

module.exports = { parsePodLogs };
