/**
 * Assembles RepoApiContext from the GitHub API, in one pass, for the checks in
 * @scanlyfix/repo-checks to read. Shallow by design: no clone, no execution —
 * the same "pull what's needed without granting execution" model as the site
 * engine's fetch step.
 *
 * The fields a check does not read yet (pulls, workflowRuns, dependabotAlerts,
 * codeScanningAlerts) are deliberately left empty rather than fetched
 * speculatively — each is one more API call and one more rate-limit drain.
 */

import type { BranchProtection, CommitSummary, RepoApiContext, TreeEntry, WorkflowFile } from '@scanlyfix/repo-checks'

const MAX_WORKFLOWS = 50
// ponytail: cap the recursive tree; no current check reads past the first few
// hundred paths, and a monorepo can push this into six figures.
const MAX_TREE_ENTRIES = 10_000

interface RepoInfo {
  license?: { spdx_id?: string } | null
  security_and_analysis?: Record<string, unknown> | null
}

interface CommitInfo {
  sha: string
  commit?: {
    author?: { name?: string; date?: string }
    message?: string
    verification?: { verified?: boolean }
  }
}

interface DirEntry {
  name: string
  path: string
  type: string
}

interface ContentFile {
  content?: string
}

interface TreeResponse {
  tree?: { path: string; type: 'blob' | 'tree'; size?: number }[]
}

/*
 * Fields assigned in the body rather than declared as constructor parameter
 * properties: this service runs straight from source under Node's
 * `--experimental-strip-types`, which erases type annotations but refuses the
 * TS-only syntax that would need real code generated — a parameter property
 * among them. Declared parameter properties throw ERR_UNSUPPORTED_TYPESCRIPT_
 * SYNTAX at load, so the worker never binds its port. Keep this class plain.
 */
export class GithubError extends Error {
  readonly path: string
  readonly status: number

  constructor(path: string, status: number, body: string) {
    super(`GitHub API ${path} responded ${status}: ${body.slice(0, 500)}`)
    this.path = path
    this.status = status
  }
}

async function ghJson<T>(token: string, path: string): Promise<T | null> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'scanlyfix-github-scanner',
    },
    signal: AbortSignal.timeout(30_000),
  })
  if (res.status === 404) return null
  if (!res.ok) throw new GithubError(path, res.status, await res.text())
  return (await res.json()) as T
}

function decode(file: ContentFile | null): string {
  if (typeof file?.content !== 'string') return ''
  return Buffer.from(file.content, 'base64').toString('utf8')
}

export async function buildRepoApiContext(
  token: string,
  owner: string,
  name: string,
  defaultBranch: string,
): Promise<RepoApiContext> {
  const base = `/repos/${owner}/${name}`
  const ref = encodeURIComponent(defaultBranch)

  const [repo, commits, protection, tree, workflowsDir, gitignore, codeowners] = await Promise.all([
    ghJson<RepoInfo>(token, base),
    ghJson<CommitInfo[]>(token, `${base}/commits?sha=${ref}&per_page=30`),
    ghJson<BranchProtection>(token, `${base}/branches/${ref}/protection`),
    ghJson<TreeResponse>(token, `${base}/git/trees/${ref}?recursive=1`),
    ghJson<DirEntry[]>(token, `${base}/contents/.github/workflows?ref=${ref}`),
    ghJson<ContentFile>(token, `${base}/contents/.gitignore?ref=${ref}`),
    findCodeowners(token, base, ref),
  ])

  if (!repo) throw new GithubError(base, 404, 'repository not found or not accessible to this installation')

  return {
    commits: mapCommits(commits ?? []),
    pulls: [],
    workflows: await fetchWorkflows(token, base, ref, workflowsDir ?? []),
    workflowRuns: [],
    branchProtection: protection ?? null,
    codeowners,
    dependabotAlerts: [],
    codeScanningAlerts: [],
    securityAndAnalysis: mapSecurity(repo),
    tree: mapTree(tree),
    license: repo.license?.spdx_id ?? null,
    gitignore: decode(gitignore),
  }
}

/** GitHub checks root, .github/, then docs/ — fetch all three, keep the first found. */
async function findCodeowners(token: string, base: string, ref: string): Promise<string | null> {
  const [root, github, docs] = await Promise.all([
    ghJson<ContentFile>(token, `${base}/contents/CODEOWNERS?ref=${ref}`),
    ghJson<ContentFile>(token, `${base}/contents/.github/CODEOWNERS?ref=${ref}`),
    ghJson<ContentFile>(token, `${base}/contents/docs/CODEOWNERS?ref=${ref}`),
  ])
  const found = [root, github, docs].find((f) => f?.content !== undefined)
  return found ? decode(found) : null
}

async function fetchWorkflows(
  token: string,
  base: string,
  ref: string,
  dir: DirEntry[],
): Promise<WorkflowFile[]> {
  const files = dir.filter((e) => e.type === 'file' && /\.ya?ml$/i.test(e.name)).slice(0, MAX_WORKFLOWS)
  const workflows = await Promise.all(
    files.map(async (f) => {
      const content = await ghJson<ContentFile>(token, `${base}/contents/${encodeURIComponent(f.path)}?ref=${ref}`)
      return content ? { path: f.path, name: f.name, yaml: decode(content) } : null
    }),
  )
  return workflows.filter((w): w is WorkflowFile => w !== null)
}

function mapCommits(commits: CommitInfo[]): CommitSummary[] {
  return commits.map((c) => ({
    sha: c.sha,
    author: c.commit?.author?.name ?? '',
    date: c.commit?.author?.date ?? '',
    message: c.commit?.message ?? '',
    verified: Boolean(c.commit?.verification?.verified),
  }))
}

function mapTree(tree: TreeResponse | null): TreeEntry[] {
  return (tree?.tree ?? []).slice(0, MAX_TREE_ENTRIES).map((e) => ({ path: e.path, type: e.type, size: e.size ?? 0 }))
}

function mapSecurity(repo: RepoInfo): RepoApiContext['securityAndAnalysis'] {
  const sa = repo.security_and_analysis
  const enabled = (field: unknown) =>
    Boolean(field && typeof field === 'object' && (field as Record<string, unknown>)['status'] === 'enabled')
  return {
    secretScanning: enabled(sa?.['secret_scanning']),
    pushProtection: enabled(sa?.['secret_scanning_push_protection']),
    dependabotSecurityUpdates: enabled(sa?.['dependabot_security_updates']),
  }
}
