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

const command: Command = (args, options) => {
  const result = Bun.spawnSync(args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0)
    throw new Error(`${args.join(' ')}: ${result.stderr.toString().trim().slice(-1000)}`)
  return result.stdout.toString()
}

export async function publishIngest(
  o: VaultSyncOptions & {
    bundle: string
    ref: string
    run: string
    baseSha: string
    sources: string[]
    command?: Command
  },
): Promise<string[]> {
  const exec = o.command ?? command
  const git = (dir: string, args: string[], env: Record<string, string> = {}) =>
    exec(['git', ...args], { cwd: dir, env })
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
  const remoteOwner = o.owner(git(o.dir, ['remote', 'get-url', 'origin']).trim())
  if (!remoteOwner) throw new Error('Cannot determine vault remote owner')
  const env = o.authEnv(await o.token(remoteOwner))
  const worktree = mkdtempSync(join(tmpdir(), 'ns-vault-ingest-'))
  try {
    git(o.dir, ['worktree', 'add', '--quiet', '--detach', worktree, o.baseSha])
    git(worktree, ['cherry-pick', ...commits])
    exec(['bun', 'scripts/lint.ts'], { cwd: worktree, env: {} })
    exec(['obsidian-wiki', 'lint', worktree], { cwd: worktree, env: {} })
    git(worktree, ['pull', '--rebase', 'origin', 'main'], env)
    try {
      git(worktree, ['push', 'origin', 'HEAD:main'], env)
    } catch {
      git(worktree, ['pull', '--rebase', 'origin', 'main'], env)
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
    }
  }
}
