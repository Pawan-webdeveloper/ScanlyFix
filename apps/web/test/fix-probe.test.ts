import { describe, it } from 'vitest'
import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { db } from '@scanlyfix/db'
import { findings, scans } from '@scanlyfix/db'
import { desc, eq } from 'drizzle-orm'
import { generateFix } from '../lib/fixes.ts'

/**
 * One-off reproduction probe: the exact generateFix code path against the
 * database's most recent finding — the data the user's Fix button sends.
 * Not asserted; prints the outcome. Skipped by default; run with
 * FIX_PROBE=1 pnpm vitest run test/fix-probe.test.ts
 */
config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true })

describe.skipIf(!process.env.FIX_PROBE)('fix generation probe', () => {
  it('runs generateFix on the latest real finding', async () => {
    const rows = await db
      .select({
        scanId: scans.id,
        scanUrl: scans.url,
        checkId: findings.checkId,
        category: findings.category,
        severity: findings.severity,
        title: findings.title,
        description: findings.description,
        evidence: findings.evidence,
        remediation: findings.remediation,
      })
      .from(findings)
      .innerJoin(scans, eq(findings.scanId, scans.id))
      .orderBy(desc(scans.createdAt))
      .limit(3)

    console.log(`[probe] latest findings: ${rows.length}`)
    for (const row of rows) {
      console.log(`[probe] trying ${row.checkId} (${row.severity}) evidence bytes=${JSON.stringify(row.evidence ?? null).length}`)
      const result = await generateFix({
        checkId: row.checkId,
        category: row.category,
        severity: row.severity,
        title: row.title,
        description: row.description,
        evidence: row.evidence ?? null,
        remediation: row.remediation,
        siteUrl: row.scanUrl,
      })
      if (result.ok) {
        console.log(`[probe] OK (${result.prompt.length} chars): ${result.prompt.slice(0, 100)}...`)
      } else {
        console.log(`[probe] FAILED reason=${result.reason}`)
      }
    }
  }, 120_000)
})
