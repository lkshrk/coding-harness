import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import type { DockerCli } from '../worker/docker'

export const INDEX_MOUNT = '/mnt/index'
export const CODE_GRAPH_BIN = 'codebase-memory-mcp'
const INDEX_TIMEOUT_MS = 15 * 60_000

export type CodeGraphIndexOptions = {
  root: string
  docker: DockerCli
  image: (repository: string) => Promise<string>
  user?: string
}

export function indexDb(repository: string): string {
  return `${repository}.db`
}

export class CodeGraphIndex {
  private readonly building = new Map<string, Promise<string>>()

  constructor(private readonly o: CodeGraphIndexOptions) {}

  dir(repository: string, sha: string): string {
    return join(this.o.root, repository, sha)
  }

  current(repository: string): string | undefined {
    try {
      return readlinkSync(join(this.o.root, repository, 'current'))
    } catch {
      return undefined
    }
  }

  ensure(repository: string, checkout: string, sha: string): Promise<string> {
    const key = `${repository}@${sha}`
    const pending = this.building.get(key)
    if (pending) return pending
    const build = this.build(repository, checkout, sha).finally(() => this.building.delete(key))
    this.building.set(key, build)
    return build
  }

  prune(repository: string, keep: Iterable<string>): string[] {
    const base = join(this.o.root, repository)
    if (!existsSync(base)) return []
    const kept = new Set(keep)
    const current = this.current(repository)
    if (current) kept.add(current)
    const removed: string[] = []
    for (const e of readdirSync(base, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.') || kept.has(e.name)) continue
      rmSync(join(base, e.name), { recursive: true, force: true })
      removed.push(e.name)
    }
    return removed
  }

  private async build(repository: string, checkout: string, sha: string): Promise<string> {
    const dir = this.dir(repository, sha)
    if (existsSync(join(dir, indexDb(repository)))) return dir
    const base = join(this.o.root, repository)
    mkdirSync(base, { recursive: true })
    const tmp = mkdtempSync(join(base, `.build-${sha.slice(0, 12)}-`))
    try {
      const src = join(tmp, 'src')
      const idx = join(tmp, 'idx')
      mkdirSync(src)
      mkdirSync(idx)
      const exported = Bun.spawnSync(
        ['sh', '-c', 'git -C "$1" archive "$2" | tar -x -C "$3"', 'sh', checkout, sha, src],
        {
          stdout: 'pipe',
          stderr: 'pipe',
          stdin: 'ignore',
        },
      )
      if (exported.exitCode !== 0) {
        throw new Error(
          `git archive ${sha.slice(0, 12)} for ${repository}: ${exported.stderr.toString().trim()}`,
        )
      }
      const res = await this.o.docker.run(
        [
          'run',
          '--rm',
          '--network',
          'none',
          ...(this.o.user ? ['--user', this.o.user] : []),
          '-v',
          `${src}:/work/${repository}:ro`,
          '-v',
          `${idx}:/idx`,
          '-e',
          'CBM_CACHE_DIR=/idx',
          '-e',
          'HOME=/tmp',
          '--entrypoint',
          CODE_GRAPH_BIN,
          await this.o.image(repository),
          'cli',
          '--quiet',
          'index_repository',
          '--repo-path',
          `/work/${repository}`,
          '--name',
          repository,
          '--mode',
          'fast',
        ],
        { timeoutMs: INDEX_TIMEOUT_MS },
      )
      if (res.exitCode !== 0 || !existsSync(join(idx, indexDb(repository)))) {
        const detail = (res.stderr.trim() || res.stdout.trim()).slice(-300)
        throw new Error(`code graph index for ${repository}@${sha.slice(0, 12)} failed: ${detail}`)
      }
      rmSync(join(idx, 'logs'), { recursive: true, force: true })
      chmodSync(idx, 0o755)
      for (const f of readdirSync(idx)) chmodSync(join(idx, f), 0o644)
      if (!existsSync(dir)) renameSync(idx, dir)
      this.point(repository, sha)
      return dir
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }

  private point(repository: string, sha: string): void {
    const link = join(this.o.root, repository, 'current')
    const next = `${link}.next`
    rmSync(next, { force: true })
    symlinkSync(sha, next)
    renameSync(next, link)
  }
}
