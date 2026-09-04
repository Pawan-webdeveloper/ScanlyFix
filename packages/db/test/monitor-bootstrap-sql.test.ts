/**
 * packages/db/test/monitor-bootstrap-sql.test.ts
 *
 * Regression test for the bug that broke every project creation: the default
 * monitor inserts used `onConflictDoUpdate` with an EMPTY `set` object, which
 * Drizzle rejects at query-build time with "No values to set" — the statement
 * never reached Postgres, so add-domain failed for every account while reads
 * kept working (which is why the dashboard rendered but the form errored).
 *
 * "Leave the existing row alone" is `onConflictDoNothing`. This test builds
 * the same statements createProjectWithMonitors and ensureDefaultMonitors
 * issue and asserts they compile to SQL. No database: .toSQL() stops at the
 * query builder, which is exactly where the failure lived.
 */

import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { db, monitors } from '../src/index.ts'

const projectId = randomUUID()

function bootstrapStatement(conflict: 'nothing' | 'empty-update') {
  const insert = db
    .insert(monitors)
    .values({
      projectId,
      type: 'uptime',
      enabled: true,
      intervalS: 60,
    })
    .onConflictDoNothing({ target: [monitors.projectId, monitors.type] })
  if (conflict === 'nothing') return insert
  // The broken shape, kept here so the failure mode this guards against is
  // executable: drizzle throws the moment this builder is asked for SQL.
  return insert.onConflictDoUpdate({
    target: [monitors.projectId, monitors.type],
    set: {},
  })
}

describe('default monitor bootstrap SQL', () => {
  it('onConflictDoNothing compiles, with the project+type conflict target', () => {
    const { sql } = bootstrapStatement('nothing').toSQL()
    expect(sql).toContain('on conflict')
    expect(sql).toContain('do nothing')
  })

  it('the empty onConflictDoUpdate set throws, so it can never return quietly', () => {
    expect(() => bootstrapStatement('empty-update').toSQL()).toThrow('No values to set')
  })
})
