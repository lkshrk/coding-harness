import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { importBundle } from '../../adapters/git/host'
import type { IssueSnapshot } from '../../ports'
import type { Event } from '../../state/events'
import type { PullRequestRecord } from '../integration/records'
import type { VaultSyncOptions } from './vault'

export function writeIngestSources(o: {
  dir: string
  date: string
  issue: IssueSnapshot
  repository: string
  pr?: PullRequestRecord | null
  events: Event[]
  reuse?: boolean
}): string[] {
  const { identifier, title, description, status, labels } = o.issue
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.date) || !/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(identifier)) {
    throw new Error('Invalid ingest source identifier or date')
  }
  const events = o.events.filter((e) => e.issue === identifier || e.issue === undefined)
  const contents: [string, string][] = [
    [
      'linear',
      `# ${identifier}: ${title}\n\nRepository: ${o.repository}\nState: ${status}\nLabels: ${labels.join(', ')}\n\n${description.trim()}\n`,
    ],
  ]
  const created = events.findLast((e) => e.type === 'PR_CREATED')?.data
  const merged = events.findLast((e) => e.type === 'MERGED')?.data
  if (o.pr || created || merged) {
    const pr = o.pr
    contents.push([
      'prs',
      `# ${identifier}: pull request\n\nURL: ${pr?.url ?? created?.url ?? merged?.url ?? 'unavailable'}\nTitle: ${pr?.title ?? created?.title ?? 'unavailable'}\nMerged SHA: ${pr?.mergeSha ?? merged?.mergeSha ?? 'unavailable'}\n\n${pr?.body ?? created?.body ?? 'Body unavailable.'}\n`,
    ])
  }
  for (const [category, selected] of [
    [
      'reviews',
      events.filter(
        (e) => e.type === 'REVIEW_RECEIVED' && Array.isArray(e.data.findings) && e.data.findings.length > 0,
      ),
    ],
    [
      'failures',
      events.filter(
        (e) => e.type === 'FAILURE_CLASSIFIED' || e.type === 'WORKER_FAILED' || e.type === 'WORKER_NO_FINISH',
      ),
    ],
  ] as const) {
    if (selected.length)
      contents.push([
        category,
        `# ${identifier}\n\n${selected.map((e) => JSON.stringify(e, null, 2)).join('\n\n')}\n`,
      ])
  }
  return contents.map(([category, content]) => {
    const path = `raw/${category}/${o.date}-${identifier}.md`
    const full = join(o.dir, path)
    mkdirSync(dirname(full), { recursive: true })
    if (o.reuse && existsSync(full)) return path
    try {
      writeFileSync(full, content, { flag: 'wx' })
    } catch (error) {
      if (!existsSync(full) || readFileSync(full, 'utf8') !== content) {
        throw new Error(`Cannot write immutable source ${path}`, { cause: error })
      }
    }
    return path
  })
}

type Command = (args: string[], options: { cwd: string; env: Record<string, string> }) => string

// The host may have no git identity; cherry-pick and rebase need a committer.
const IDENTITY = {
  GIT_COMMITTER_NAME: 'nightshift',
  GIT_COMMITTER_EMAIL: 'nightshift@localhost',
}

const command: Command = (args, options) => {
  const result = Bun.spawnSync(args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    const stdout = result.stdout.toString()
    const errors = stdout.split('\n').filter((line) => /^error\b/i.test(line))
    const output = result.stderr.toString().trim() || (errors.length ? errors.join('\n') : stdout.trim())
    throw new Error(`${args.join(' ')}: ${output.slice(-1000)}`)
  }
  return result.stdout.toString()
}

export async function publishIngest(
  o: VaultSyncOptions & {
    bundle: string
    ref: string
    run: string
    baseSha: string
    sources: string[]
    repos?: (name: string) => { gitDir: string; ref: string } | undefined
    command?: Command
  },
): Promise<string[]> {
  const exec = o.command ?? command
  const git = (dir: string, args: string[], env: Record<string, string> = {}) =>
    exec(['git', ...args], { cwd: dir, env: { ...IDENTITY, ...env } })
  const head = importBundle(o.dir, o.bundle, o.ref, o.run)
  git(o.dir, ['merge-base', '--is-ancestor', o.baseSha, head])
  const commits = git(o.dir, ['rev-list', '--reverse', `${o.baseSha}..${head}`])
    .trim()
    .split('\n')
    .filter(Boolean)
  if (
    !o.sources.length ||
    commits.length !== o.sources.length ||
    new Set(o.sources).size !== o.sources.length
  ) {
    throw new Error('Ingest requires one commit per source')
  }
  const remaining = new Set(o.sources)
  const originals = new Map<string, string>()
  for (const commit of commits) {
    const message = git(o.dir, ['show', '-s', '--format=%B', commit]).trim()
    const source = message.replace(/^ingest: /, '')
    if (
      message !== `ingest: ${source}` ||
      !remaining.delete(source) ||
      !/^raw\/(linear|prs|reviews|failures)\/\d{4}-\d{2}-\d{2}-[A-Za-z][A-Za-z0-9]*-\d+\.md$/.test(source)
    ) {
      throw new Error('Invalid ingest commit source or message')
    }
    const changed = git(o.dir, ['diff-tree', '--no-commit-id', '--name-status', '-r', commit])
      .trim()
      .split('\n')
    if (
      !changed.includes(`A\t${source}`) ||
      changed.some((line) => {
        const path = line.slice(line.indexOf('\t') + 1)
        return (
          (path.startsWith('raw/') && line !== `A\t${source}`) ||
          /^(index\.md|log\.md|hot\.md|_meta\/)/.test(path)
        )
      })
    )
      throw new Error('Ingest commit changes immutable or generated files')
    const original = readFileSync(join(o.dir, source), 'utf8')
    if (git(o.dir, ['show', `${head}:${source}`]) !== original)
      throw new Error(`Ingest modified raw source ${source}`)
    originals.set(source, original)
  }
  const project = [...originals.values()].map((text) => /^Repository: (\S+)$/m.exec(text)?.[1]).find(Boolean)
  if (!project) throw new Error('Ingest sources name no repository')
  const remoteOwner = o.owner(git(o.dir, ['remote', 'get-url', 'origin']).trim())
  if (!remoteOwner) throw new Error('Cannot determine vault remote owner')
  const env = o.authEnv(await o.token(remoteOwner))
  const worktree = mkdtempSync(join(tmpdir(), 'ns-vault-ingest-'))
  const repos = mkdtempSync(join(tmpdir(), 'ns-knowledge-repos-'))
  const picks = [...originals.keys()]
  const known = o.repos?.(project)
  const lintEnv: Record<string, string> = {}
  // Generated files conflict on every rebase, so each attempt rebuilds them on the fresh remote head.
  const build = () => {
    git(o.dir, ['fetch', '--quiet', 'origin', 'main'], env)
    git(worktree, ['checkout', '--quiet', '--detach', 'refs/remotes/origin/main'])
    for (const [i, commit] of commits.entries()) {
      git(worktree, ['cherry-pick', commit])
      exec(
        [
          'obsidian-wiki',
          'memory',
          'sync',
          'INGEST',
          `source=${picks[i]}`,
          `project=${project}`,
          '--vault',
          worktree,
        ],
        { cwd: worktree, env: {} },
      )
      git(worktree, ['add', '--all'])
      git(worktree, ['commit', '--quiet', '--amend', '--no-edit'])
    }
    exec(['bun', 'scripts/lint.ts'], { cwd: worktree, env: lintEnv })
    exec(['obsidian-wiki', 'lint', worktree], { cwd: worktree, env: {} })
  }
  try {
    git(o.dir, ['worktree', 'add', '--quiet', '--detach', worktree, o.baseSha])
    if (known) {
      const pinned = join(repos, project, '.git')
      git(worktree, ['clone', '--quiet', '--bare', '--shared', known.gitDir, pinned])
      const sha = git(known.gitDir, ['rev-parse', '--verify', `${known.ref}^{commit}`]).trim()
      git(worktree, ['--git-dir', pinned, 'update-ref', '--no-deref', 'HEAD', sha])
      lintEnv.KNOWLEDGE_REPOS = repos
    }
    build()
    try {
      git(worktree, ['push', 'origin', 'HEAD:main'], env)
    } catch {
      build()
      git(worktree, ['push', 'origin', 'HEAD:main'], env)
    }
    const pushed = git(worktree, ['rev-list', '--reverse', `HEAD~${commits.length}..HEAD`])
      .trim()
      .split('\n')
    for (const [source, original] of originals) {
      const full = join(o.dir, source)
      if (
        !git(o.dir, ['ls-files', '--', source]).trim() &&
        existsSync(full) &&
        readFileSync(full, 'utf8') === original
      )
        rmSync(full)
    }
    return pushed
  } finally {
    try {
      git(o.dir, ['worktree', 'remove', '--force', worktree])
    } finally {
      rmSync(worktree, { recursive: true, force: true })
      rmSync(repos, { recursive: true, force: true })
    }
  }
}
