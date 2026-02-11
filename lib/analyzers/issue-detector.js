'use strict';

function detectIssues(errorAnalysis, metricsAnalysis, dbAnalysis) {
  const issues = [];
  let idx = 1;

  const catMap = {};
  for (const c of errorAnalysis.categories) catMap[c.name] = c;

  if (catMap.redis_connection && catMap.redis_connection.count > 50) {
    const c = catMap.redis_connection;
    issues.push({
      id: `ISSUE-${String(idx++).padStart(3,'0')}`,
      severity: 'critical',
      title: `Redis Connection Failures (${c.count.toLocaleString()} errors)`,
      description: `Pods are failing to connect to Redis at 127.0.0.1:6379. This means each pod expects a local Redis sidecar or localhost Redis, but none is running.`,
      evidence: [
        `${c.count.toLocaleString()} ECONNREFUSED errors on port 6379`,
        `Affected deployments: ${c.affectedDeployments.join(', ')}`,
        `Affected pods: ${c.affectedPods.length}`,
        c.affectedBots.length > 0 ? `Affected bots: ${c.affectedBots.length}` : null
      ].filter(Boolean),
      impact: 'Cache layer is completely down. Every request hits DB directly, increasing latency. Bot flow drafts cannot be cached.',
      affectedServices: c.affectedDeployments,
      rootCause: 'Redis sidecar not running or REDIS_HOST misconfigured',
      action: 'Check if Redis sidecar container is defined and running. If using remote Redis, update REDIS_HOST env var.'
    });
  }

  if (catMap.rasa_timeout && catMap.rasa_timeout.count > 10) {
    const c = catMap.rasa_timeout;
    issues.push({
      id: `ISSUE-${String(idx++).padStart(3,'0')}`,
      severity: 'critical',
      title: `Rasa Request Timeouts (${c.count} timeouts, ${c.affectedBots.length} bots)`,
      description: `Rasa server pods are timing out at 400s while processing bot messages. Users of affected bots get no response.`,
      evidence: [
        `${c.count} timeout errors from rasa-server pods`,
        `Affected bots: ${c.affectedBots.join(', ')}`,
        `Affected pods: ${c.affectedPods.join(', ')}`
      ],
      impact: 'Complete conversation failure for affected bots. End users send messages but receive no response.',
      affectedServices: c.affectedDeployments,
      rootCause: 'Model loading/retraining blocking message pipeline, or model too large for available resources',
      action: 'Check model sizes for affected bots. Investigate if retraining was scheduled during peak hours. Consider dedicated Rasa instances.'
    });
  }

  if (catMap.oom_killed && catMap.oom_killed.count > 0) {
    const c = catMap.oom_killed;
    issues.push({
      id: `ISSUE-${String(idx++).padStart(3,'0')}`,
      severity: 'critical',
      title: `OOM Killed Events (${c.count} occurrences)`,
      description: `Pods are being killed due to out-of-memory conditions.`,
      evidence: [`${c.count} OOM events`, `Affected: ${c.affectedDeployments.join(', ')}`],
      impact: 'Pod restarts cause request failures and potential data loss.',
      affectedServices: c.affectedDeployments,
      rootCause: 'Memory limits too low or memory leak in application',
      action: 'Increase memory limits or investigate memory usage patterns.'
    });
  }

  if (catMap.crash_restart && catMap.crash_restart.count > 0) {
    const c = catMap.crash_restart;
    issues.push({
      id: `ISSUE-${String(idx++).padStart(3,'0')}`,
      severity: 'critical',
      title: `Pod Crash/Restart Events (${c.count})`,
      description: `Pods are crash-looping or being repeatedly killed and restarted.`,
      evidence: [`${c.count} crash events`, `Affected: ${c.affectedDeployments.join(', ')}`],
      impact: 'Service intermittently unavailable during restarts.',
      affectedServices: c.affectedDeployments,
      rootCause: 'Application crash, resource limits, or startup failure',
      action: 'Check pod describe output and container logs for crash reason.'
    });
  }

  if (metricsAnalysis.scalingEvents && metricsAnalysis.scalingEvents.length > 0) {
    for (const evt of metricsAnalysis.scalingEvents) {
      if (evt.to > evt.from) {
        const hot = metricsAnalysis.hotPods.find(p => p.deployment === evt.deployment);
        issues.push({
          id: `ISSUE-${String(idx++).padStart(3,'0')}`,
          severity: 'high',
          title: `Auto-Scaling: ${evt.deployment} (${evt.from} -> ${evt.to} replicas)`,
          description: `The deployment scaled up under load. ${hot ? `Peak CPU: ${hot.maxCpu}m.` : ''}`,
          evidence: [
            `Scaled from ${evt.from} to ${evt.to} replicas`,
            hot ? `Max CPU: ${hot.maxCpu}m, Avg CPU: ${hot.avgCpu}m` : null
          ].filter(Boolean),
          impact: 'Auto-scaling indicates load pressure. Check if root cause is organic traffic or a bug amplifying requests.',
          affectedServices: [evt.deployment],
          rootCause: 'CPU/memory pressure from traffic or upstream issues',
          action: 'Investigate if scaling is expected. If Redis is down, fixing it may reduce CPU and prevent excessive scaling.'
        });
      }
    }
  }

  if (catMap.mysql_warning && catMap.mysql_warning.count > 20) {
    const c = catMap.mysql_warning;
    issues.push({
      id: `ISSUE-${String(idx++).padStart(3,'0')}`,
      severity: 'medium',
      title: `MySQL2 Configuration Warnings (${c.count})`,
      description: `Invalid options (useUTC, timezone) passed to MySQL2 connections. Currently warnings, will become errors in future versions.`,
      evidence: [`${c.count} warnings`, `Affected: ${c.affectedDeployments.join(', ')}`],
      impact: 'No immediate impact. Future MySQL2 upgrade will break connections.',
      affectedServices: c.affectedDeployments,
      rootCause: 'Outdated DB connection configuration',
      action: 'Remove useUTC option. Use +05:30 instead of Asia/Kolkata for timezone.'
    });
  }

  if (catMap.nlu_fallback && catMap.nlu_fallback.count > 50) {
    const c = catMap.nlu_fallback;
    issues.push({
      id: `ISSUE-${String(idx++).padStart(3,'0')}`,
      severity: 'medium',
      title: `NLU Fallback Rate High (${c.count.toLocaleString()} unrecognized messages)`,
      description: `A significant number of user messages are falling back to NLU fallback, meaning the bot cannot understand them.`,
      evidence: [`${c.count.toLocaleString()} fallback events`],
      impact: 'Users not getting meaningful bot responses for common phrases.',
      affectedServices: ['rasa-server'],
      rootCause: 'Missing training data for common conversational phrases',
      action: 'Add training examples for small-talk intents (ok, thanks, bye, etc.).'
    });
  }

  if (catMap.http_5xx && catMap.http_5xx.count > 10) {
    const c = catMap.http_5xx;
    issues.push({
      id: `ISSUE-${String(idx++).padStart(3,'0')}`,
      severity: 'high',
      title: `HTTP 5xx Errors (${c.count})`,
      description: `Server-side errors detected in API responses.`,
      evidence: [`${c.count} 5xx responses`, `Affected: ${c.affectedDeployments.join(', ')}`],
      impact: 'API clients receiving server errors.',
      affectedServices: c.affectedDeployments,
      rootCause: 'Application bugs or upstream service failures',
      action: 'Check application logs for root cause of 5xx responses.'
    });
  }

  if (catMap.connection_reset && catMap.connection_reset.count > 20) {
    const c = catMap.connection_reset;
    issues.push({
      id: `ISSUE-${String(idx++).padStart(3,'0')}`,
      severity: 'medium',
      title: `Connection Resets (${c.count})`,
      description: `TCP connections being reset or hung up unexpectedly.`,
      evidence: [`${c.count} reset events`, `Affected: ${c.affectedDeployments.join(', ')}`],
      impact: 'Intermittent request failures.',
      affectedServices: c.affectedDeployments,
      rootCause: 'Network issues, load balancer timeouts, or upstream service restarts',
      action: 'Check network policies, LB idle timeout settings, and upstream service health.'
    });
  }

  if (catMap.slow_query && catMap.slow_query.count > 5) {
    const c = catMap.slow_query;
    issues.push({
      id: `ISSUE-${String(idx++).padStart(3,'0')}`,
      severity: 'medium',
      title: `Slow Queries Detected (${c.count})`,
      description: `Database queries exceeding normal execution time.`,
      evidence: [`${c.count} slow query events`],
      impact: 'Degraded response times for affected endpoints.',
      affectedServices: c.affectedDeployments,
      rootCause: 'Missing indexes, large table scans, or lock contention',
      action: 'Review slow query logs, add indexes, optimize queries.'
    });
  }

  if (catMap.kafka_error && catMap.kafka_error.count > 5) {
    const c = catMap.kafka_error;
    issues.push({
      id: `ISSUE-${String(idx++).padStart(3,'0')}`,
      severity: 'high',
      title: `Kafka Errors (${c.count})`,
      description: `Kafka consumer/producer errors detected.`,
      evidence: [`${c.count} Kafka errors`, `Affected: ${c.affectedDeployments.join(', ')}`],
      impact: 'Message processing delays or data loss.',
      affectedServices: c.affectedDeployments,
      rootCause: 'Kafka broker issues or consumer group rebalancing',
      action: 'Check Kafka broker health, consumer lag, and partition assignments.'
    });
  }

  if (catMap.lock_failure && catMap.lock_failure.count > 0) {
    const c = catMap.lock_failure;
    issues.push({
      id: `ISSUE-${String(idx++).padStart(3,'0')}`,
      severity: 'low',
      title: `Lock Release Failures (${c.count})`,
      description: `Distributed lock release failures detected.`,
      evidence: [`${c.count} lock failures`],
      impact: 'Potential race conditions or stale locks.',
      affectedServices: c.affectedDeployments,
      rootCause: 'Lock TTL expired before operation completed',
      action: 'Review lock TTL configuration and operation durations.'
    });
  }

  if (catMap.tensorflow_warning && catMap.tensorflow_warning.count > 5) {
    const c = catMap.tensorflow_warning;
    issues.push({
      id: `ISSUE-${String(idx++).padStart(3,'0')}`,
      severity: 'low',
      title: `TensorFlow Function Retracing (${c.count})`,
      description: `TensorFlow is retracing tf.function calls, which is expensive and indicates potential performance issues.`,
      evidence: [`${c.count} retracing warnings`],
      impact: 'Slower model inference, increased CPU usage.',
      affectedServices: ['rasa-server'],
      rootCause: 'Models with varying input shapes triggering recompilation',
      action: 'Investigate model architecture, consider setting reduce_retracing=True.'
    });
  }

  if (metricsAnalysis.nodeAlerts && metricsAnalysis.nodeAlerts.length > 0) {
    const highCpuNodes = [...new Set(metricsAnalysis.nodeAlerts.filter(a => a.type === 'high_cpu').map(a => a.node))];
    const highMemNodes = [...new Set(metricsAnalysis.nodeAlerts.filter(a => a.type === 'high_memory').map(a => a.node))];
    if (highCpuNodes.length > 0) {
      issues.push({
        id: `ISSUE-${String(idx++).padStart(3,'0')}`,
        severity: 'high',
        title: `Nodes with High CPU (>80%): ${highCpuNodes.join(', ')}`,
        description: `One or more cluster nodes are running at >80% CPU utilization.`,
        evidence: highCpuNodes.map(n => `Node ${n} above 80% CPU`),
        impact: 'Pod scheduling may be affected. Risk of node-level resource exhaustion.',
        affectedServices: [],
        rootCause: 'High workload or insufficient cluster capacity',
        action: 'Scale the cluster or redistribute workloads.'
      });
    }
    if (highMemNodes.length > 0) {
      issues.push({
        id: `ISSUE-${String(idx++).padStart(3,'0')}`,
        severity: 'high',
        title: `Nodes with High Memory (>80%): ${highMemNodes.join(', ')}`,
        description: `Cluster nodes running at >80% memory.`,
        evidence: highMemNodes.map(n => `Node ${n} above 80% memory`),
        impact: 'Risk of OOM kills and pod evictions.',
        affectedServices: [],
        rootCause: 'Memory-heavy workloads or insufficient node sizing',
        action: 'Add nodes or increase node instance sizes.'
      });
    }
  }

  if (dbAnalysis.alerts) {
    for (const alert of dbAnalysis.alerts) {
      issues.push({
        id: `ISSUE-${String(idx++).padStart(3,'0')}`,
        severity: alert.severity,
        title: alert.message,
        description: alert.message,
        evidence: [],
        impact: 'Database performance or availability may be affected.',
        affectedServices: [],
        rootCause: 'Database load or misconfiguration',
        action: 'Review DB connection pool settings and query performance.'
      });
    }
  }

  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  issues.sort((a, b) => (severityOrder[a.severity] ?? 4) - (severityOrder[b.severity] ?? 4));

  return { issues };
}

module.exports = { detectIssues };
