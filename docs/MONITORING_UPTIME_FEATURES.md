# Monitoring & Uptime — Complete Feature Documentation

## Table of Contents

1. [Overview](#overview)
2. [Monitor Types](#monitor-types)
3. [Pages & Routes](#pages--routes)
4. [API Endpoints](#api-endpoints)
5. [Dashboard Components](#dashboard-components)
6. [Background Jobs (Inngest)](#background-jobs-inngest)
7. [Alert System](#alert-system)
8. [Snoozing](#snoozing)
9. [Public Status Pages](#public-status-pages)
10. [Database Schema](#database-schema)
11. [Business Rules & Constants](#business-rules--constants)

---

## Overview

The monitoring system provides **real-time uptime tracking**, **SSL/domain certificate monitoring**, **Core Web Vitals tracking**, and **full-site re-scanning** for all user projects. It runs background probes via Inngest, records events in the database, and sends alerts via email and Slack when thresholds are breached.

### Architecture

```
┌─────────────┐     ┌──────────────┐     ┌────────────────┐
│  Cron Sweep │────▶│  Inngest      │────▶│  Probe Workers │
│  (every 1m) │     │  Fan-out      │     │  (4 types)     │
└─────────────┘     └──────────────┘     └───────┬────────┘
                                                  │
                                          ┌───────▼────────┐
                                          │  PostgreSQL    │
                                          │  (events,      │
                                          │   incidents,   │
                                          │   snapshots)   │
                                          └───────┬────────┘
                                                  │
                                          ┌───────▼────────┐
                                          │  Alert Engine  │
                                          │  (email/slack) │
                                          └────────────────┘
```

---

## Monitor Types

Each project can have **one monitor per type** (enforced by unique index).

| Type | Interval | What It Does | When It Alerts |
|------|----------|--------------|----------------|
| **`uptime`** | Every 60 seconds | HTTP probe — fetches project URL, checks status code + latency | After 2 consecutive failures |
| **`domain`** | Daily (86,400s) | TLS certificate expiry + domain registration expiry + DNS drift detection | SSL: 30/14/7/3/1 days before expiry. Domain: 30 days. DNS: any record change |
| **`web_vitals`** | Configurable | Core Web Vitals via Google PageSpeed Insights API | When any metric crosses warn/critical threshold |
| **`rescan`** | Daily (86,400s) | Full site re-scan using the same engine/profile as last scan | Only on score drop (improvements are silent) |

---

## Pages & Routes

### Authenticated Pages (require login)

| Route | File | Purpose |
|-------|------|---------|
| `/monitors` | `app/(app)/monitors/page.tsx` | **Main dashboard** — lists all monitors across all user projects with status dots, uptime %, and project names |
| `/monitors/[id]` | `app/(app)/monitors/[id]/page.tsx` | **Monitor detail** — for uptime/rescan: response time charts, incidents, check logs, snooze, alert config. For domain: SSL + domain expiry cards |
| `/monitoring` | `app/(app)/monitoring/page.tsx` | **SSL & Domain overview** — lists all domain-type monitors with certificate and domain expiry status |
| `/projects/[id]/monitors` | `app/(app)/projects/[projectId]/monitors/page.tsx` | **Per-project config** — toggle monitors on/off, view uptime chart, configure alert thresholds |

### Public Pages (no auth)

| Route | File | Purpose |
|-------|------|---------|
| `/status/[slug]` | `components/status/[slug]/page.tsx` | **Public status page** — shows UP/DOWN state, 90-day uptime %, uptime strip, recent incidents. Revalidates every 60s. `robots: noindex`. |

---

## API Endpoints

### List All Monitors

```
GET /api/monitors
```

Returns all monitors for the signed-in user across all their projects.

**Response:**
```json
{
  "monitors": [
    {
      "id": "uuid",
      "type": "uptime",
      "projectId": "uuid",
      "enabled": true,
      "lastStatus": "up",
      "intervalS": 60,
      "lastRunAt": "2026-01-01T00:00:00Z",
      "createdAt": "2026-01-01T00:00:00Z",
      "projectUrl": "https://example.com",
      "projectName": "My Project"
    }
  ]
}
```

---

### Get Uptime Percentage

```
GET /api/monitors/[id]/uptime?period=24h|7d|30d
```

Calculates uptime percentage from recorded events.

**Query Parameters:**
| Param | Values | Default |
|-------|--------|---------|
| `period` | `24h`, `7d`, `30d` | `24h` |

**Response:**
```json
{
  "total": 1440,
  "up": 1435,
  "down": 5,
  "uptimePercent": 99.65
}
```

**Note:** Returns 100% when no events exist (not down, just unchecked).

---

### Get Incidents

```
GET /api/monitors/[id]/incidents
```

Returns up to 50 incidents, newest first. Includes both ongoing (resolvedAt=null) and resolved incidents.

**Response:**
```json
{
  "incidents": [
    {
      "id": "uuid",
      "monitorId": "uuid",
      "startedAt": "2026-01-01T12:00:00Z",
      "resolvedAt": "2026-01-01T12:15:00Z",
      "durationMs": 900000,
      "statusCode": 503,
      "detail": "Service Unavailable"
    }
  ]
}
```

---

### Snooze / Unsnooze Monitor

```
GET    /api/monitors/[id]/snooze    — Get current snooze status
POST   /api/monitors/[id]/snooze    — Set snooze
DELETE /api/monitors/[id]/snooze    — Remove snooze
```

**POST Body:**
```json
{
  "expiresAt": "2026-01-01T12:00:00Z",
  "reason": "Scheduled maintenance"
}
```

**Snooze Options:**
| Duration | `expiresAt` Value |
|----------|-------------------|
| 1 hour | `now + 1h` |
| 4 hours | `now + 4h` |
| 24 hours | `now + 24h` |
| Until I resume | `null` (indefinite) |

**Key behavior:** Snoozed monitors still have checks run — only **alerts are suppressed**. Incidents are still created.

---

### Get Live SSL & Domain Status

```
GET /api/monitors/[id]/monitoring
```

**Runs fresh checks on every request** (no caching). Verifies viewer owns the project.

**Response:**
```json
{
  "hostname": "example.com",
  "ssl": {
    "ok": true,
    "daysUntilExpiry": 45,
    "expiresAt": "2026-02-15T00:00:00Z",
    "subject": "example.com",
    "detail": null
  },
  "domain": {
    "ok": true,
    "daysUntilExpiry": 320,
    "expiresAt": "2027-01-01T00:00:00Z",
    "registrar": "GoDaddy",
    "detail": null
  }
}
```

---

### Get / Update Alert Config

```
GET   /api/monitors/[id]/config    — Get current alert config
PATCH /api/monitors/[id]/config    — Update alert config
```

**PATCH Body:**
```json
{
  "alertConfig": {
    "failStatusCodes": [500, 502, 503, 504],
    "maxLatencyMs": 3000
  }
}
```

**Presets for `failStatusCodes`:**
| Preset | Codes |
|--------|-------|
| `5xx_only` | `[500, 502, 503, 504, 507, 508, 510, 511]` |
| `4xx_and_5xx` | `400–599` |
| `non_200` | `201–599` |
| `default` | `undefined` (uses ≥400 = down) |

**Constraints:**
- `failStatusCodes`: 100–599, max 50 entries
- `maxLatencyMs`: 100–60,000ms, nullable (null = disabled)

---

### Get Check Logs

```
GET /api/monitors/[id]/logs?limit=50
```

Returns check history with **computed diffs** between consecutive events.

**Query Parameters:**
| Param | Range | Default |
|-------|-------|---------|
| `limit` | 1–200 | `50` |

**Response:**
```json
{
  "logs": [
    {
      "id": "uuid",
      "ok": true,
      "statusCode": 200,
      "latencyMs": 145,
      "ts": "2026-01-01T00:00:00Z",
      "diff": {
        "statusCode": null,
        "latencyMs": { "from": 200, "to": 145 },
        "detail": null
      }
    }
  ]
}
```

**Diff fields:** Only present when a value changed from the previous check. Shows `from` and `to` values.

---

### Deploy Hook (CI/CD Integration)

```
POST /api/monitors/deploy-hook?token=<secret>
```

Triggered after a deploy to immediately check all monitors for a project.

**Body:**
```json
{
  "url": "https://example.com"
}
```

**Authentication:** `token` query parameter validated with `timingSafeEqual` against `DEPLOY_HOOK_SECRET` env var.

**Security:**
- SSRF prevention: blocks private IPs, localhost, internal TLDs
- Only public HTTPS URLs accepted
- Project matched by URL (CI systems know deploy URL, not internal IDs)

**Behavior:** Finds all enabled monitors for the matched project and emits `monitorDue` Inngest events. Inngest dedup prevents double-fires.

---

## Dashboard Components

### MonitorList (`components/monitors/monitor-list.tsx`)

**Type:** Client component  
**Auto-refresh:** Every 30 seconds

Displays all monitors in a table with:
- **StatusDot** — green (up), red (down), gray (unknown)
- **Project name + URL**
- **Type badge** — Uptime, SSL & Domain, Daily Re-scan
- **Time since last check** — "2m ago", "1h ago"
- **Interval text** — "Every 1m", "Every 24h"
- **Uptime %** — fetched from `/api/monitors/{id}/uptime?period=7d`

---

### MonitorRow (`components/monitors/monitor-row.tsx`)

**Type:** Client component  
**Purpose:** Toggle switch for enabling/disabling a monitor

- Toggle switch with optimistic UI
- Shows "passing" / "failing" status when enabled
- Interval displayed but **NOT editable** (product has opinions about trade-offs)

---

### MonitorDetail (`components/monitors/monitor-detail.tsx`)

**Type:** Client component  
**Auto-refresh:** Logs refresh every 30 seconds

**Sections:**
1. **Header** — StatusDot + project name + UP/DOWN badge
2. **Snooze** — `<SnoozeButton>` (only for `type === 'uptime'`)
3. **Stats row** — Uptime (7d), Average response time, Last check, Interval
4. **Response time chart** — Last 48 checks as bars
5. **Uptime %** — Period selector (24h / 7d / 30d) with `<UptimeBadge>`
6. **Incidents** — Recent incidents list
7. **Alert settings** — Only for `type === 'uptime'` — status code + latency config
8. **Recent checks** — Log entries with `<DiffBadge>` showing changes

---

### MonitoringDetail (`components/monitors/monitoring-detail.tsx`)

**Type:** Client component  
**Fetches:** `GET /api/monitors/{id}/monitoring` (fresh checks on each load)

**ExpiryCard Color Thresholds:**
| Days Until Expiry | Color |
|-------------------|-------|
| ≤7 days | Red (urgent) |
| ≤14 days | Orange |
| ≤30 days | Amber |
| >30 days | Emerald (safe) |

**Shows:**
- **SSL Certificate** — Days left, expiry date, subject (who it's issued to)
- **Domain Registration** — Days left, expiry date, registrar

---

### UptimeChart (`components/monitors/uptime-chart.tsx`)

**90-day uptime strip** — one bar per day
- **Green bar** — all checks passed that day
- **Red bar** — any failure that day
- **Gray bar** — no data (day hasn't happened yet or no events)

Pure CSS (no chart library). Hover shows date + uptime %.

---

### ResponseTimeChart (`components/monitors/response-time-chart.tsx`)

**Last 48 check entries** as a bar chart (no library)

**Color Thresholds:**
| Latency | Color |
|---------|-------|
| Check failed | Red |
| <200ms | Emerald (fast) |
| <500ms | Yellow (ok) |
| ≥500ms | Orange (slow) |

Hover tooltips show latency + time. Max latency displayed.

---

### UptimeBadge (`components/monitors/uptime-badge.tsx`)

**Color-coded uptime percentage badge:**
| Uptime | Color | Meaning |
|--------|-------|---------|
| ≥99.9% | Emerald | Excellent |
| ≥99% | Yellow | Good |
| <99% | Red | Needs attention |

Format: `XX.XX%`

---

### DiffBadge (`components/monitors/diff-badge.tsx`)

**Shows changes between consecutive check events**

**Diff Fields:**
- `statusCode` — e.g., "200 → 503"
- `latencyMs` — e.g., "145ms → 2,300ms"
- `detail` — reason change

**Color:**
- Red — degradation (higher latency, worse status)
- Emerald — improvement
- Amber — neutral change

---

### SnoozeButton (`components/monitors/snooze-button.tsx`)

**Type:** Client component

**Snooze Durations:**
| Option | Duration |
|--------|----------|
| 1 hour | 3,600,000ms |
| 4 hours | 14,400,000ms |
| 24 hours | 86,400,000ms |
| Until I resume | Indefinite (`expiresAt = null`) |

**Reason field:** Optional text, max 200 characters.

**API calls:** `GET` (status), `POST` (snooze), `DELETE` (unsnooze)

---

### Status Components (Public Status Page)

| Component | File | Purpose |
|-----------|------|---------|
| `StatusHeader` | `components/status/status-header.tsx` | UP/DOWN state, last checked, 90-day uptime %, banner text |
| `UptimeStrip` | `components/status/uptime-strip.tsx` | 90-day bar strip (green/red/gray) |
| `IncidentsTable` | `components/status/incidents-table.tsx` | Recent incidents with Ongoing/Resolved badges |

**Banner Text:**
- "All systems operational" (all up)
- "Service disruption detected" (any down)
- "No data yet" (no events)

---

## Background Jobs (Inngest)

### Sweep Scheduler (`inngest/sweep.ts`)

**Cron:** Every minute (`* * * * *`)  
**Concurrency:** 1 (serialized)

**Logic:**
1. Calls `dueMonitorsForScheduler()` — finds all enabled monitors where `lastRunAt` is null or older than `intervalS`
2. Fans out one `monitorDue` event per due monitor
3. Each probe runs independently with its own retry/timeout/concurrency

---

### Uptime Probe (`inngest/uptime-probe.ts`)

**Trigger:** `monitorDue` where `type == "uptime"`  
**Concurrency:** 20 | **Retries:** 0

**Steps:**
1. **Snooze guard** — checks `isMonitorSnoozed()`. If snoozed, exits cleanly (no event recorded, no `lastRunAt` advanced)
2. **HTTP probe** — `safeFetch(url, { timeoutMs: 15000, maxBodyBytes: 4096 })`
3. **Evaluate** — Fetches `alertConfig` from DB, applies `evaluateOutcome()` (custom status codes + latency threshold)
4. **Record + Alert** — `recordMonitorRun()`. If ok → `resolveIncident()`. If fail → check `consecutiveFailures()`
5. **Alert after 2 consecutive failures** (`FAILURES_BEFORE_ALERT = 2`)
6. **Dedup** — `recordAlertOnce()` prevents duplicate alerts per day

**Key Constants:**
| Constant | Value |
|----------|-------|
| `PROBE_TIMEOUT_MS` | 15,000ms |
| `FAILURES_BEFORE_ALERT` | 2 |

---

### Domain Health (`inngest/domain-health.ts`)

**Trigger:** `monitorDue` where `type == "domain"`  
**Concurrency:** 20 | **Retries:** 1

**Steps:**
1. TLS handshake → `getTlsInfo()` → compute `daysLeft`
2. **Threshold alerts** (descending, first match wins): `[30, 14, 7, 3, 1]` days
3. Alert kind: `certificate-expiry-{threshold}` (e.g., `certificate-expiry-30`, `certificate-expiry-7`)

**Key Constant:**
| Constant | Value |
|----------|-------|
| `THRESHOLD_DAYS` | `[30, 14, 7, 3, 1]` |

---

### Monitoring Probe (`inngest/monitoring-probe.ts`)

**Trigger:** `monitorDue` where `type == "domain"`  
**Concurrency:** 10 | **Retries:** 0

**Steps:**
1. **SSL check** — `checkSsl(hostname)` → `daysUntilExpiry`
2. **Domain check** — `checkDomain(hostname)` → `daysUntilExpiry`
3. **Record + Alert:**
   - `tls_expiring` if SSL ≤ 14 days
   - `domain_expiring` if domain ≤ 30 days
   - Both mark `urgent: true` if ≤ 7 days
4. **DNS check** — `checkDns(hostname)` → A/CNAME/NS records
5. **DNS diff** — Compares with previous snapshot via `diffDnsRecords()`. Alert `dns_drift` if records changed. First check sets baseline without alert.

**Key Constants:**
| Constant | Value |
|----------|-------|
| `SSL_WARN_DAYS` | 14 |
| `DOMAIN_WARN_DAYS` | 30 |

---

### Web Vitals Probe (`inngest/web-vitals-probe.ts`)

**Trigger:** `monitorDue` where `type == "web_vitals"`  
**Concurrency:** 5 | **Retries:** 0

**Steps:**
1. **PSI fetch** — `checkWebVitals(url)` (30–60s call)
2. **Snapshot** — `recordWebVitalsSnapshot()` (CLS rounded to 4 decimals)
3. **Evaluate** — Against Google's official thresholds
4. **Alert** — `web_vitals` if any violations

**Google Core Web Vitals Thresholds:**
| Metric | Warn | Critical | Unit |
|--------|------|----------|------|
| LCP (Largest Contentful Paint) | 2,500ms | 4,000ms | ms |
| FID (First Input Delay) | 100ms | 300ms | ms |
| CLS (Cumulative Layout Shift) | 0.1 | 0.25 | — |
| FCP (First Contentful Paint) | 1,800ms | 3,000ms | ms |
| TTFB (Time to First Byte) | 800ms | 1,800ms | ms |
| SI (Speed Index) | 3,400ms | 5,800ms | ms |

---

### Scheduled Rescan (`inngest/scheduled-rescan.ts`)

**Trigger:** `monitorDue` where `type == "rescan"`  
**Concurrency:** 4 | **Retries:** 2

**Steps:**
1. Read previous scan
2. Re-scan at same profile (fast/deep)
3. **Comparability check:** Same engine version + same profile + no degraded pillars
4. **Alert only on score drop** — improvements are silent
5. Alert kind: `score-drop` with `{ before, after, delta }`

---

## Alert System

### Alert Kinds

| Kind | Triggered By | Description |
|------|--------------|-------------|
| `downtime` | uptime-probe | After 2 consecutive HTTP failures |
| `tls_expiring` | monitoring-probe | SSL certificate ≤ 14 days to expiry |
| `domain_expiring` | monitoring-probe | Domain registration ≤ 30 days to expiry |
| `certificate-expiry-{days}` | domain-health | SSL at 30/14/7/3/1 day thresholds |
| `dns_drift` | monitoring-probe | DNS records changed (A/CNAME/NS) |
| `web_vitals` | web-vitals-probe | Any Core Web Vitals threshold breach |
| `score-drop` | scheduled-rescan | Scan score regression |

### Delivery Channels

| Channel | Config | Validation |
|---------|--------|------------|
| **Email** | Sent to project owner | Always available |
| **Slack** | Incoming webhook URL | Must start with `https://hooks.slack.com/services/` |

### Deduplication

- **Daily per (project, kind)** — `recordAlertOnce()` checks if same alert kind exists for today (UTC start-of-day)
- Different thresholds = different alert kinds (e.g., `certificate-expiry-30` vs `certificate-expiry-7`)
- Prevents alert fatigue from repeated notifications

### Alert Channel Management

| Operation | Endpoint |
|-----------|----------|
| List channels | Internal query (masked for external) |
| Add/Update channel | `upsertAlertChannel()` |
| Toggle enabled | `setAlertChannelEnabled()` |
| Delete channel | `deleteAlertChannel()` |

**Security:** Slack webhook URLs are masked in external responses — only last 6 chars visible: `https://hooks.slack.com/services/***xxxxxx`

---

## Snoozing

### How It Works

1. User clicks Snooze → selects duration + optional reason
2. `POST /api/monitors/[id]/snooze` creates snooze record
3. During probe execution, `isMonitorSnoozed()` is checked first
4. If snoozed → probe **exits cleanly** (no event recorded, no `lastRunAt` advanced)
5. Snooze expires automatically or user manually unsnoozes

### Important Behavior

- **Snooze suppresses alerts ONLY** — checks still run, incidents still created
- **One active snooze per monitor** — new snooze replaces existing (upsert)
- **Indefinite snooze** — `expiresAt = null` means "until I resume"
- **Audit trail** — snooze history preserved (delete + insert pattern)

### Snooze Data

```json
{
  "monitorId": "uuid",
  "expiresAt": "2026-01-01T12:00:00Z | null",
  "reason": "Scheduled maintenance (optional)",
  "createdBy": "user-uuid"
}
```

---

## Public Status Pages

### URL Format

```
/status/{project-slug}
```

### Features

- **No authentication required** — accessible to anyone
- **Shows:**
  - Current status (UP/DOWN with visual indicator)
  - 90-day uptime percentage
  - 90-day uptime strip (green/red/gray bars)
  - Recent incidents (up to 10)
- **Revalidation:** Every 60 seconds (`revalidate = 60`)
- **SEO:** `robots: { index: false }` — not indexed by search engines
- **Slug validation:** `^[a-z0-9-]+$` — only lowercase alphanumeric + hyphens

### Data Returned

```json
{
  "projectName": "My Project",
  "url": "https://example.com",
  "currentStatus": "up | down | unknown",
  "lastCheckedAt": "2026-01-01T00:00:00Z",
  "uptimePercent": 99.95,
  "dailyBuckets": [
    { "date": "2026-01-01", "ok": true },
    { "date": "2025-12-31", "ok": false }
  ],
  "recentIncidents": [
    {
      "startedAt": "2025-12-31T12:00:00Z",
      "resolvedAt": "2025-12-31T12:15:00Z",
      "durationMs": 900000,
      "statusCode": 503
    }
  ]
}
```

---

## Database Schema

### `monitors`

One row per monitor type per project.

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `id` | UUID | `gen_random_uuid()` | Primary key |
| `project_id` | UUID | — | FK → projects (cascade delete) |
| `type` | enum | — | `uptime`, `domain`, `web_vitals`, `rescan` |
| `interval_s` | integer | 3600 | Check interval in seconds |
| `enabled` | boolean | true | Toggle on/off |
| `last_run_at` | timestamptz | null | When probe last ran |
| `last_status` | text | null | `'up'` or `'down'` |
| `alert_config` | jsonb | null | `{ failStatusCodes?, maxLatencyMs? }` |
| `created_at` | timestamptz | `now()` | Creation timestamp |

**Indexes:**
- UNIQUE on `(project_id, type)` — one monitor per type per project
- Composite on `(enabled, last_run_at)` — for sweep scheduler queries

---

### `monitor_events`

Append-only probe log. One row per check.

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `id` | UUID | `gen_random_uuid()` | Primary key |
| `monitor_id` | UUID | — | FK → monitors (cascade delete) |
| `ts` | timestamptz | `now()` | Check timestamp |
| `ok` | boolean | — | Whether check passed |
| `status_code` | integer | null | HTTP status code |
| `latency_ms` | integer | null | Response time in ms |
| `detail` | text | null | Error message (if failed) |
| `diff` | jsonb | null | Change from previous check |

**Diff Structure:**
```json
{
  "statusCode": { "from": 200, "to": 503 },
  "latencyMs": { "from": 145, "to": 2300 },
  "detail": { "from": null, "to": "Service Unavailable" }
}
```

---

### `incidents`

Tracks downtime periods. Created on consecutive failures, resolved on recovery.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `monitor_id` | UUID | FK → monitors (cascade delete) |
| `started_at` | timestamptz | When incident began |
| `resolved_at` | timestamptz | null = ongoing |
| `duration_ms` | integer | null while ongoing |
| `status_code` | integer | HTTP status that triggered it |
| `detail` | text | Error message |

---

### `snoozed_monitors`

One active snooze per monitor.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `monitor_id` | UUID | FK → monitors (cascade delete), UNIQUE |
| `expires_at` | timestamptz | null = indefinite |
| `reason` | text | Optional reason |
| `created_by` | UUID | FK → users (cascade delete) |
| `created_at` | timestamptz | Creation timestamp |

---

### `web_vitals_snapshots`

Historical Core Web Vitals measurements.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `monitor_id` | UUID | FK → monitors (cascade delete) |
| `lcp_ms` | integer | Largest Contentful Paint |
| `fid_ms` | integer | First Input Delay |
| `cls` | real | Cumulative Layout Shift (4 decimals) |
| `fcp_ms` | integer | First Contentful Paint |
| `ttfb_ms` | integer | Time to First Byte |
| `si_ms` | integer | Speed Index |
| `ts` | timestamptz | Measurement timestamp |

---

### `dns_snapshots`

DNS record history for drift detection.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `monitor_id` | UUID | FK → monitors (cascade delete) |
| `records` | jsonb | `Array<{ type: 'A'|'CNAME'|'NS', value: string }>` |
| `created_at` | timestamptz | Snapshot timestamp |

**Note:** Snapshots are append-only, never deleted. First snapshot = baseline (no alert).

---

### `alerts`

Delivery log (not config). One row per dispatched alert.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `project_id` | UUID | FK → projects (cascade delete) |
| `kind` | text | Alert type (see Alert Kinds) |
| `channel` | enum | `email`, `slack` |
| `payload` | jsonb | Event-specific data |
| `sent_at` | timestamptz | null = queued/unsent |

---

### `alert_channels`

Per-project delivery targets.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `project_id` | UUID | FK → projects (cascade delete) |
| `channel` | enum | `email`, `slack` |
| `config` | jsonb | `{ webhookUrl }` for Slack, `{ email }` for email |
| `enabled` | boolean | Toggle on/off |
| `created_at` | timestamptz | Creation timestamp |

---

## Business Rules & Constants

### Probe Behavior

| Rule | Value | Source |
|------|-------|--------|
| Alert after N consecutive failures | 2 | `uptime-probe.ts` |
| Probe timeout | 15,000ms | `uptime-probe.ts` |
| Max response body bytes | 4,096 | `uptime-probe.ts` |
| Snooze exits cleanly (no event) | — | `uptime-probe.ts` |

### SSL & Domain Thresholds

| Threshold | Days | Alert Kind |
|-----------|------|------------|
| SSL expiry | 30, 14, 7, 3, 1 | `certificate-expiry-{days}` |
| SSL urgent priority | ≤7 days | `tls_expiring` (urgent) |
| Domain expiry | 30 | `domain_expiring` |
| Domain urgent priority | ≤7 days | `domain_expiring` (urgent) |

### DNS Monitoring

| Rule | Value |
|------|-------|
| DNS timeout | 5,000ms per lookup |
| Max records | 100 |
| Record types | A, CNAME, NS |
| First check | Baseline (no alert) |
| Subsequent checks | Alert on any add/remove |

### Web Vitals Thresholds

| Metric | Warn | Critical |
|--------|------|----------|
| LCP | 2,500ms | 4,000ms |
| FID | 100ms | 300ms |
| CLS | 0.1 | 0.25 |
| FCP | 1,800ms | 3,000ms |
| TTFB | 800ms | 1,800ms |
| SI | 3,400ms | 5,800ms |

### UI Display

| Rule | Value |
|------|-------|
| Uptime badge: excellent | ≥99.9% (emerald) |
| Uptime badge: good | ≥99% (yellow) |
| Uptime badge: needs attention | <99% (red) |
| Response time: fast | <200ms (emerald) |
| Response time: ok | <500ms (yellow) |
| Response time: slow | ≥500ms (orange) |
| Expiry card: urgent | ≤7 days (red) |
| Expiry card: warning | ≤14 days (orange) |
| Expiry card: caution | ≤30 days (amber) |
| Expiry card: safe | >30 days (emerald) |

### Auto-Refresh Intervals

| Component | Interval |
|-----------|----------|
| Monitor list | 30 seconds |
| Monitor detail logs | 30 seconds |
| Public status page | 60 seconds (ISR) |

### Limits

| Rule | Value |
|------|-------|
| Max alert config status codes | 50 |
| Max latency threshold | 60,000ms |
| Min latency threshold | 100ms |
| Max snooze reason length | 200 chars |
| Max DNS records | 100 |
| Max web vitals snapshots per fetch | 100 |
| Max logs per request | 200 |
| Incidents returned (API) | 50 |
| Incidents returned (public status) | 10 |
| Public status days | 90 |
| Uptime chart days | 90 |
| Response time chart entries | 48 |

### Security

| Rule | Implementation |
|------|----------------|
| Deploy hook auth | `timingSafeEqual` on `DEPLOY_HOOK_SECRET` |
| SSRF prevention | Blocks private IPs, localhost, `.local/.internal/.corp/.home/.lan` |
| Public status slug | `^[a-z0-9-]+$` validation |
| Alert channel masking | Slack webhook URLs show only last 6 chars |
| IDOR prevention | All API routes verify viewer owns the project |

### Concurrency Limits (Inngest)

| Probe | Concurrency | Retries |
|-------|-------------|---------|
| Sweep scheduler | 1 | — |
| Uptime probe | 20 | 0 |
| Domain health | 20 | 1 |
| Monitoring probe | 10 | 0 |
| Web Vitals probe | 5 | 0 |
| Scheduled rescan | 4 | 2 |
