# k8s-log-analyzer

Analyze Kubernetes monitoring log archives and generate interactive HTML dashboards with charts, issue detection, and prioritized recommendations.

Zero npm dependencies. Pure Node.js.

## Quick Start

```bash
# Run directly
node analyze.js /path/to/monitor-logs_YYYYMMDD_HHMMSS/

# Or install globally
cd log-analyzer
npm link

# Then use from anywhere
k8s-log-analyzer /path/to/logs/
```

## Features

- Stream-based parsing (handles 80MB+ log files without loading into memory)
- Auto-detects 20+ error types: Redis, MySQL, OOM, 5xx, timeouts, Kafka, slow queries, etc.
- Kubernetes metrics analysis: node CPU/memory, pod resources, replica scaling, DB connection pools
- MySQL processlist analysis with long-running query detection
- Interactive Chart.js graphs (8 chart types) with dark theme
- Issue detection with severity ranking and root cause analysis
- Prioritized recommendations with effort/impact ratings
- Date/time filtering (CLI flags + in-report filters)
- Self-contained HTML output (single file, Chart.js from CDN)

## Usage

```bash
k8s-log-analyzer <log-directory> [options]

Options:
  -o, --output <path>     Output HTML file (default: <dir>/log-analysis-report.html)
  -s, --start <datetime>  Filter start time (ISO 8601)
  -e, --end <datetime>    Filter end time (ISO 8601)
  -h, --help              Show help

Examples:
  k8s-log-analyzer ./monitor-logs/
  k8s-log-analyzer ./logs/ -o ~/Desktop/report.html
  k8s-log-analyzer ./logs/ --start 2026-02-11T14:00:00Z --end 2026-02-11T15:00:00Z
```

## Supported Log Types

| File Pattern | Description |
|---|---|
| `errors_*.log` | K8s pod error streams (Redis, timeout, OOM, 5xx, MySQL, Kafka...) |
| `metrics_*.txt` | Cluster metrics snapshots (CPU, memory, replicas, DB pools) |
| `db_debug.log` | MySQL SHOW FULL PROCESSLIST snapshots |
| `monitoring_dashboard_*.log` | Dashboard terminal output |
| `slow_queries/*.log` | Slow query logs |
| `pod_logs/*.log` | Raw kubectl logs |

## Error Types Auto-Detected

Redis connection, Redis errors, Rasa timeouts, MySQL warnings, MySQL errors, NLU fallback, TensorFlow warnings, OOM killed, HTTP 5xx, HTTP 4xx, Connection resets, DNS errors, Generic timeouts, Crash/restart loops, Memory pressure, Disk pressure, Auth errors, Rate limits, Slow queries, Lock failures, Kafka errors, Unhandled exceptions, Stack traces.

## Expected Directory Structure

```
monitor-logs_YYYYMMDD_HHMMSS/
├── MANIFEST.txt
├── LOG_SOURCES.txt
├── logs/
│   ├── errors_YYYYMMDD_HHMMSS.log
│   ├── metrics_YYYYMMDD_HHMMSS.txt
│   ├── dashboard/
│   ├── slow_queries/
│   └── db_state/
├── db/
│   └── db_debug.log
└── pod_logs/
```

## Output

A single self-contained HTML file with:
- KPI summary cards
- Error distribution doughnut chart
- Error timeline (stacked bar, 5-min buckets)
- Log lines by pod (horizontal bar)
- Node CPU/Memory % over time (line charts)
- Hot pod CPU over time (line chart)
- Replica scaling over time (line chart)
- DB connection trends (line chart)
- Issue cards with severity badges
- Prioritized recommendations
- Date/time and severity filters

## License

MIT
