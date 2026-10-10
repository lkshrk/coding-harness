import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

export type VaultPage = { path: string; title: string; content: string }

type Parsed = {
  path: string
  title: string
  category: string
  repo: string[]
  paths: string[]
  lifecycle: string
  body: string
}

const SKIP = new Set(['raw', 'scripts', 'node_modules', '_meta'])
const ROOT_FILES = new Set(['AGENTS.md', 'CLAUDE.md', 'README.md', 'index.md', 'log.md', 'hot.md'])
const EXCLUDED_LIFECYCLES = new Set(['archived', 'disputed'])
const CATEGORY_RANK: Record<string, number> = {
  pitfalls: 0,
  decisions: 1,
  patterns: 2,
  runbooks: 3,
  components: 4,
}
const OTHER_RANK = 5
const PROJECT_RANK = 6

function files(vault: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || SKIP.has(e.name)) continue
      const path = join(dir, e.name)
      if (e.isDirectory()) walk(path)
      else if (e.name.endsWith('.md') && !(dir === vault && ROOT_FILES.has(e.name))) out.push(path)
    }
  }
  walk(vault)
  return out
}

const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

export function parsePage(vault: string, file: string): Parsed | undefined {
  const text = readFileSync(file, 'utf8')
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text)
  if (!m) return undefined
  let fm: Record<string, unknown>
  try {
    const parsed = Bun.YAML.parse(m[1] ?? '')
    if (!parsed || typeof parsed !== 'object') return undefined
    fm = parsed as Record<string, unknown>
  } catch {
    return undefined
  }
  const path = relative(vault, file).split(sep).join('/')
  return {
    path,
    title: typeof fm.title === 'string' ? fm.title.trim() : path,
    category: typeof fm.category === 'string' ? fm.category : '',
    repo: list(fm.repo),
    paths: list(fm.paths),
    lifecycle: typeof fm.lifecycle === 'string' ? fm.lifecycle : 'draft',
    body: (m[2] ?? '').replace(/\n## Sources\n[\s\S]*$/, '').trim(),
  }
}

function fixedPrefix(glob: string): string {
  const i = glob.search(/[*?[{]/)
  return (i < 0 ? glob : glob.slice(0, i)).replace(/\/+$/, '')
}

export function overlaps(pageGlobs: readonly string[], touch: readonly string[]): boolean {
  return pageGlobs.some((g) => {
    const matcher = new Bun.Glob(g)
    const a = fixedPrefix(g)
    return touch.some((t) => {
      if (matcher.match(t)) return true
      const b = fixedPrefix(t)
      return a === '' || b === '' || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
    })
  })
}

export function selectVaultPages(vault: string, repository: string, touch: readonly string[]): VaultPage[] {
  if (!existsSync(vault)) return []
  const ranked = files(vault)
    .map((f) => parsePage(vault, f))
    .filter(
      (p): p is Parsed => p?.repo.includes(repository) === true && !EXCLUDED_LIFECYCLES.has(p.lifecycle),
    )
    .map((p) => {
      const touched = p.paths.length > 0 && touch.length > 0 && overlaps(p.paths, touch)
      const category = p.category === 'project' ? PROJECT_RANK : (CATEGORY_RANK[p.category] ?? OTHER_RANK)
      return { page: p, rank: (touched ? 0 : 10) + category }
    })
    .sort((x, y) => x.rank - y.rank || x.page.path.localeCompare(y.page.path))
  return ranked.map(({ page }) => ({ path: page.path, title: page.title, content: page.body }))
}

export type VaultSyncOptions = {
  dir: string
  token: (owner: string) => Promise<string>
  authEnv: (token: string) => Record<string, string>
  owner: (remoteUrl: string) => string | undefined
  intervalMs?: number
  now?: () => number
  out?: (line: string) => void
}

const SYNC_INTERVAL_MS = 5 * 60_000
const SYNC_SCRIPT = 'scripts/sync.sh'

export function vaultSync(o: VaultSyncOptions): () => Promise<void> {
  let last = Number.NEGATIVE_INFINITY
  return async () => {
    const now = (o.now ?? Date.now)()
    if (!existsSync(join(o.dir, '.git')) || now - last < (o.intervalMs ?? SYNC_INTERVAL_MS)) return
    last = now
    const run = (cmd: string[], env: Record<string, string> = {}) =>
      Bun.spawnSync(cmd, {
        cwd: o.dir,
        env: { ...process.env, ...env },
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
      })
    try {
      const owner = o.owner(run(['git', 'remote', 'get-url', 'origin']).stdout.toString().trim())
      const env = owner ? o.authEnv(await o.token(owner)) : {}
      const script = join(o.dir, SYNC_SCRIPT)
      const res = existsSync(script)
        ? run([script, '--quiet'], env)
        : run(['git', 'pull', '--ff-only', '--quiet'], env)
      const detail = res.stderr.toString().trim().slice(-300)
      if (res.exitCode === 1) o.out?.(`vault: not synced, local changes: ${detail}`)
      else if (res.exitCode === 2) o.out?.(`vault: not synced, rebase conflict: ${detail}`)
      else if (res.exitCode !== 0) o.out?.(`vault: pull failed: ${detail}`)
    } catch (e) {
      o.out?.(`vault: pull failed: ${(e as Error).message}`)
    }
  }
}
