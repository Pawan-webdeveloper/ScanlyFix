/**
 * The deep half of a repo scan: a bounded, authenticated clone followed by
 * gitleaks (secrets in history) and osv-scanner (known-vuln dependencies).
 *
 * Everything runs under the worker's own process with explicit timeouts, and
 * the tree is deleted in a `cleanup` the caller runs in a `finally`. The worker
 * owns the credentials; the cloned code never sees a token or a callback.
 */

import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { GitleaksFinding, OsvFinding, RepoCloneContext } from '@scanlyfix/repo-checks'

const pExecFile = promisify(execFile)

const CLONE_TIMEOUT_MS = 120_000
const TOOL_TIMEOUT_MS = 120_000
const DEFAULT_HISTORY_DEPTH = 1

export interface CloneHandle {
  context: RepoCloneContext
  cleanup: () => void
}

export async function cloneAndScan(
  token: string,
  owner: string,
  name: string,
  defaultBranch: string,
  historyDepth?: number,
  signal?: AbortSignal,
): Promise<CloneHandle> {
  const workDir = mkdtempSync(join(tmpdir(), 'scanlyfix-repo-'))
  const rootDir = join(workDir, 'repo')

  try {
    const url = `https://x-access-token:${token}@github.com/${owner}/${name}.git`
    await pExecFile(
      'git',
      ['clone', '--depth', String(historyDepth ?? DEFAULT_HISTORY_DEPTH), '--branch', defaultBranch, '--single-branch', url, rootDir],
      { timeout: CLONE_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024, killSignal: 'SIGKILL', signal },
    )

    const gitleaks = await runGitleaks(rootDir, join(workDir, 'gitleaks.json'), signal)
    const osv = await runOsv(rootDir, signal)

    const context: RepoCloneContext = {
      rootDir,
      // ponytail: fileIndex/readFile/gitLog are for deep code-quality checks
      // that do not exist yet; populate them when a check starts reading them.
      fileIndex: [],
      readFile: () => null,
      gitLog: [],
      gitleaks,
      osv,
    }
    return { context, cleanup: () => rmSync(workDir, { recursive: true, force: true }) }
  } catch (error) {
    rmSync(workDir, { recursive: true, force: true })
    throw error
  }
}

async function runGitleaks(rootDir: string, reportPath: string, signal?: AbortSignal): Promise<GitleaksFinding[]> {
  await pExecFile(
    'gitleaks',
    ['git', '--source', rootDir, '--report-format', 'json', '--report-path', reportPath, '--no-banner', '--exit-code', '0'],
    { timeout: TOOL_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024, killSignal: 'SIGKILL', signal },
  )
  return parseGitleaks(readFileSync(reportPath, 'utf8'))
}

async function runOsv(rootDir: string, signal?: AbortSignal): Promise<OsvFinding[]> {
  // osv-scanner exits 1 when it finds vulnerabilities, so treat a non-zero exit
  // with stdout as a normal result, not a failure.
  let stdout = ''
  try {
    ;({ stdout } = await pExecFile('osv-scanner', ['scan', '--source', rootDir, '--format', 'json'], {
      timeout: TOOL_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      killSignal: 'SIGKILL',
      signal,
    }))
  } catch (error) {
    const out = (error as { stdout?: string }).stdout
    if (!out) throw error
    stdout = out
  }
  return parseOsv(stdout)
}

interface GitleaksReportEntry {
  RuleID?: string
  File?: string
  StartLine?: number
  Fingerprint?: string
}

function parseGitleaks(raw: string): GitleaksFinding[] {
  let data: GitleaksReportEntry[]
  try {
    data = JSON.parse(raw) as GitleaksReportEntry[]
  } catch {
    return []
  }
  if (!Array.isArray(data)) return []
  return data
    .filter((e) => typeof e.RuleID === 'string')
    .map((e) => ({
      rule: e.RuleID!,
      file: e.File ?? '',
      line: e.StartLine ?? 0,
      // Never the raw match: issuer-kind + truncated fingerprint is enough to
      // locate the leak without re-publishing the secret.
      sample: e.Fingerprint ? `${e.RuleID} (${e.Fingerprint.slice(0, 8)})` : e.RuleID!,
    }))
}

interface OsvVuln {
  id?: string
  affected?: Array<{ ranges?: Array<{ events?: Array<{ fixed?: string }> }> }>
}

interface OsvPackage {
  package?: { name?: string; version?: string }
  vulnerabilities?: OsvVuln[]
  groups?: Array<{ ids?: string[]; max_severity?: string }>
}

interface OsvReport {
  results?: Array<{ packages?: OsvPackage[] }>
}

function parseOsv(raw: string): OsvFinding[] {
  let data: OsvReport
  try {
    data = JSON.parse(raw) as OsvReport
  } catch {
    return []
  }
  const out: OsvFinding[] = []
  for (const result of data.results ?? []) {
    for (const pkg of result.packages ?? []) {
      const name = pkg.package?.name ?? ''
      const version = pkg.package?.version ?? ''
      for (const vuln of pkg.vulnerabilities ?? []) {
        out.push({
          package: name,
          version,
          vulnId: vuln.id ?? '',
          severity: severityFor(vuln.id, pkg.groups),
          fixed: fixedFor(vuln),
        })
      }
    }
  }
  return out
}

function severityFor(id: string | undefined, groups: OsvPackage['groups']): string {
  for (const group of groups ?? []) {
    if (id && (group.ids ?? []).includes(id)) return group.max_severity ?? 'UNKNOWN'
  }
  return 'UNKNOWN'
}

function fixedFor(vuln: OsvVuln): string | null {
  for (const affected of vuln.affected ?? []) {
    for (const range of affected.ranges ?? []) {
      for (const event of range.events ?? []) {
        if (typeof event.fixed === 'string') return event.fixed
      }
    }
  }
  return null
}
