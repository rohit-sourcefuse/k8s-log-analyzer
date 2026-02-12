'use strict';

const fs = require('fs');
const readline = require('readline');
const path = require('path');
const { stripAnsi, extractDeploymentName } = require('./parser-utils');
const { parseIsoTimestamp, isInTimeRange } = require('../utils/time-utils');

const ERROR_PATTERNS = [
  { name: 'redis_connection',   regex: /ECONNREFUSED.*6379|Redis.*connect.*refused|connect ECONNREFUSED/i, severity: 5 },
  { name: 'redis_error',        regex: /Redis.*error|redis.*fail|RedisError/i, severity: 4 },
  { name: 'rasa_timeout',       regex: /Request timeout after \d+s for bot/i, severity: 5 },
  { name: 'mysql_warning',      regex: /Ignoring invalid.*MySQL2|invalid configuration option.*Connection/i, severity: 3 },
  { name: 'mysql_error',        regex: /ER_|ECONNREFUSED.*3306|mysql.*error|SequelizeConnectionError/i, severity: 5 },
  { name: 'nlu_fallback',       regex: /nlu_fallback|intent.*fallback/i, severity: 3 },
  { name: 'tensorflow_warning', regex: /WARNING:tensorflow|tf\.function retracing/i, severity: 2 },
  { name: 'oom_killed',         regex: /OOMKilled|Out of memory|SIGKILL|Cannot allocate memory/i, severity: 5 },
  { name: 'http_5xx',           regex: /"statusCode":\s*5\d{2}|HTTP\s+5\d{2}|status[: ]+5\d{2}/i, severity: 4 },
  { name: 'http_4xx',           regex: /"statusCode":\s*4\d{2}/i, severity: 2 },
  { name: 'connection_reset',   regex: /ECONNRESET|EPIPE|socket hang up|connection reset/i, severity: 4 },
  { name: 'dns_error',          regex: /ENOTFOUND|EAI_AGAIN|DNS.*fail/i, severity: 4 },
  { name: 'timeout_generic',    regex: /ETIMEDOUT|ESOCKETTIMEDOUT|timeout.*exceeded/i, severity: 4 },
  { name: 'crash_restart',      regex: /CrashLoopBackOff|Back-off restarting|container.*killed/i, severity: 5 },
  { name: 'memory_pressure',    regex: /memory.*pressure|heap.*out|FATAL ERROR.*heap/i, severity: 5 },
  { name: 'disk_pressure',      regex: /disk.*pressure|no space left|ENOSPC/i, severity: 5 },
  { name: 'auth_error',         regex: /unauthorized|403.*forbidden|authentication.*fail|JWT.*expired/i, severity: 3 },
  { name: 'rate_limit',         regex: /rate.?limit|too many requests|429/i, severity: 3 },
  { name: 'slow_query',         regex: /slow.*query|query.*took.*\d+ms|execution time.*exceeded/i, severity: 3 },
  { name: 'lock_failure',       regex: /Failed to release lock|deadlock|lock.*timeout/i, severity: 4 },
  { name: 'kafka_error',        regex: /kafka.*error|KafkaJSError|consumer.*disconnect/i, severity: 4 },
  { name: 'unhandled_exception',regex: /unhandled.*rejection|uncaught.*exception/i, severity: 5 },
  { name: 'stack_trace',        regex: /^\s+at\s+\S+/m, severity: 3 },
];

const POD_LINE_RE = /^\[([^\]]+)\]\s+(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+(.*)/;
const BOT_ID_RE = /(?:bot|Welcome-)[\s-]?([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i;
const RASA_BOT_RE = /for bot ([a-f0-9-]+)/i;

function classifyLine(message) {
  const clean = stripAnsi(message);
  const categories = [];
  for (const pattern of ERROR_PATTERNS) {
    if (pattern.regex.test(clean)) {
      categories.push(pattern.name);
    }
  }
  return categories.length > 0 ? categories : ['uncategorized'];
}

function extractBotId(message) {
  const rasaMatch = message.match(RASA_BOT_RE);
  if (rasaMatch) return rasaMatch[1];
  const botMatch = message.match(BOT_ID_RE);
  if (botMatch) return botMatch[1];
  return null;
}

function detectLevel(message) {
  const lower = message.toLowerCase();
  if (/\berror\b|\bfatal\b|\bcritical\b/i.test(lower)) return 'error';
  if (/\bwarn(?:ing)?\b/i.test(lower)) return 'warning';
  if (/\bdebug\b/i.test(lower)) return 'debug';
  return 'info';
}

async function parseErrorLog(filePath, options = {}) {
  const { startTime, endTime, onProgress } = options;
  const events = [];
  const stats = {
    totalLines: 0,
    errorCount: 0,
    warningCount: 0,
    byPod: {},
    byDeployment: {},
    byCategory: {},
    firstTimestamp: null,
    lastTimestamp: null
  };

  const fileStream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let stackBuffer = null;

  for await (const line of rl) {
    stats.totalLines++;

    if (onProgress && stats.totalLines % 10000 === 0) {
      onProgress(stats.totalLines, path.basename(filePath));
    }

    const podMatch = line.match(POD_LINE_RE);
    if (!podMatch) {
      if (stackBuffer && /^\s+at\s/.test(line)) {
        stackBuffer.stackTrace = (stackBuffer.stackTrace || '') + '\n' + line.trim();
      }
      continue;
    }

    if (stackBuffer) {
      events.push(stackBuffer);
      stackBuffer = null;
    }

    const [, podName, tsStr, rawMessage] = podMatch;
    const timestamp = parseIsoTimestamp(tsStr);

    if (startTime || endTime) {
      if (!isInTimeRange(timestamp, startTime, endTime)) continue;
    }

    if (!stats.firstTimestamp || timestamp < stats.firstTimestamp) stats.firstTimestamp = timestamp;
    if (!stats.lastTimestamp || timestamp > stats.lastTimestamp) stats.lastTimestamp = timestamp;

    const message = stripAnsi(rawMessage);
    const level = detectLevel(message);
    const categories = classifyLine(message);
    const botId = extractBotId(message);
    const deployment = extractDeploymentName(podName);

    if (level === 'error') stats.errorCount++;
    if (level === 'warning') stats.warningCount++;

    stats.byPod[podName] = (stats.byPod[podName] || 0) + 1;
    stats.byDeployment[deployment] = (stats.byDeployment[deployment] || 0) + 1;
    for (const cat of categories) {
      stats.byCategory[cat] = (stats.byCategory[cat] || 0) + 1;
    }

    const event = {
      timestamp,
      pod: podName,
      deployment,
      level,
      message: message.substring(0, 500),
      categories,
      botId,
      stackTrace: null
    };

    if (/^\s+at\s/.test(message)) {
      stackBuffer = event;
    } else {
      events.push(event);
    }
  }

  if (stackBuffer) events.push(stackBuffer);

  return { events, stats };
}

const MAX_EVENTS = 200000;

async function parseAllErrorLogs(filePaths, options = {}) {
  // Phase 1: Parse all files, collect events and stats per file
  const fileResults = [];
  let totalEventCount = 0;
  const combinedStats = {
    totalLines: 0,
    errorCount: 0,
    warningCount: 0,
    byPod: {},
    byDeployment: {},
    byCategory: {},
    firstTimestamp: null,
    lastTimestamp: null,
    fileCount: filePaths.length,
    files: []
  };

  for (const filePath of filePaths) {
    const { events, stats } = await parseErrorLog(filePath, options);
    fileResults.push({ events, stats });
    totalEventCount += events.length;

    combinedStats.totalLines += stats.totalLines;
    combinedStats.errorCount += stats.errorCount;
    combinedStats.warningCount += stats.warningCount;
    combinedStats.files.push({ path: filePath, lines: stats.totalLines });

    for (const [k, v] of Object.entries(stats.byPod)) {
      combinedStats.byPod[k] = (combinedStats.byPod[k] || 0) + v;
    }
    for (const [k, v] of Object.entries(stats.byDeployment)) {
      combinedStats.byDeployment[k] = (combinedStats.byDeployment[k] || 0) + v;
    }
    for (const [k, v] of Object.entries(stats.byCategory)) {
      combinedStats.byCategory[k] = (combinedStats.byCategory[k] || 0) + v;
    }

    if (!combinedStats.firstTimestamp || (stats.firstTimestamp && stats.firstTimestamp < combinedStats.firstTimestamp)) {
      combinedStats.firstTimestamp = stats.firstTimestamp;
    }
    if (!combinedStats.lastTimestamp || (stats.lastTimestamp && stats.lastTimestamp > combinedStats.lastTimestamp)) {
      combinedStats.lastTimestamp = stats.lastTimestamp;
    }
  }

  // Phase 2: Distribute MAX_EVENTS budget across files proportionally,
  // guaranteeing each file gets at least MIN_PER_FILE events so that
  // the timeline covers the full time range (not just the largest files).
  let allEvents = [];
  let eventsDropped = 0;

  if (totalEventCount <= MAX_EVENTS) {
    // All events fit — no sampling needed
    for (const fr of fileResults) {
      for (const evt of fr.events) allEvents.push(evt);
    }
  } else {
    const MIN_PER_FILE = Math.min(5000, Math.floor(MAX_EVENTS / filePaths.length));
    // First pass: guarantee minimum per file
    let budgetUsed = 0;
    const allocations = fileResults.map(fr => {
      const alloc = Math.min(fr.events.length, MIN_PER_FILE);
      budgetUsed += alloc;
      return alloc;
    });
    // Second pass: distribute remaining budget proportionally to file sizes
    let remaining = MAX_EVENTS - budgetUsed;
    if (remaining > 0) {
      const leftover = fileResults.map((fr, i) => fr.events.length - allocations[i]);
      const totalLeftover = leftover.reduce((s, n) => s + n, 0);
      if (totalLeftover > 0) {
        for (let i = 0; i < fileResults.length; i++) {
          const extra = Math.min(leftover[i], Math.floor((leftover[i] / totalLeftover) * remaining));
          allocations[i] += extra;
        }
      }
    }

    // Sample events from each file using uniform stride
    for (let fi = 0; fi < fileResults.length; fi++) {
      const events = fileResults[fi].events;
      const budget = Math.min(allocations[fi], events.length);
      if (budget >= events.length) {
        for (const evt of events) allEvents.push(evt);
      } else {
        // Uniform sampling: always include first and last, stride the middle
        const stride = events.length / budget;
        for (let j = 0; j < budget; j++) {
          allEvents.push(events[Math.min(Math.floor(j * stride), events.length - 1)]);
        }
        eventsDropped += events.length - budget;
      }
    }
  }

  if (eventsDropped > 0) {
    combinedStats.eventsDropped = eventsDropped;
  }

  allEvents.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  return { events: allEvents, stats: combinedStats };
}

module.exports = { parseErrorLog, parseAllErrorLogs, ERROR_PATTERNS, classifyLine };
