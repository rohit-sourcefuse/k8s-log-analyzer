# Log Collection Script — Gaps, Fixes & Remaining Items

**Prepared for:** Log Generator Script Developer (`dashboard-metrics-and-errors.sh`, `download-logs.sh`, `monitoring-session.sh`)
**Prepared by:** K8s Log Analyzer Team
**Date:** 2026-02-12 (Updated after script review)
**Context:** After our initial gap analysis, the script developer implemented significant improvements. This updated document reflects current status after reviewing the actual scripts at `scripts/monitoring/log-export/` and `scripts/monitoring/`.

---

## Status Summary

| Status | Count | Details |
|--------|-------|---------|
| **Fixed by script developer** | 10 | DB pool query, pod config, pod tail, metrics snapshots, db_state header, kubectl describe, HPA, manifest, ANSI strip, pod separators |
| **Fixed by k8s-log-analyzer** | 3 | Carry-forward timestamps, proportional sampling, hardlink dedup |
| **Needs app/infra team** | 3 | Rasa timestamps, slow query log, multi-namespace |
| **k8s-log-analyzer must update** | 4 | Parse new data: metrics_snapshots/, pod_describes/, db_state header, HPA |
| **Remaining script improvements** | 4 | K8s events, InnoDB status, disk usage, recording start/end times |

---

## Part 1: What the Script Developer ALREADY Fixed

The following improvements have been implemented in the collection scripts. This section documents what changed so the k8s-log-analyzer can be updated to consume the new data formats.

### 1. DB Connection Pool Summary — FIXED

**What changed:** `dashboard-metrics-and-errors.sh` lines 153-167
- Primary query now uses `CONCAT()` for consistent types across the `UNION ALL`
- Added fallback: `SHOW STATUS LIKE 'Threads_connected'` + `SHOW VARIABLES LIKE 'max_connections'` for RDS with limited processlist permissions
- Output now shows `Total`, `Idle`, `Active`, `Max_Conn`, `Usage_%` or clear error message

**k8s-log-analyzer action needed:** Our metrics-parser.js currently treats `DB query failed` as the only case. We need to parse the new successful output format (tab-separated `column-t` output) and extract Total/Idle/Active/Max/Usage.

### 2. Pod Config Env Vars — FIXED

**What changed:** `dashboard-metrics-and-errors.sh` lines 210-239
- First tries ConfigMap `.data.DB_POOL_MAX` etc. via `kubectl get configmap -o jsonpath`
- Fallback: full deployment YAML + configmap YAML `grep` for `DB_POOL_MAX`, `DB_POOL_MIN`, `DB_MAX_CONNECTIONS`, `DB_ACQUIRE_TIME`, `DB_IDLE_TIME`
- Covers both ConfigMap-based and inline env definitions

**k8s-log-analyzer action needed:** Our metrics-parser.js should now get real values instead of dashes. Existing parser handles this — no change needed if format stays the same (`printf` column format).

### 3. Pod Log Tail — FIXED

**What changed:** `download-logs.sh` lines 39-42
- `POD_LOG_TAIL` default changed from 2000 to **10000**
- Added `POD_LOG_SINCE` env variable (e.g. `POD_LOG_SINCE=2h`) for time-based capture using `kubectl logs --since`
- Both options documented in `--help` and `LOG_SOURCES.txt`

**k8s-log-analyzer action needed:** None — our parser handles any number of lines. More lines = better time coverage for the time-bucketed filtering we just implemented.

### 4. Metrics Snapshots — FIXED

**What changed:** `dashboard-metrics-and-errors.sh` lines 329-334
- In `--record` mode: persists a metrics snapshot **every 60 seconds** to `logs/metrics_snapshots/metrics_YYYYMMDD_HHMMSS.txt`
- Rolling buffer: keeps last **180 snapshots** (3 hours of data)
- Configurable via `RECORD_METRICS_SNAPSHOT_INTERVAL` (default 60s) and `RECORD_METRICS_SNAPSHOT_KEEP` (default 180)

**k8s-log-analyzer action needed:** **CRITICAL** — Our `file-scanner.js` currently only looks for `metrics_*.txt` in `logs/` directory (flat). We must also scan `logs/metrics_snapshots/` subdirectory. This will give us 180 data points instead of 10, dramatically improving chart resolution.

### 5. db_state Flight Recorder Header — FIXED

**What changed:** `db-flight-recorder.sh` lines 49-54
- Now writes header: `# timestamp|total_connections|idle|active|max_time_sec`
- Format remains pipe-delimited (1-second intervals), which is the right choice for high-resolution data

**k8s-log-analyzer action needed:** **REQUIRED** — We need a new parser for `logs/db_state/db_debug_*.log` files in pipe-delimited format. Currently we only parse `db/db_debug.log` (MySQL PROCESSLIST format). The db_state data is 1-second resolution — much richer than the PROCESSLIST snapshots.

### 6. kubectl describe pod — FIXED

**What changed:** `download-logs.sh` lines 207, 234, 316, 348
- `pod_describes/` directory created in archive
- When `--with-pod-logs` is used, runs `kubectl describe pod` for each key pod
- Output saved as `pod_describes/<podname>.txt`

**k8s-log-analyzer action needed:** **REQUIRED** — We need a new parser for `pod_describes/*.txt` files to extract:
- Restart count and last restart reason
- Container status (Running/Waiting/Terminated)
- Liveness/Readiness probe configuration and failures
- Recent events (last 10-15 events)
- Resource limits (as actually applied, not just from deployment spec)

### 7. HPA Status — FIXED

**What changed:** `dashboard-metrics-and-errors.sh` lines 142-144
- Added `kubectl get hpa -n $NAMESPACE -o wide` to every metrics snapshot
- Output includes: NAME, REFERENCE, TARGETS, MINPODS, MAXPODS, REPLICAS, AGE

**k8s-log-analyzer action needed:** **REQUIRED** — Our metrics-parser.js needs to parse the `--- HPA (Horizontal Pod Autoscaler) ---` section. This data enables:
- Showing HPA target vs actual CPU
- Distinguishing auto-scaling from manual scaling in the scaling chart
- Adding an "HPA" widget to the dashboard

### 8. Enhanced MANIFEST.txt — FIXED

**What changed:** `download-logs.sh` lines 253-264, 362-369
- Now includes: Namespace, POD_LOG_TAIL value, POD_LOG_SINCE (if set), error log file count, metrics snapshot file count, full file listing

**k8s-log-analyzer action needed:** Our `file-scanner.js` can optionally parse the new fields (Namespace, POD_LOG_TAIL) for display in the report header. Low priority since it's metadata.

### 9. ANSI Escape Code Stripping — FIXED

**What changed:** `stream-all-logs-pane.sh` line 21
- `ANSI_STRIP='sed "s/\x1b\[[0-9;]*m//g"'` applied to all pod streams before writing to error files
- Both filtered and unfiltered modes strip ANSI

**k8s-log-analyzer action needed:** None — our `stripAnsi()` in `parser-utils.js` handles this, but with ANSI pre-stripped, files will be smaller and parsing slightly faster.

### 10. Pod Stream Separators — FIXED

**What changed:** `stream-all-logs-pane.sh` lines 25, 29, 34
- Each pod stream is prefixed with `### --- POD: <podname> ---`
- This appears before the `kubectl logs` output for that pod

**k8s-log-analyzer action needed:** Our error-log-parser could optionally use these separator lines to:
- Track which pod a continuation/stacktrace line belongs to
- Prevent cross-pod line merging at boundaries
- Improve pod-level error attribution

### 11. Hardlink Deduplication — FIXED

**What changed:** `download-logs.sh` lines 288-292, 319-322
- `dashboard-recorded/` now uses `ln -f` (hardlinks) instead of `cp`
- Same file content once on disk, two directory entries

**k8s-log-analyzer action needed:** None — our `file-scanner.js` already deduplicates by basename, so hardlinks vs copies doesn't matter to us.

---

## Part 2: What the k8s-log-analyzer Must Implement

These are new data sources the script developer has added that we need to parse to unlock full value:

| Priority | New Data Source | Location in Archive | What to Extract |
|----------|----------------|--------------------|-----------------|
| **P0** | Rolling metrics snapshots | `logs/metrics_snapshots/*.txt` | Same format as `logs/metrics_*.txt` but 180 files instead of 10. Must update `file-scanner.js` to scan this subdirectory. |
| **P0** | db_state flight recorder | `logs/db_state/db_debug_*.log` | Pipe-delimited: `timestamp|total|idle|active|max_time_sec` at 1-second resolution. Write new parser. |
| **P1** | Pod describe output | `pod_describes/*.txt` | Restart counts, container status, probe config, recent events, actual resource limits. Write new parser. |
| **P1** | HPA data in metrics | Inside each `metrics_*.txt` | Parse `--- HPA ---` section for target CPU, min/max pods, current replicas. Update metrics-parser.js. |
| **P2** | Pod stream separators | Inside `errors_*.log` | Use `### --- POD: <name> ---` lines for better pod attribution in error parsing. |
| **P2** | Enhanced MANIFEST | `MANIFEST.txt` | Parse Namespace, POD_LOG_TAIL, file counts for report header. |

---

## Part 3: What STILL Needs Fixing (Not Yet Addressed)

These items from the original list have NOT been addressed and still need action:

### A. Rasa/Uvicorn Timestamps & Response Duration (App/Config Team)

**Status:** Not in scope for collection scripts — needs application configuration change.
**Owner:** Platform/DevOps team
**Impact:** HIGH — 1,800+ API requests per pod log cannot be accurately time-located. Response latency is completely invisible.

**What to do:**
1. Configure Uvicorn to include timestamps: `--log-config logging.yaml` with format including `%(asctime)s`
2. Enable response time logging: add `%(process_time).3f` to access log format
3. Example logging config:
```yaml
formatters:
  access:
    format: "%(asctime)s %(levelname)s %(client_addr)s - \"%(request_line)s\" %(status_code)s %(process_time).3fs"
```

**k8s-log-analyzer workaround:** We use carry-forward from nearest timestamped line (~5min bucket accuracy). This is acceptable but not ideal.

### B. MySQL Slow Query Log (RDS/DBA Team)

**Status:** `logs/slow_queries/slow_queries_20260211.log` is still empty (0 bytes).
**Owner:** DBA / RDS configuration team
**Impact:** MEDIUM — no slow query visibility

**What to do:**
1. Enable on RDS: Set parameter group `slow_query_log = 1`, `long_query_time = 1`
2. The `slow-query-logger.sh` script exists and looks correct, but MySQL's slow query log must be enabled server-side first

### C. Multi-Namespace Metrics (Future Enhancement)

**Status:** Only `ngcommon` namespace is captured.
**Owner:** Script developer (future)
**Impact:** MEDIUM — pods from `ngsms`, `ngwhatsapp`, `ngrcs` show in DB connections but have no CPU/memory data

**What to do:** Add `NAMESPACES` env variable (comma-separated) and iterate `kubectl top pods -n` over each namespace.

### D. Kubernetes Events (Future Enhancement)

**Status:** Not captured.
**Owner:** Script developer (future)
**Impact:** LOW — would help with scheduling issues, probe failures, image pull errors

**What to do:** Add to metrics snapshot:
```bash
echo "--- KUBERNETES EVENTS (last 30m) ---"
kubectl get events -n $NAMESPACE --sort-by='.lastTimestamp' --field-selector type!=Normal 2>/dev/null | tail -20
```

---

## Part 4: Data Flow Verification Checklist

When the script developer generates a new archive with all fixes, verify these items:

```
Archive Structure (Expected):
  MANIFEST.txt                          ← Enhanced with Namespace, POD_LOG_TAIL, counts
  LOG_SOURCES.txt                       ← Documents all sources
  SERVER_TIME.txt                       ← Server timezone info
  UPLOAD_GUIDE.txt                      ← Where to upload
  logs/
    errors_YYYYMMDD_HHMMSS.log          ← With pod separators, ANSI stripped
    metrics_YYYYMMDD_HHMMSS.txt         ← Initial snapshot (with HPA section)
    metrics_snapshots/                  ← NEW: 60-180 rolling snapshots
      metrics_YYYYMMDD_HHMMSS.txt       ← One per minute, same format
    dashboard-recorded/                 ← Hardlinks (not copies)
    db_state/
      db_debug_YYYYMMDD.log             ← With header row, pipe-delimited, 1-sec
    slow_queries/
      slow_queries_YYYYMMDD.log         ← Empty until RDS slow_query_log enabled
    dashboard/
      monitoring_dashboard_*.log        ← Dashboard tee output
  db/
    db_debug.log                        ← MySQL PROCESSLIST format
  pod_logs/                             ← NEW: 10,000 lines per pod (or --since)
    <podname>.log
  pod_describes/                        ← NEW: kubectl describe pod output
    <podname>.txt
```

### Verification Checks:
- [ ] `DB CONNECTION POOL — Summary` shows real numbers (not "DB query failed")
- [ ] `POD CONFIG` shows at least some non-dash values for pool settings
- [ ] `HPA` section present in metrics snapshots
- [ ] `logs/metrics_snapshots/` has 60+ files when recording duration > 1 hour
- [ ] `pod_describes/` has one `.txt` file per key pod
- [ ] `logs/db_state/` files start with `# timestamp|total_connections|...` header
- [ ] Error log files contain `### --- POD:` separator lines
- [ ] Error log files are ANSI-free (no `[31m`, `[39m`, `[32m` sequences)
- [ ] Pod log files have 10,000 lines (or equivalent `--since` coverage)

---

## Acknowledgments

Great work by the script developer on turning around these improvements quickly. The 10 fixes already implemented cover all 4 CRITICAL items and the most important HIGH items. Once the k8s-log-analyzer is updated to parse the new data sources (metrics_snapshots, pod_describes, db_state, HPA), the analysis dashboard will be significantly more comprehensive.

---

*Updated by k8s-log-analyzer team | 2026-02-12*
