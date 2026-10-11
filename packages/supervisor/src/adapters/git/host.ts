import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const TEST_FILE = /(^|\/)(tests?|__tests__|spec|specs)\/|[._-](test|spec)\.[^/]+$|(^|\/)test_[^/]+\.py$/

export { runRef } from '../../policy/naming'

import { runRef } from '../../policy/naming'

export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path)
}

function git(checkout: string, ...args: string[]): string {
  const r = Bun.spawnSync(['git', '-C', checkout, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} in ${checkout}: ${r.stderr.toString().trim()}`)
  return r.stdout.toString()
}

export function importBundle(checkout: string, bundle: string, ref: string, run: string): string {
  git(checkout, 'fetch', '--quiet', '--no-write-fetch-head', bundle, `+${ref}:${runRef(run)}`)
  return git(checkout, 'rev-parse', '--verify', `${runRef(run)}^{commit}`).trim()
}

// Why a continued head does not hold a concluded, marker-free merge of base, or undefined when it does.
export function unresolvedMerge(
  checkout: string,
  base: string,
  head: string,
  files: string[],
): string | undefined {
  const run = (...args: string[]) =>
    Bun.spawnSync(['git', '-C', checkout, ...args], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
  const merged = run('merge-base', '--is-ancestor', base, head)
  if (merged.exitCode === 1) return `the merge of base ${base} was not concluded (${files.join(', ')})`
  if (merged.exitCode !== 0)
    throw new Error(`git merge-base ${base} ${head}: ${merged.stderr.toString().trim()}`)
  const grep = run('grep', '-l', '-E', '^(<{7}|>{7}|[|]{7})( |$)', head, '--', ...files)
  if (grep.exitCode > 1) throw new Error(`git grep ${head}: ${grep.stderr.toString().trim()}`)
  const fenced = new Set(
    grep.stdout
      .toString()
      .split('\n')
      .filter(Boolean)
      .map((l) => l.slice(head.length + 1)),
  )
  // A bare ======= is also a Markdown heading underline: it is a leftover only beyond what either side had.
  const sides = [base, ...mergedSides(run, base, head)]
  const marked = files.filter(
    (f) => fenced.has(f) || separators(run, head, f) > Math.max(...sides.map((s) => separators(run, s, f))),
  )
  return marked.length ? `conflict markers left in: ${marked.join(', ')}` : undefined
}

type Git = (...args: string[]) => { exitCode: number; stdout: Buffer; stderr: Buffer }

function separators(run: Git, rev: string, file: string): number {
  const show = run('show', `${rev}:${file}`)
  if (show.exitCode !== 0) return 0
  return show.stdout
    .toString()
    .split('\n')
    .filter((l) => l.replace(/\r$/, '') === '=======').length
}

// The other parents of the commits that merged base into head: the continued side of the merge.
function mergedSides(run: Git, base: string, head: string): string[] {
  const list = run('rev-list', '--parents', '--ancestry-path', `${base}..${head}`)
  if (list.exitCode !== 0) throw new Error(`git rev-list ${base}..${head}: ${list.stderr.toString().trim()}`)
  return list.stdout
    .toString()
    .split('\n')
    .map((l) => l.split(' ').slice(1))
    .filter((parents) => parents.includes(base))
    .flatMap((parents) => parents.filter((p) => p !== base))
}

export type ReviewArtifacts = { diff: string; testsTouched: string; tests: string[] }

export function writeReviewArtifacts(
  checkout: string,
  base: string,
  headSha: string,
  dir: string,
): ReviewArtifacts {
  mkdirSync(dir, { recursive: true })
  const diff = join(dir, 'diff.patch')
  const testsTouched = join(dir, 'tests-touched.txt')
  writeFileSync(diff, git(checkout, 'diff', '--no-color', '--no-ext-diff', base, headSha))
  const tests = git(checkout, 'diff', '--no-renames', '--diff-filter=MD', '--name-only', base, headSha)
    .split('\n')
    .filter((p) => p && isTestFile(p))
  writeFileSync(testsTouched, tests.length ? `${tests.join('\n')}\n` : '')
  return { diff, testsTouched, tests }
}
