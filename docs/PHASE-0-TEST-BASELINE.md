# Phase 0: Baseline & Safety Net — Test Coverage

## Overview

Created comprehensive characterization tests for pure logic functions as a safety net before refactoring. These tests capture **current behavior**, not necessarily correct behavior.

## Test Files Created

### 1. `apps/web/test/evaluate-outcome.test.ts`

**Function:** `evaluateOutcome()` from `apps/web/lib/alert-threshold.ts`

**Coverage (25 tests):**
- Default behavior (>=400 = down)
- Custom `failStatusCodes` (5xx only, custom lists)
- `maxLatencyMs` threshold (within, at boundary, exceeded)
- Combined status + latency thresholds
- Null/undefined config handling
- Empty `failStatusCodes` array
- Boundary status codes (100, 200, 599, 0)

**Key behaviors captured:**
- `null`/`undefined` config → default >=400 logic
- Empty `failStatusCodes` array → falls back to default
- `latencyMs > maxLatencyMs` (strictly greater, not >=)
- Reasons are comma-separated when both fire

---

### 2. `packages/db/test/consecutive-failures.test.ts`

**Function:** `consecutiveFailures()` from `packages/db/src/queries/monitors.ts`

**Coverage (18 tests):**
- 0 failures (most recent ok)
- 1-3 consecutive failures
- Recovery reset behavior
- Empty events
- Lookback parameter (default=5, custom)
- Mixed sequences
- Two-strike rule contract

**Key behaviors captured:**
- Events are ordered **newest-first** (`desc(monitorEvents.ts)`)
- Counts consecutive failures from newest backwards
- Stops counting when it hits an ok event
- Returns 0 when most recent event is ok
- `look` parameter defaults to 5

**Note:** Uses DB mocking since this function is DB-dependent.

---

### 3. `packages/db/test/diff-dns.test.ts`

**Function:** `diffDnsRecords()` from `packages/db/src/dns-checker.ts`

**Coverage (20 tests):**
- No change (identical records, different order)
- Added records (single, multiple, CNAME)
- Removed records (single, multiple)
- Both added and removed (CDN migration)
- First baseline (empty → populated)
- All records removed (populated → empty)
- Mixed record types (A, CNAME, NS)
- Duplicate records
- Type discrimination (same value, different types)

**Key behaviors captured:**
- Set-based comparison (O(n), order-independent)
- Key format: `type:value`
- Same value with different types = different records
- Deduplicates identical records

---

### 4. `apps/web/test/uptime-days.test.ts`

**Function:** `toDays()` from `apps/web/components/monitors/uptime-days.ts`

**Coverage (18 tests):**
- UTC day grouping
- Success/failure counting
- Oldest-first ordering
- Windowing (days parameter, default=90)
- Serialized timestamps (ISO string, Date objects)
- Empty input
- Single event
- Multi-day sequences
- Uptime calculation contract

**Key behaviors captured:**
- Groups by UTC day (not local timezone)
- Returns days sorted **oldest-first**
- `days` parameter defaults to 90
- Only days with events appear (gaps are skipped)
- Accepts both `Date` objects and ISO strings

---

## Test Results

```
apps/web:   32 passed, 509 tests
packages/db: 5 passed, 57 tests (new files only)
```

All tests are green.

## Commands to Run

```bash
# Run all new tests
pnpm --filter @scanlyfix/web test -- --run test/evaluate-outcome.test.ts test/uptime-days.test.ts
pnpm --filter @scanlyfix/db test -- --run test/diff-dns.test.ts test/consecutive-failures.test.ts

# Run all tests in each package
pnpm --filter @scanlyfix/web test
pnpm --filter @scanlyfix/db test
```

## Next Steps

These characterization tests serve as a safety net for Phase 1+ refactoring:
- If a refactor changes behavior, these tests will fail
- Review failing tests to determine if the change is intentional
- Update tests only after confirming the new behavior is correct
