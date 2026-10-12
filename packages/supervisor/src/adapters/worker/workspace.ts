import type { OpenCodePluginEntry, WorkerImage } from '@nightshift/core'
import { branchOf, runRef } from '../../policy/naming'
import type { ExecutorStart, SandboxDriver, SandboxHandle } from '../../ports'
import type { Run } from '../../ports/records'
import { BaseConflictError } from '../../ports/worker'
import { INDEX_MOUNT, indexDb } from '../codegraph'
import { OPENCODE_CONFIG_DIR, WORKER_HOME } from './opencode'

// The index mount is read-only; cbm needs a writable cache dir, so the database is linked into one.
export const GRAPH_CACHE = `${WORKER_HOME}/cbm`

export const REPO_MOUNT = '/mnt/repo.git'

type Exec = Pick<SandboxDriver, 'exec'>

export function shellJoin(args: string[]): string {
  return args.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replaceAll("'", `'\\''`)}'`)).join(' ')
}

export async function prepareWorkspace(
  sb: Exec,
  sandbox: SandboxHandle,
  workdir: string,
  run: Run,
): Promise<void> {
  const script = [
    'set -e',
    'git config --global --add safe.directory "*" && git clone --quiet --shared "$1" "$2"',
    'git -C "$2" checkout --quiet -b "$3" "$4"',
    'git -C "$2" config user.name nightshift',
    'git -C "$2" config user.email nightshift@localhost',
  ].join('\n')
  const branch = branchOf(run)
  const res = await sb.exec(sandbox, [
    'sh',
    '-c',
    script,
    'sh',
    REPO_MOUNT,
    workdir,
    branch,
    run.baseSha || 'HEAD',
  ])
  if (res.exitCode !== 0) throw new Error(`workspace setup failed: ${res.stderrTail.trim()}`)
}

// The vault path lint reads `git ls-tree HEAD` of <dir>/.git; pin it to the remote base, not the local checkout.
export async function pinnedRepo(
  sb: Exec,
  sandbox: SandboxHandle,
  source: string,
  dir: string,
  repo: { remote: string; base: string },
): Promise<void> {
  const script = [
    'set -e',
    'git clone --quiet --bare --shared "$1" "$2/.git"',
    'git --git-dir="$2/.git" update-ref --no-deref HEAD "$(git --git-dir="$1" rev-parse --verify "$3^{commit}")"',
  ].join('\n')
  const res = await sb.exec(sandbox, [
    'sh',
    '-c',
    script,
    'sh',
    source,
    dir,
    `refs/remotes/${repo.remote}/${repo.base}`,
  ])
  if (res.exitCode !== 0) throw new Error(`knowledge repository setup failed: ${res.stderrTail.trim()}`)
}

export async function copySources(
  sb: Exec,
  sandbox: SandboxHandle,
  workdir: string,
  sourceFiles: ExecutorStart['sourceFiles'],
): Promise<void> {
  for (const file of sourceFiles ?? []) {
    if (!/^raw\/(linear|prs|reviews|failures)\/[^/]+\.md$/.test(file.path)) {
      throw new Error(`invalid ingest source path: ${file.path}`)
    }
    const res = await sb.exec(
      sandbox,
      ['sh', '-c', 'set -e; mkdir -p "$(dirname "$1")"; set -C; cat > "$1"', 'sh', `${workdir}/${file.path}`],
      { stdin: file.content },
    )
    if (res.exitCode !== 0) throw new Error(`source copy failed: ${res.stderrTail.trim()}`)
  }
}

export async function continueFrom(
  sb: Exec,
  sandbox: SandboxHandle,
  workdir: string,
  run: Run,
  from: NonNullable<ExecutorStart['repairFrom']>,
): Promise<void> {
  const res = await sb.exec(sandbox, [
    'sh',
    '-c',
    'set -e; git -C "$1" fetch --quiet "$2" "+$3:refs/nightshift/previous"; git -C "$1" checkout --quiet -B "$4" refs/nightshift/previous; git -C "$1" rev-parse HEAD',
    'sh',
    workdir,
    REPO_MOUNT,
    'run' in from ? runRef(from.run) : from.ref,
    branchOf(run),
  ])
  const head = res.stdoutTail.trim().split('\n').at(-1)
  if (res.exitCode !== 0 || head !== from.headSha) {
    throw new Error(`continuing from ${from.headSha.slice(0, 12)} failed: ${res.stderrTail.trim() || head}`)
  }
  if (run.baseSha) await mergeBase(sb, sandbox, workdir, run.baseSha, from.headSha, from.resolveConflicts)
}

const CONFLICT_EXIT = 3

// Merge, never rebase: the continued commits keep their hashes, so an open PR branch still fast-forwards.
// With resolveConflicts the conflicted merge is left in progress for the worker to resolve and commit.
async function mergeBase(
  sb: Exec,
  sandbox: SandboxHandle,
  workdir: string,
  baseSha: string,
  headSha: string,
  resolveConflicts = false,
): Promise<void> {
  const script = [
    'git merge-base --is-ancestor "$1" HEAD && exit 0',
    'git merge --quiet --no-ff --no-edit --no-verify -m "$2" "$1" >/dev/null 2>&1 && exit 0',
    'files=$(git diff --name-only --diff-filter=U)',
    'test -n "$files" || { git merge --abort 2>/dev/null; echo "git merge $1 failed" >&2; exit 1; }',
    'printf "%s\\n" "$files"',
    'test "$3" = keep && exit 0',
    'git merge --abort',
    `exit ${CONFLICT_EXIT}`,
  ].join('\n')
  const res = await sb.exec(
    sandbox,
    [
      'sh',
      '-c',
      script,
      'sh',
      baseSha,
      `Merge base ${baseSha.slice(0, 12)} into continued attempt`,
      resolveConflicts ? 'keep' : 'abort',
    ],
    { cwd: workdir },
  )
  if (res.exitCode === 0) return
  if (res.exitCode === CONFLICT_EXIT) {
    const files = res.stdoutTail
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    throw new BaseConflictError(baseSha, headSha, files)
  }
  throw new Error(`merging base ${baseSha.slice(0, 12)} failed: ${res.stderrTail.trim()}`)
}

export async function linkIndex(sb: Exec, sandbox: SandboxHandle, run: Run): Promise<void> {
  const res = await sb.exec(sandbox, [
    'sh',
    '-c',
    'mkdir -p "$1" && ln -sf "$2" "$1/"',
    'sh',
    GRAPH_CACHE,
    `${INDEX_MOUNT}/${indexDb(run.repository)}`,
  ])
  if (res.exitCode !== 0) throw new Error(`code graph link failed: ${res.stderrTail.trim()}`)
}

export async function diffLines(
  sb: Exec,
  sandbox: SandboxHandle,
  workdir: string,
  baseSha: string,
): Promise<number | undefined> {
  const script = [
    'i=$(mktemp)',
    'trap \'rm -f "$i"\' EXIT',
    'GIT_INDEX_FILE="$i" git read-tree HEAD',
    'GIT_INDEX_FILE="$i" git add -A',
    'GIT_INDEX_FILE="$i" git diff --cached --numstat "$1"',
  ].join(' && ')
  const res = await sb
    .exec(sandbox, ['sh', '-c', script, 'sh', baseSha || 'HEAD'], { cwd: workdir, timeoutMs: 30_000 })
    .catch(() => undefined)
  if (res?.exitCode !== 0) return undefined
  return res.stdoutTail
    .split('\n')
    .map((l) => l.split('\t'))
    .reduce((sum, [add, del]) => sum + (Number(add) || 0) + (Number(del) || 0), 0)
}

export const DCP_PACKAGE = '/opt/nightshift/npm/node_modules/@tarquinen/opencode-dcp'
export const DCP_PLUGIN_DIR = 'plugins/opencode-dcp'

export const DCP_CONFIG = {
  enabled: true,
  autoUpdate: false,
  debug: false,
  pruneNotification: 'off',
  commands: { enabled: false },
  compress: { permission: 'allow' },
}

// OpenCode 2.0.27 cannot watch pnpm's symlinked package dir and rejects file paths, so a wrapper dir re-exports it.
export function dcpFiles(): { path: string; content: string }[] {
  const pkg = { name: 'opencode-dcp', type: 'module', exports: { '.': './index.js' } }
  return [
    { path: `${DCP_PLUGIN_DIR}/package.json`, content: `${JSON.stringify(pkg, null, 2)}\n` },
    { path: `${DCP_PLUGIN_DIR}/index.js`, content: `export { default } from "${DCP_PACKAGE}/server.js"\n` },
    { path: 'dcp.jsonc', content: `${JSON.stringify(DCP_CONFIG, null, 2)}\n` },
  ]
}

export function agentConfig(
  plugin: OpenCodePluginEntry | undefined,
  lsp: WorkerImage['lsp'],
  skills = false,
): Record<string, unknown> {
  return {
    plugins: [...(plugin ? [plugin] : []), { package: `${OPENCODE_CONFIG_DIR}/${DCP_PLUGIN_DIR}` }],
    ...(Object.keys(lsp).length > 0 ? { lsp } : {}),
    ...(skills ? { skills: { paths: [`${OPENCODE_CONFIG_DIR}/skills`] } } : {}),
  }
}
