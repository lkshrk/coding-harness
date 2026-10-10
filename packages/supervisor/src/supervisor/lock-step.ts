import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runRef } from '../policy/naming'
import { LockFailedError, type LockOutcome, type LockStep } from '../ports/lock'

export type MiseLock = (
  dir: string,
  env: Record<string, string>,
) => Promise<{ exitCode: number; output: string }>

const MISE_TOML = /^features\/([^/]+)\/mise\.toml$/
const OUTPUT_TAIL = 4000
const LOCK_TIMEOUT_MS = 10 * 60_000

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} in ${cwd}: ${r.stderr.toString().trim()}`)
  return r.stdout.toString()
}

export function changedFeatures(checkout: string, base: string, headSha: string): string[] {
  return git(
    checkout,
    'diff',
    '--no-renames',
    '--diff-filter=AM',
    '--name-only',
    base,
    headSha,
    '--',
    'features',
  )
    .split('\n')
    .flatMap((p) => MISE_TOML.exec(p)?.[1] ?? [])
}

// Regenerates mise.lock on the host for each Feature whose mise.toml the run changed; the token stays here.
export function lockStep(d: { token: (repository: string) => Promise<string>; mise: MiseLock }): LockStep {
  return async (checkout, run, headSha) => {
    const features = changedFeatures(checkout, run.baseSha || `${headSha}^`, headSha)
    if (features.length === 0) return { headSha, locks: [] }
    const token = await d.token(run.repository)
    const hide = (text: string) => text.split(token).join('***')
    const tree = join(mkdtempSync(join(tmpdir(), 'ns-lock-')), 'tree')
    git(checkout, 'worktree', 'add', '--quiet', '--detach', tree, headSha)
    try {
      const locks: LockOutcome['locks'] = []
      for (const feature of features) {
        const dir = `features/${feature}`
        const r = await d.mise(join(tree, dir), { GITHUB_TOKEN: token }).catch((e: Error) => {
          throw new LockFailedError(`mise lock in ${dir}: ${hide(e.message)}`)
        })
        if (r.exitCode !== 0)
          throw new LockFailedError(
            `mise lock in ${dir} exited ${r.exitCode}: ${hide(r.output.trim()).slice(-OUTPUT_TAIL)}`,
          )
        const changed = git(tree, 'status', '--porcelain', '--', `${dir}/mise.lock`).trim() !== ''
        if (changed) {
          git(tree, 'add', '--', `${dir}/mise.lock`)
          git(
            tree,
            '-c',
            'user.name=nightshift',
            '-c',
            'user.email=nightshift@localhost',
            '-c',
            'commit.gpgsign=false',
            'commit',
            '--quiet',
            '--no-verify',
            '-m',
            `chore(${feature}): regenerate mise.lock`,
          )
        }
        locks.push({ feature, changed })
      }
      const head = git(tree, 'rev-parse', 'HEAD').trim()
      if (head !== headSha) git(checkout, 'update-ref', runRef(run.id), head, headSha)
      return { headSha: head, locks }
    } finally {
      git(checkout, 'worktree', 'remove', '--force', tree)
      rmSync(join(tree, '..'), { recursive: true, force: true })
    }
  }
}

type Pin = { version: string; sha256: string }

function readPin(root: string, arch: 'x64' | 'arm64'): Pin {
  const text = readFileSync(join(root, 'features/mise/tools.sh'), 'utf8')
  const value = (name: string) => {
    const m = new RegExp(`^${name}="([^"]+)"`, 'm').exec(text)
    if (!m?.[1]) throw new Error(`features/mise/tools.sh: no ${name}`)
    return m[1]
  }
  return {
    version: value('MISE_VERSION'),
    sha256: value(`MISE_SHA256_${arch === 'x64' ? 'AMD64' : 'ARM64'}`),
  }
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

// Runs the mise pinned in features/mise/tools.sh, downloaded once into the cache and sha256-checked.
export function miseLock(o: {
  root: string
  cache: string
  arch?: 'x64' | 'arm64'
  fetch?: (url: string) => Promise<Response>
}): MiseLock {
  const arch = o.arch ?? (process.arch === 'arm64' ? 'arm64' : 'x64')
  const get = o.fetch ?? ((url: string) => fetch(url))
  const binary = async (): Promise<string> => {
    const pin = readPin(o.root, arch)
    const dir = join(o.cache, 'mise', pin.version)
    const path = join(dir, `mise-linux-${arch}`)
    if (existsSync(path) && sha256(readFileSync(path)) === pin.sha256) return path
    const url = `https://github.com/jdx/mise/releases/download/v${pin.version}/mise-v${pin.version}-linux-${arch}`
    const res = await get(url)
    if (!res.ok) throw new Error(`downloading ${url}: HTTP ${res.status}`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (sha256(bytes) !== pin.sha256) throw new Error(`checksum mismatch for ${url}`)
    mkdirSync(dir, { recursive: true })
    const part = `${path}.${process.pid}.part`
    writeFileSync(part, bytes)
    chmodSync(part, 0o755)
    renameSync(part, path)
    return path
  }
  return async (dir, env) => {
    const mise = await binary()
    const state = mkdtempSync(join(tmpdir(), 'ns-mise-'))
    mkdirSync(join(state, 'home'))
    try {
      const proc = Bun.spawn([mise, 'lock', '--platform', 'linux-x64,linux-arm64'], {
        cwd: dir,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: LOCK_TIMEOUT_MS,
        // mise.toml is worker-written: safe mode and nothing from the supervisor's own environment.
        env: {
          PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
          HOME: join(state, 'home'),
          MISE_DATA_DIR: join(state, 'data'),
          MISE_CACHE_DIR: join(state, 'cache'),
          MISE_CONFIG_DIR: join(state, 'config'),
          MISE_STATE_DIR: join(state, 'state'),
          MISE_SAFE: '1',
          MISE_YES: '1',
          MISE_TRUSTED_CONFIG_PATHS: dir,
          ...(env.GITHUB_TOKEN ? { GITHUB_TOKEN: env.GITHUB_TOKEN } : {}),
        },
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      return { exitCode, output: `${stdout}${stderr}` }
    } finally {
      rmSync(state, { recursive: true, force: true })
    }
  }
}
