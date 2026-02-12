# Log Collection Script — Gaps & Improvement Recommendations

**Prepared for:** Log Generator Script Developer (`dashboard-metrics-and-errors.sh`)
**Prepared by:** K8s Log Analyzer Team
**Date:** 2026-02-12
**Context:** We built an automated log analysis tool that reads the archives produced by your collection script and generates interactive HTML dashboards. During development, we identified several data gaps and format issues that limit the depth and accuracy of analysis. Fixing these upstream will significantly improve what we can deliver to developers investigating production incidents.

---

## How This Document Is Organized

- **CRITICAL** — These gaps block meaningful analysis of key areas. High-priority fixes.
- **HIGH** — These significantly reduce analysis quality or miss important data.
- **MEDIUM** — Would improve analysis depth and developer experience.
- **LOW** — Nice-to-have improvements.

---

## CRITICAL Issues (Block Meaningful Analysis)

### 1. DB Connection Pool Summary Query Is Failing

**Current behavior:** Every metrics snapshot shows:
```
--- DB CONNECTION POOL -- Summary ---
DB query failed
```

**Impact:** We cannot analyze database connection saturation — arguably the most critical capacity metric for this application. We need Max Connections, Current, Available, and Usage % to determine if the pool is a bottleneck.

**Evidence it CAN work:** The older dashboard log from Feb 4 (`monitoring_dashboard_20260204_065723.log`) successfully captured:
```
Max: 8000 | Current: 42 | Available: 7958 | Usage: 0.53%
```

**Ask:** Investigate why the pool summary SQL query is failing in the recording mode. Likely a permissions issue or query syntax change for the RDS version. Fix the query so it returns the pool stats in every snapshot.

---

### 2. Pod Config (Environment Variable) Extraction Returns Empty

**Current behavior:** Every POD CONFIG section shows all dashes:
```
--- POD CONFIG -- DB pool size & key env ---
bot-interaction-service-deployment    -    -    -    -    -
communicationservice-deployment       -    -    -    -    -
rasa-server-deployment                -    -    -    -    -
```

**Impact:** Without `DB_POOL_MAX`, `DB_POOL_MIN`, `DB_MAX_CONN`, `ACQUIRE_MS`, `IDLE_MS` we cannot determine if pool sizes are adequate for the observed traffic. We cannot advise "increase pool size from X to Y" — we can only say "check your pool settings."

**Ask:** Fix the environment variable extraction command (likely `kubectl exec` or `kubectl get pod -o jsonpath` for env vars). Ensure it has the right service account permissions to read pod env vars.

---

### 3. Pod Log Tail Is Too Short (2,000 Lines)

**Current behavior:** `kubectl logs --tail=2000` captures only the last 2,000 lines per pod.

**Impact:** For high-traffic pods like `bot-interaction-service` (producing hundreds of lines per minute), 2,000 lines covers only **3-10 minutes** of activity. We miss:
- The beginning of error cascades
- The full timeline of an incident
- Accurate error rates over the recording duration
- Historical patterns before the spike

**Ask:** Increase the default tail to **at least 10,000 lines**. Better yet, add a `--since` flag that captures logs for a configurable time duration (e.g., `kubectl logs --since=2h`) rather than a line count. This gives consistent time coverage regardless of traffic volume.

---

### 4. Too Few Metrics Snapshots

**Current behavior:** Only 10 metrics snapshots across a ~23-hour window (Feb 11 14:13 to Feb 12 13:30).

**Impact:** 10 data points over 23 hours provides extremely poor temporal resolution for charts and trend analysis. We miss:
- CPU/memory spikes between snapshots
- The exact timing of scaling events
- Transient issues that resolve within minutes
- Correlation between error spikes and resource usage

**Ask:** If the script runs in `--record` mode with continuous refresh, persist **at least the last 100-200 snapshots** (one per minute would give ~3 hours of data). Currently it appears only 10 are retained — either the script only captures 10, or it overwrites old files. Consider a rolling buffer approach: keep the last 180 files (3 hours at 1/min).

---

## HIGH Impact Issues

### 5. Rasa/Uvicorn Access Logs Lack Timestamps

**Current behavior:** Rasa server access log lines look like:
```
INFO:     10.55.4.146:51708 - "POST /api/v1/process HTTP/1.1" 200 OK
```

**Impact:** These lines have **no timestamp and no response duration**. The Rasa pod is the single most important service for chatbot functionality, yet:
- We cannot accurately place API requests in time (we use carry-forward from nearest timestamped line — ~5 min accuracy)
- We cannot identify slow requests or latency degradation
- We cannot correlate request timing with error spikes

**Ask:** This is a Rasa/Uvicorn configuration issue, not a collection script issue. But the collection script developer can flag it:
- Configure Uvicorn access log format to include timestamp and response time:
  ```
  uvicorn --access-log --log-config logging.yaml
  ```
- Or add `--log-config` with a custom format: `%(asctime)s %(client_addr)s - "%(request_line)s" %(status_code)s %(process_time).3f`

---

### 6. `db_state/` Flight Recorder Data Is Never Consumed

**Current behavior:** The file `logs/db_state/db_debug_20260211.log` uses a pipe-delimited format:
```
2026-02-11 15:45:30|110|108|2|8582690
2026-02-11 15:45:32|101|99|2|8582692
```

**Impact:** This looks like a high-resolution DB connection flight recorder (2-second intervals!), which would be incredibly valuable for analysis. But:
- It uses a completely different format from `db/db_debug.log` (pipe-delimited vs. MySQL PROCESSLIST format)
- The file is never discovered by our analyzer because we look for `db_debug.log` by exact name, not in `logs/db_state/`

**Ask:** Either:
- **Option A:** Add a header row explaining the columns: `timestamp|total_connections|idle|active|uptime_seconds`
- **Option B:** Standardize the format to match `db_debug.log` (use the same MySQL PROCESSLIST dump)
- **Option C:** Document this file in `LOG_SOURCES.txt` with its exact format so we can write a parser for it

We will add support for whichever format you choose.

---

### 7. Include `kubectl describe pod` Output

**Current behavior:** Not captured at all.

**Impact:** We cannot determine:
- Pod restart counts and restart reasons (OOMKilled, CrashLoopBackOff)
- Container readiness/liveness probe failures
- Recent events (image pull errors, scheduling issues, volume mount failures)
- Actual resource limits vs. what's in the deployment spec

**Ask:** Add a new file per pod or a combined file with `kubectl describe pod` output for all pods in the namespace. Even a summarized version would help:
```bash
kubectl get pods -o custom-columns='NAME:.metadata.name,RESTARTS:.status.containerStatuses[0].restartCount,REASON:.status.containerStatuses[0].lastState.terminated.reason,STARTED:.status.containerStatuses[0].state.running.startedAt' -n ngcommon
```

---

### 8. Include HPA (Horizontal Pod Autoscaler) Status

**Current behavior:** Not captured.

**Impact:** We detect scaling events by comparing replica counts between snapshots, but we cannot determine:
- Was the scaling automatic (HPA) or manual?
- What's the HPA target CPU/memory percentage?
- What are min/max replica limits?
- Is the HPA active or disabled?

**Ask:** Add to each metrics snapshot:
```bash
kubectl get hpa -n ngcommon -o wide
```
This gives: name, reference, targets, minpods, maxpods, replicas, age.

---

### 9. Error Logs Contain Non-Error Lines

**Current behavior:** The error log files contain many non-error lines — JSON fragments, SQL query metadata, informational service logs. For example, `communicationservice` entries include lines like:
```json
{"service":"ng-communication-service","operation":"SELECT","table":"chat_members","duration":0.001}
```

**Impact:**
- Inflated error counts (our parser tries to filter, but edge cases slip through)
- Larger file sizes than necessary (the error log files are 50-80MB)
- Lines that break mid-stream at pod boundaries cause parse failures

**Ask:** Either:
- **Option A (preferred):** Tighten the error filter — only capture lines that match `error|warn|Error|WARN|fatal|panic|OOMKill|CrashLoop` patterns, not entire pod stream segments
- **Option B:** Capture ALL log levels (rename from `errors_*` to `logs_*`) and let the analyzer handle classification. This is actually better for analysis because we get context around errors.
- **Option C:** Add a pod-name separator line between different pod streams: `--- [pod-name] ---` so our parser can track pod boundaries cleanly

---

## MEDIUM Impact Improvements

### 10. Enhance MANIFEST.txt with Collection Metadata

**Current behavior:** The entire manifest is one line:
```
Log archive from ec2-user@13.202.214.98 (2026-02-12T19:27:24+05:30)
```

**Ask:** Include structured metadata:
```
Log archive from ec2-user@13.202.214.98 (2026-02-12T19:27:24+05:30)
Script: dashboard-metrics-and-errors.sh v2.3
Mode: --record
Recording started: 2026-02-11T14:13:00Z
Recording ended: 2026-02-12T13:35:00Z
Duration: 23h 22m
Cluster: ngage-production (ap-south-1)
Namespace: ngcommon
Kubernetes version: 1.28.5
Node count: 3
Pod count: 47
POD_LOG_TAIL: 2000
Metrics snapshots: 10
Error log files: 8
```

This helps the analyzer auto-detect settings and display accurate metadata on the dashboard.

---

### 11. Enable MySQL Slow Query Logging

**Current behavior:** `logs/slow_queries/slow_queries_20260211.log` exists but is **empty (0 bytes)**.

**Impact:** We have zero visibility into slow database queries. The `db_debug.log` PROCESSLIST captures point-in-time snapshots, but we miss:
- Queries that took >1 second
- Full query text with execution time
- Which tables are causing contention

**Ask:** Verify that MySQL slow query log is enabled on the RDS instance:
```sql
SET GLOBAL slow_query_log = 'ON';
SET GLOBAL long_query_time = 1;  -- log queries taking >1 second
```
Then capture it via `SHOW FULL PROCESSLIST` filtering or via the RDS slow query log download.

---

### 12. Capture Multi-Namespace Metrics

**Current behavior:** Only `ngcommon` namespace pod CPU/memory is captured. Pods from `ngsms`, `ngwhatsapp`, `ngrcs`, `3rdparty` namespaces appear in DB connection data but have no resource metrics.

**Ask:** Add a flag to capture metrics from all relevant namespaces, or at minimum add `kubectl top pods -n <namespace>` for each namespace that has pods connecting to the shared database.

---

### 13. Add Timestamps to All Log Lines (Rasa Config)

**Current behavior:** Many Rasa log lines use Python's default `INFO:` format without timestamps:
```
INFO:     10.55.4.146:51708 - "POST /api/v1/process HTTP/1.1" 200 OK
```

**Ask (for the platform/DevOps team, not just the script):** Configure Rasa's logging to include timestamps:
```python
# In rasa logging config:
LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s - %(message)s"
```
Or in Uvicorn config:
```
--log-config=logging_config.yaml
```
This ensures every line is temporally locatable.

---

### 14. Strip ANSI Escape Codes Before Writing Files

**Current behavior:** All log files contain raw ANSI codes (`[31merror[39m`, `[32minfo[39m`, `[36m[app_engine][0m`).

**Impact:**
- Increases file size by ~5-10%
- Makes manual log reading harder
- Requires every consumer to implement ANSI stripping

**Ask:** Pipe output through `sed 's/\x1b\[[0-9;]*m//g'` before writing to files, or use `kubectl logs --no-color` for pod log capture.

---

### 15. Add Pod Stream Separators in Error Logs

**Current behavior:** Error log files concatenate multiple pod log streams without separators. At pod boundaries, lines get truncated:
```
...end of pod A's output[bot-interaction-service-deployment-67d6c64787-hkbv6] 2026-02-12T...
```
The last line of pod A merges with the first line of pod B.

**Ask:** Insert a separator line when switching between pod streams:
```
### --- POD: bot-interaction-service-deployment-67d6c64787-hkbv6 ---
```
This allows the analyzer to track pod boundaries cleanly and prevents line merging.

---

## LOW Impact (Nice to Have)

### 16. Include `SHOW ENGINE INNODB STATUS`
For deadlock detection, lock wait analysis, and buffer pool utilization.

### 17. Include Disk Usage
`df -h` on nodes, or `kubectl top node --show-capacity` for capacity planning.

### 18. Capture Kubernetes Events
`kubectl get events --sort-by='.lastTimestamp' -n ngcommon` provides pod scheduling, image pull, mount, and probe failure events.

### 19. Remove Duplicate Files in `dashboard-recorded/`
The `logs/dashboard-recorded/` directory contains exact copies of files already in `logs/`. This doubles the archive size unnecessarily. Our analyzer deduplicates by filename, but the storage overhead is wasteful.

### 20. Add `db_debug.log` Timestamp for First Snapshot
The file starts with PROCESSLIST data rows before any timestamp header. Add a timestamp line before the first batch of rows so no data is lost.

---

## Summary Table

| # | Issue | Severity | Category | Current Impact |
|---|-------|----------|----------|----------------|
| 1 | DB Pool Summary query failing | CRITICAL | Metrics | Zero visibility into connection pool saturation |
| 2 | Pod Config env vars empty | CRITICAL | Metrics | Cannot assess pool configuration adequacy |
| 3 | Pod log tail too short (2K) | CRITICAL | Pod Logs | Only 3-10 min of history for busy pods |
| 4 | Too few metrics snapshots (10) | CRITICAL | Metrics | Poor temporal resolution, miss all spikes |
| 5 | Rasa access logs lack timestamps | HIGH | Pod Logs | Cannot time-locate ~1,800 API requests |
| 6 | db_state flight recorder ignored | HIGH | DB | High-res DB data exists but is unusable |
| 7 | No `kubectl describe pod` | HIGH | Infrastructure | Missing restart counts, probe failures, events |
| 8 | No HPA status | HIGH | Scaling | Cannot distinguish auto vs manual scaling |
| 9 | Error logs contain non-errors | HIGH | Error Logs | Inflated counts, truncated lines at boundaries |
| 10 | Minimal MANIFEST metadata | MEDIUM | Metadata | Missing collection duration, cluster info, settings |
| 11 | Slow query log empty | MEDIUM | DB | Zero slow query visibility |
| 12 | Single-namespace metrics | MEDIUM | Metrics | No CPU/memory for cross-namespace pods |
| 13 | Missing timestamps in Rasa | MEDIUM | App Config | Temporal accuracy reduced to ~5 min buckets |
| 14 | ANSI codes in log files | MEDIUM | Format | Extra processing, larger files |
| 15 | No pod stream separators | MEDIUM | Error Logs | Line merging at pod boundaries |
| 16-20 | InnoDB status, disk, events, dedup, first-snapshot TS | LOW | Various | Minor analysis improvements |

---

## What We Handle on Our Side

To be clear, we're NOT asking you to change the analysis — that's our job. These are specifically things that only the **collection script** can fix because they involve:
- What data is captured at collection time
- How the data is formatted
- What commands are run against the cluster
- Configuration of the Kubernetes/RDS environment

We've already built workarounds for several limitations (carry-forward timestamps, ANSI stripping, proportional sampling for large files, deduplication of dashboard-recorded copies), but the issues above cannot be worked around — we need the data to exist in the archive.

---

*Generated by k8s-log-analyzer | 2026-02-12*
