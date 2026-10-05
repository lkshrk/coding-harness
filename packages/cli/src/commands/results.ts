import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { expandHome } from '@nightshift/core'
import { type DiffRecord, eventsAfter, type Run, runRef, type TestsRecord } from '@nightshift/supervisor'
import { CliError, type Ctx, EXIT, paint, parseArgs, printJson, requireArg } from '../cli'
import { duration, targetRun, withDb } from './shared'

type FileStat = DiffRecord['files'][number]

export const DIFF_USAGE = 'ns diff <target> [--stat]'
export const TESTS_USAGE = 'ns tests <target>'

export function parseNumstat(text: string): FileStat[] {
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      const [added, deleted, ...path] = l.split('\t')
      const n = (v: string | undefined) => (v === '-' || v === undefined ? null : Number(v))
      return { path: path.join('\t'), added: n(added), deleted: n(deleted) }
    })
}

export function patchStat(patch: string): FileStat[] {
  const files: FileStat[] = []
  let current: { path: string; added: number; deleted: number; binary: boolean } | undefined
  const push = () => {
    if (current) {
      files.push({
        path: current.path,
        added: current.binary ? null : current.added,
        deleted: current.binary ? null : current.deleted,
      })
    }
  }
  for (const line of patch.split('\n')) {
    const header = line.match(/^diff --git a\/(.+) b\/(.+)$/)
    if (header) {
      push()
      current = { path: header[2] as string, added: 0, deleted: 0, binary: false }
    } else if (!current) continue
    else if (line.startsWith('Binary files')) current.binary = true
    else if (line.startsWith('+++') || line.startsWith('---')) continue
    else if (line.startsWith('+')) current.added += 1
    else if (line.startsWith('-')) current.deleted += 1
  }
  push()
  return files
}

export function statLines(files: FileStat[]): string[] {
  const width = Math.max(0, ...files.map((f) => f.path.length))
  const lines = files.map((f) =>
    f.added === null
      ? ` ${f.path.padEnd(width)} | Bin`
      : ` ${f.path.padEnd(width)} | +${f.added} -${f.deleted}`,
  )
  const add = files.reduce((s, f) => s + (f.added ?? 0), 0)
  const del = files.reduce((s, f) => s + (f.deleted ?? 0), 0)
  lines.push(
    ` ${files.length} file${files.length === 1 ? '' : 's'} changed, ${add} insertions(+), ${del} deletions(-)`,
  )
  return lines
}

function checkoutOf(ctx: Ctx, run: Run): string | null {
  const repo = ctx.config().repositories[run.repository]
  return repo ? expandHome(repo.path, homedir()) : null
}

export function runDiff(ctx: Ctx, run: Run, withPatch: boolean): DiffRecord | null {
  const checkout = checkoutOf(ctx, run)
  const ref = runRef(run.id)
  if (checkout) {
    const head = ctx.capture(['git', '-C', checkout, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
    if (head.exitCode === 0) {
      const sha = head.stdout.trim()
      const base = run.baseSha || `${sha}~1`
      const numstat = ctx.capture(['git', '-C', checkout, 'diff', '--numstat', '--no-renames', base, sha])
      if (numstat.exitCode !== 0) throw new CliError(EXIT.error, `git diff failed: ${numstat.stderr.trim()}`)
      const record: DiffRecord = {
        run: run.id,
        issue: run.issue,
        base,
        head: sha,
        files: parseNumstat(numstat.stdout),
      }
      if (withPatch) {
        const patch = ctx.capture(['git', '-C', checkout, 'diff', '--no-color', '--no-ext-diff', base, sha])
        record.patch = patch.stdout
      }
      return record
    }
  }
  const artifact = join(dirname(ctx.statePath()), 'artifacts', run.id, 'diff.patch')
  if (!existsSync(artifact)) return null
  const patch = readFileSync(artifact, 'utf8')
  return {
    run: run.id,
    issue: run.issue,
    base: run.baseSha,
    head: run.headSha ?? '',
    files: patchStat(patch),
    ...(withPatch ? { patch } : {}),
  }
}

export function diff(ctx: Ctx, args: string[]): number {
  const usage = DIFF_USAGE
  const { positionals, bools } = parseArgs(args, { bools: ['--stat'] }, usage)
  const target = requireArg(positionals[0], usage)
  const run = withDb(ctx, (db) => targetRun(db, target))
  const record = runDiff(ctx, run, !bools.has('--stat'))
  if (!record) throw new CliError(EXIT.notFound, `no result yet for ${run.id}`)
  if (ctx.flags.json) printJson(ctx, record)
  else if (bools.has('--stat')) for (const line of statLines(record.files)) ctx.io.out(line)
  else ctx.io.out((record.patch ?? '').replace(/\n$/, ''))
  return EXIT.ok
}

type Gate = { check: string; exit_code: number; duration_ms: number; output_tail?: string; artifact?: string }

export function testsRecord(ctx: Ctx, run: Run): TestsRecord | null {
  return withDb(ctx, (db) => {
    const events = eventsAfter(db, null, {
      run: run.id,
      types: ['GATE_PASSED', 'GATE_FAILED', 'REVIEW_RECEIVED'],
    })
    if (events.length === 0) return null
    const review = events.filter((e) => e.type === 'REVIEW_RECEIVED').at(-1)
    return {
      run: run.id,
      issue: run.issue,
      checks: events
        .filter((e) => e.type !== 'REVIEW_RECEIVED')
        .map((e) => ({ ...(e.data as Gate), passed: e.type === 'GATE_PASSED' })),
      review: review ? (review.data as TestsRecord['review']) : null,
    }
  })
}

export function tests(ctx: Ctx, args: string[]): number {
  const usage = TESTS_USAGE
  const target = requireArg(parseArgs(args, {}, usage).positionals[0], usage)
  const run = withDb(ctx, (db) => targetRun(db, target))
  const record = testsRecord(ctx, run)
  if (!record) throw new CliError(EXIT.notFound, `no result yet for ${run.id}`)
  if (ctx.flags.json) {
    printJson(ctx, record)
    return EXIT.ok
  }
  const p = paint(ctx.color)
  for (const c of record.checks) {
    const mark = c.passed ? p('green', '✓') : p('red', '✗')
    ctx.io.out(
      `${mark} ${p('bold', c.check)} exit ${c.exit_code} (${duration(c.duration_ms)})${c.artifact ? ` ${c.artifact}` : ''}`,
    )
    const tail = (c.output_tail ?? '').trimEnd().split('\n').slice(-10)
    for (const line of tail) if (line) ctx.io.out(`    ${line}`)
  }
  if (!record.review) ctx.io.out('review: none yet')
  else {
    const verdict = record.review.verdict === 'pass' ? p('green', 'pass') : p('red', 'fail')
    ctx.io.out(`review: ${verdict}${record.review.model ? ` (${record.review.model})` : ''}`)
    for (const f of record.review.findings) {
      const sev = f.severity === 'BLOCKER' ? p('red', f.severity) : p('yellow', f.severity)
      ctx.io.out(`  ${sev} ${f.file}${f.lines ? `:${f.lines}` : ''} ${f.message}`)
    }
  }
  return EXIT.ok
}
