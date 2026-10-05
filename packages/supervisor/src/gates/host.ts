import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const TEST_FILE = /(^|\/)(tests?|__tests__|spec|specs)\/|[._-](test|spec)\.[^/]+$|(^|\/)test_[^/]+\.py$/

export function runRef(run: string): string {
  return `refs/nightshift/${run}`
}

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
