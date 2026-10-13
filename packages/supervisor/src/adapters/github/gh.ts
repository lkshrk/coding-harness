import { homedir } from 'node:os'
import { type Config, expandHome, githubAccount } from '@nightshift/core'
import { BRANCH_PREFIX } from '../../policy/naming'
import type { CiFailure, CiState, GitHost, PullRequest, PullRequestState, ReviewThread } from '../../ports'
import { PermissionDeniedError, PushRejectedError } from '../../ports/git-host'
import { ACTIONS_URL, bucketOf, type GhRollupItem, logExcerpt, MAX_CI_LOG, MAX_JOB_LOG } from './ci-log'
import { type GitHubTokens, GitHubUnauthorizedError, gitAuthEnv } from './github-tokens'

export * from './ci-log'

export type HostCommandResult = { exitCode: number; stdout: string; stderr: string }

export type HostCommandRunner = (
  cmd: string[],
  o: { cwd?: string; env: Record<string, string>; stdin?: string },
) => Promise<HostCommandResult>

export type GhGitHostOptions = {
  config: () => Config
  tokens: Pick<GitHubTokens, 'withToken'>
  run?: HostCommandRunner
  remoteUrl?: (checkout: string, remote: string) => Promise<string>
  pushUrl?: (repository: string, slug: string) => string
  home?: string
}

const UNAUTHORIZED =
  /HTTP 401|Bad credentials|Authentication failed|could not read Username|invalid credentials/i

const PERMISSION_DENIED = /without [`'"]?\w+[`'"]? permission|Permission to \S+ denied|error: 403|HTTP 403/i

const SLUG =
  /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/|[^@/]+@github\.com:)([^/]+\/[^/]+?)(?:\.git)?\/?$/

export function githubSlug(remoteUrl: string): string | undefined {
  return SLUG.exec(remoteUrl.trim())?.[1]
}

export const spawnCommand: HostCommandRunner = async (cmd, o) => {
  const proc = Bun.spawn(cmd, {
    ...(o.cwd ? { cwd: o.cwd } : {}),
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', ...o.env },
    stdin: o.stdin === undefined ? 'ignore' : new Blob([o.stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

async function gitRemote(checkout: string, remote: string): Promise<string> {
  const r = await spawnCommand(['git', '-C', checkout, 'remote', 'get-url', remote], { env: {} })
  if (r.exitCode !== 0) throw new Error(`git remote get-url ${remote}: ${r.stderr.trim()}`)
  return r.stdout.trim()
}

export { BRANCH_PREFIX }

// A thread's root comment is the reply target and its newest drives the watermark; middle comments past one page are skipped.
export const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          root: comments(first: 1) { nodes { databaseId author { login } body } }
          comments(last: 100) { nodes { databaseId author { login } body } }
        }
      }
    }
  }
}`

type GhComment = { databaseId: number; author?: { login: string } | null; body: string }

export const RESOLVE_MUTATION = `mutation($id: ID!) {
  resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } }
}`

export type GhThreadsResponse = {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: {
          pageInfo?: { hasNextPage: boolean; endCursor?: string | null }
          nodes?: {
            id: string
            isResolved: boolean
            isOutdated: boolean
            path: string
            line?: number | null
            root?: { nodes?: GhComment[] }
            comments?: { nodes?: GhComment[] }
          }[]
        }
      }
    }
  }
}

export class GhGitHost implements GitHost {
  private readonly run: HostCommandRunner
  private readonly remoteUrl: (checkout: string, remote: string) => Promise<string>
  private readonly pushUrl: (repository: string, slug: string) => string
  private readonly home: string

  constructor(private readonly o: GhGitHostOptions) {
    this.run = o.run ?? spawnCommand
    this.remoteUrl = o.remoteUrl ?? gitRemote
    this.pushUrl = o.pushUrl ?? ((_, slug) => `https://github.com/${slug}.git`)
    this.home = o.home ?? homedir()
  }

  accountFor(repository: string): string {
    return githubAccount(this.o.config(), repository).name
  }

  async push(o: {
    repository: string
    source: string
    branch: string
    expected?: string
  }): Promise<{ headSha: string }> {
    const repo = this.repo(o.repository)
    if (!o.branch.startsWith(BRANCH_PREFIX) || o.branch === repo.base)
      throw new Error(
        `refusing to push ${o.branch}: nightshift pushes only its own ${BRANCH_PREFIX} branches`,
      )
    const checkout = expandHome(repo.path, this.home)
    const rev = await this.run(['git', '-C', checkout, 'rev-parse', '--verify', `${o.source}^{commit}`], {
      env: {},
    })
    if (rev.exitCode !== 0) throw new Error(`git rev-parse ${o.source}: ${rev.stderr.trim()}`)
    const headSha = rev.stdout.trim()
    const target = this.pushUrl(o.repository, await this.slug(o.repository))
    const ref = `refs/heads/${o.branch}`
    await this.o.tokens.withToken(o.repository, async (token) => {
      const env = gitAuthEnv(token)
      const remoteHead = async (): Promise<string> => {
        const ls = await this.run(['git', '-C', checkout, 'ls-remote', target, ref], { env })
        this.check(ls, `git ls-remote ${o.branch}`)
        return ls.stdout.trim().split(/\s+/)[0] ?? ''
      }
      // git skips the lease when the remote already holds the pushed commit, so compare first.
      if (o.expected) {
        const actual = await remoteHead()
        if (actual !== o.expected) throw new PushRejectedError(o.branch, o.expected, actual)
      }
      const r = await this.run(
        [
          'git',
          '-C',
          checkout,
          'push',
          '--no-verify',
          ...(o.expected
            ? ['--porcelain', `--force-with-lease=${ref}:${o.expected}`, target, `${headSha}:${ref}`]
            : ['--quiet', target, `+${headSha}:${ref}`]),
        ],
        { env },
      )
      if (r.exitCode !== 0 && o.expected) {
        const actual = await remoteHead().catch(() => undefined)
        if (actual !== undefined && actual !== o.expected)
          throw new PushRejectedError(o.branch, o.expected, actual)
      }
      this.check(r, `git push ${o.branch}`, PERMISSION_DENIED)
      // The branch can move to headSha between the check above and the push; git then reports
      // it up to date ('=') without checking the lease, so confirm this push moved it.
      if (o.expected && o.expected !== headSha) {
        const upToDate = r.stdout.split('\n').some((l) => l.startsWith('=\t') && l.includes(`:${ref}\t`))
        const actual = await remoteHead()
        if (actual !== headSha || upToDate) throw new PushRejectedError(o.branch, o.expected, actual)
      }
    })
    return { headSha }
  }

  async openPullRequest(o: {
    repository: string
    branch: string
    base: string
    title: string
    body: string
    draft: boolean
  }): Promise<PullRequest> {
    const slug = await this.slug(o.repository)
    const account = this.accountFor(o.repository)
    return this.o.tokens.withToken(o.repository, async (token) => {
      const env = gitAuthEnv(token)
      const listed = await this.run(
        [
          'gh',
          'pr',
          'list',
          '--repo',
          slug,
          '--head',
          o.branch,
          '--state',
          'open',
          '--json',
          'number,url',
          '--limit',
          '1',
        ],
        { env },
      )
      this.check(listed, 'gh pr list')
      const open = (JSON.parse(listed.stdout || '[]') as { number: number; url: string }[])[0]
      const pr = (number: number, url: string): PullRequest => ({
        url,
        number,
        repository: o.repository,
        repo: slug,
        branch: o.branch,
        base: o.base,
        account,
      })
      if (open) {
        // Older gh pr edit queries classic Projects, which GitHub now rejects.
        const edited = await this.run(
          ['gh', 'api', '-X', 'PATCH', `repos/${slug}/pulls/${open.number}`, '--input', '-'],
          { env, stdin: JSON.stringify({ title: o.title, body: o.body }) },
        )
        this.check(edited, 'gh api PATCH pull')
        return pr(open.number, open.url)
      }
      const created = await this.run(
        [
          'gh',
          'pr',
          'create',
          '--repo',
          slug,
          '--head',
          o.branch,
          '--base',
          o.base,
          '--title',
          o.title,
          '--body-file',
          '-',
          ...(o.draft ? ['--draft'] : []),
        ],
        { env, stdin: o.body },
      )
      this.check(created, 'gh pr create')
      const url = created.stdout.trim().split('\n').at(-1) ?? ''
      const number = Number(/\/pull\/(\d+)/.exec(url)?.[1])
      if (!Number.isInteger(number)) throw new Error(`gh pr create: no pull request URL in '${url}'`)
      return pr(number, url)
    })
  }

  async ci(pr: PullRequest): Promise<CiState> {
    return this.o.tokens.withToken(pr.repository, async (token) => {
      // `gh pr checks --json` needs gh >= 2.48; the rollup works on older distro packages.
      const r = await this.run(
        ['gh', 'pr', 'view', String(pr.number), '--repo', pr.repo, '--json', 'statusCheckRollup'],
        { env: gitAuthEnv(token) },
      )
      this.check(r, 'gh pr view')
      const { statusCheckRollup = [] } = JSON.parse(r.stdout) as { statusCheckRollup?: GhRollupItem[] }
      const checks = statusCheckRollup.map((c) => ({
        name: c.name ?? c.context ?? '?',
        url: c.detailsUrl || c.targetUrl || '',
        bucket: bucketOf(c),
      }))
      const failed = checks.filter((c) => c.bucket === 'fail' || c.bucket === 'cancel')
      const failedChecks = failed.map((c) => c.name)
      // GitHub runs no checks on a conflicting PR, so an empty rollup is not a pass.
      const state = failedChecks.length
        ? 'failed'
        : checks.length === 0 || checks.some((c) => c.bucket === 'pending')
          ? 'pending'
          : 'passed'
      const failures: CiFailure[] = []
      let budget = MAX_CI_LOG
      for (const c of failed) {
        const log = budget > 0 ? await this.failedLog(pr, c, gitAuthEnv(token)) : ''
        const excerpt = logExcerpt(log, Math.min(MAX_JOB_LOG, budget))
        budget -= excerpt.length
        failures.push({ name: c.name, url: c.url || pr.url, log: excerpt })
      }
      return { state, failedChecks, failures, url: pr.url }
    })
  }

  async baseCi(pr: PullRequest): Promise<CiState | null> {
    return this.o.tokens.withToken(pr.repository, async (token) => {
      const env = gitAuthEnv(token)
      const view = await this.run(
        ['gh', 'pr', 'view', String(pr.number), '--repo', pr.repo, '--json', 'baseRefOid'],
        { env },
      )
      this.check(view, 'gh pr view')
      const sha = (JSON.parse(view.stdout) as { baseRefOid?: string }).baseRefOid
      if (!sha) return null
      const r = await this.run(['gh', 'api', `repos/${pr.repo}/commits/${sha}/check-runs?per_page=100`], {
        env,
      })
      this.check(r, 'gh api check-runs')
      const { check_runs = [] } = JSON.parse(r.stdout) as {
        check_runs?: {
          name: string
          status?: string
          conclusion?: string | null
          details_url?: string | null
        }[]
      }
      // External CI providers report commit statuses, which the check-runs endpoint omits.
      const s = await this.run(['gh', 'api', `repos/${pr.repo}/commits/${sha}/status`], { env })
      this.check(s, 'gh api status')
      const { statuses = [] } = JSON.parse(s.stdout) as {
        statuses?: { context: string; state?: string; target_url?: string | null }[]
      }
      const checks = [
        ...check_runs.map((c) => ({
          name: c.name,
          url: c.details_url || '',
          bucket: bucketOf({
            status: (c.status ?? '').toUpperCase(),
            conclusion: (c.conclusion ?? '').toUpperCase(),
          }),
        })),
        ...statuses.map((c) => ({
          name: c.context,
          url: c.target_url || '',
          bucket: bucketOf({ state: (c.state ?? '').toUpperCase() }),
        })),
      ]
      const completed = checks.filter((c) => c.bucket !== 'pending')
      if (!completed.length) return null
      const failed = completed.filter((c) => c.bucket === 'fail' || c.bucket === 'cancel')
      return {
        state: failed.length ? 'failed' : completed.length < checks.length ? 'pending' : 'passed',
        failedChecks: failed.map((c) => c.name),
        failures: failed.map((c) => ({ name: c.name, url: c.url, log: '' })),
        url: `https://github.com/${pr.repo}/commit/${sha}`,
        sha,
      }
    })
  }

  private async failedLog(
    pr: PullRequest,
    c: { name: string; url: string },
    env: Record<string, string>,
  ): Promise<string> {
    const ids = ACTIONS_URL.exec(c.url)
    if (!ids?.[1]) {
      console.error(
        `ci ${pr.url}: no log for check ${c.name}: not a GitHub Actions run (${c.url || 'no url'})`,
      )
      return ''
    }
    const target = ids[2] ? ['--job', ids[2]] : [ids[1]]
    const r = await this.run(['gh', 'run', 'view', ...target, '--repo', pr.repo, '--log-failed'], { env })
    if (r.exitCode !== 0) {
      const why = r.stderr.trim().split('\n').slice(-3).join(' ') || `exit ${r.exitCode}`
      console.error(`ci ${pr.url}: no log for check ${c.name}: gh run view --log-failed: ${why}`)
      return ''
    }
    return r.stdout
  }

  async state(pr: PullRequest): Promise<PullRequestState> {
    return this.o.tokens.withToken(pr.repository, async (token) => {
      const r = await this.run(
        [
          'gh',
          'pr',
          'view',
          String(pr.number),
          '--repo',
          pr.repo,
          '--json',
          'state,mergedAt,mergeCommit,headRefOid,mergeable',
        ],
        { env: gitAuthEnv(token) },
      )
      this.check(r, 'gh pr view')
      const v = JSON.parse(r.stdout) as {
        state: string
        mergeCommit?: { oid?: string } | null
        headRefOid?: string
        mergeable?: string
      }
      if (v.state === 'MERGED')
        return { state: 'merged', ...(v.mergeCommit?.oid ? { mergeSha: v.mergeCommit.oid } : {}) }
      return {
        state: v.state === 'CLOSED' ? 'closed' : 'open',
        mergeable:
          v.mergeable === 'MERGEABLE'
            ? 'mergeable'
            : v.mergeable === 'CONFLICTING'
              ? 'conflicting'
              : 'unknown',
        ...(v.headRefOid ? { headSha: v.headRefOid } : {}),
      }
    })
  }

  async updateBranch(pr: PullRequest): Promise<{ headSha: string }> {
    if (!pr.branch.startsWith(BRANCH_PREFIX))
      throw new Error(
        `refusing to rebase ${pr.branch}: nightshift rebases only its own ${BRANCH_PREFIX} branches`,
      )
    await this.o.tokens.withToken(pr.repository, async (token) => {
      const r = await this.run(
        ['gh', 'pr', 'update-branch', String(pr.number), '--repo', pr.repo, '--rebase'],
        { env: gitAuthEnv(token) },
      )
      this.check(r, 'gh pr update-branch')
    })
    const after = await this.state(pr)
    if (!after.headSha) throw new Error(`${pr.url} has no head after update-branch`)
    return { headSha: after.headSha }
  }

  async merge(pr: PullRequest, method: 'squash' | 'merge' | 'rebase'): Promise<{ sha: string }> {
    await this.o.tokens.withToken(pr.repository, async (token) => {
      const r = await this.run(['gh', 'pr', 'merge', String(pr.number), '--repo', pr.repo, `--${method}`], {
        env: gitAuthEnv(token),
      })
      this.check(r, 'gh pr merge')
    })
    const merged = await this.state(pr)
    if (merged.state !== 'merged' || !merged.mergeSha) throw new Error(`${pr.url} is not merged`)
    return { sha: merged.mergeSha }
  }

  async reviewThreads(pr: PullRequest): Promise<ReviewThread[]> {
    const [owner, name] = pr.repo.split('/')
    return this.o.tokens.withToken(pr.repository, async (token) => {
      const threads: ReviewThread[] = []
      let after: string | undefined
      do {
        const r = await this.run(
          [
            'gh',
            'api',
            'graphql',
            '-f',
            `query=${THREADS_QUERY}`,
            '-f',
            `owner=${owner}`,
            '-f',
            `name=${name}`,
            '-F',
            `number=${pr.number}`,
            ...(after === undefined ? [] : ['-f', `after=${after}`]),
          ],
          { env: gitAuthEnv(token) },
        )
        this.check(r, 'gh api graphql reviewThreads')
        const page = (JSON.parse(r.stdout) as GhThreadsResponse).data?.repository?.pullRequest?.reviewThreads
        for (const t of page?.nodes ?? []) {
          const tail = t.comments?.nodes ?? []
          const root = t.root?.nodes?.[0]
          const comments =
            root && !tail.some((c) => c.databaseId === root.databaseId) ? [root, ...tail] : tail
          threads.push({
            id: t.id,
            resolved: t.isResolved,
            outdated: t.isOutdated,
            path: t.path,
            line: t.line ?? null,
            comments: comments.map((c) => ({
              id: c.databaseId,
              author: c.author?.login ?? '',
              body: c.body,
            })),
          })
        }
        after = page?.pageInfo?.hasNextPage ? (page.pageInfo.endCursor ?? undefined) : undefined
      } while (after !== undefined)
      return threads
    })
  }

  async replyToThread(pr: PullRequest, commentId: number, body: string): Promise<{ id: number }> {
    return this.o.tokens.withToken(pr.repository, async (token) => {
      const r = await this.run(
        [
          'gh',
          'api',
          '-X',
          'POST',
          `repos/${pr.repo}/pulls/${pr.number}/comments/${commentId}/replies`,
          '--input',
          '-',
        ],
        { env: gitAuthEnv(token), stdin: JSON.stringify({ body }) },
      )
      this.check(r, 'gh api reply')
      return { id: (JSON.parse(r.stdout) as { id: number }).id }
    })
  }

  async resolveThread(pr: PullRequest, threadId: string): Promise<void> {
    await this.o.tokens.withToken(pr.repository, async (token) => {
      const r = await this.run(
        ['gh', 'api', 'graphql', '-f', `query=${RESOLVE_MUTATION}`, '-f', `id=${threadId}`],
        { env: gitAuthEnv(token) },
      )
      this.check(r, 'gh api graphql resolveReviewThread')
    })
  }

  private repo(repository: string) {
    const repo = this.o.config().repositories[repository]
    if (!repo) throw new Error(`no repository '${repository}'`)
    return repo
  }

  private async slug(repository: string): Promise<string> {
    const repo = this.repo(repository)
    const url = await this.remoteUrl(expandHome(repo.path, this.home), repo.remote)
    const slug = githubSlug(url)
    if (!slug) throw new Error(`repositories.${repository}: remote ${repo.remote} is not on github.com`)
    return slug
  }

  private check(r: HostCommandResult, what: string, denied?: RegExp): void {
    if (r.exitCode === 0) return
    const detail = r.stderr.trim().split('\n').slice(-3).join(' ')
    if (UNAUTHORIZED.test(r.stderr)) throw new GitHubUnauthorizedError(`${what}: ${detail}`)
    const refusal =
      denied &&
      r.stderr
        .split('\n')
        .find((l) => denied.test(l))
        ?.trim()
    if (refusal)
      throw new PermissionDeniedError(what, `${what}: ${detail.includes(refusal) ? detail : refusal}`)
    throw new Error(`${what} exited ${r.exitCode}: ${detail}`)
  }
}
