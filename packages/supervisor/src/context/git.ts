import type { ContextRepository } from '../interfaces'
import type { RepoSource } from './builder'

async function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: Uint8Array; err: string }> {
  const p = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).bytes(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  return { ok: code === 0, out, err: err.trim() }
}

export function gitObjectSource(repo: ContextRepository): RepoSource {
  const base = repo.base || 'HEAD'
  return {
    async paths() {
      const r = await git(repo.checkoutPath, ['ls-tree', '-r', '-z', '--name-only', base])
      if (!r.ok) throw new Error(`git ls-tree ${base} in ${repo.checkoutPath}: ${r.err}`)
      return new TextDecoder()
        .decode(r.out)
        .split('\0')
        .filter((p) => p !== '')
        .sort()
    },
    async read(path) {
      const r = await git(repo.checkoutPath, ['cat-file', 'blob', `${base}:${path}`])
      return r.ok ? r.out : undefined
    },
  }
}
