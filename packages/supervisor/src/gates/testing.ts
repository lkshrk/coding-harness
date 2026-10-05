import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function git(cwd: string, ...args: string[]): string {
  const config = ['user.email=t@t', 'user.name=t', 'commit.gpgsign=false', 'core.hooksPath=/dev/null']
  const r = Bun.spawnSync(['git', ...config.flatMap((c) => ['-c', c]), ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}

function write(dir: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
}

export type GitFixture = {
  checkout: string
  worker: string
  base: string
  branch: string
  bundle(name?: string): { bundle: string; headSha: string }
  hostState(): string
}

export function gitFixture(root: string, branch = 'ns/FOR-1-1'): GitFixture {
  const checkout = join(root, 'checkout')
  mkdirSync(checkout, { recursive: true })
  git(checkout, 'init', '-q', '-b', 'main')
  write(checkout, {
    Makefile: 'test:\n\texit 1\n',
    'src/a.ts': 'export const a = 1\n',
    'src/a.test.ts': 'expect(a).toBe(1)\n',
  })
  git(checkout, 'add', '-A')
  git(checkout, 'commit', '-q', '-m', 'base')
  const base = git(checkout, 'rev-parse', 'HEAD')
  writeFileSync(join(checkout, 'scratch.txt'), 'uncommitted work\n')

  const worker = join(root, 'worker')
  git(root, 'clone', '-q', checkout, worker)
  git(worker, 'checkout', '-q', '-b', branch)
  write(worker, {
    Makefile: 'test:\n\ttrue\n',
    'src/a.test.ts': 'expect(a).toBeDefined()\n',
    'src/b.ts': 'export const b = 2\n',
  })
  git(worker, 'add', '-A')
  git(worker, 'commit', '-q', '-m', 'work')

  return {
    checkout,
    worker,
    base,
    branch,
    bundle(name = 'run') {
      const dir = join(root, 'outbox', name)
      mkdirSync(dir, { recursive: true })
      const bundle = join(dir, `${name}.bundle`)
      git(worker, 'bundle', 'create', '-q', bundle, branch)
      return { bundle, headSha: git(worker, 'rev-parse', branch) }
    },
    hostState() {
      return [
        git(checkout, 'rev-parse', 'HEAD'),
        git(checkout, 'symbolic-ref', 'HEAD'),
        git(checkout, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'),
        git(checkout, 'status', '--porcelain'),
      ].join('\n')
    },
  }
}
