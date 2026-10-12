import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BaseCommit, LinearComment } from '../ports'
import type { ReviewFinding } from '../stages/gates/review'
import type { Event } from '../state/events'
import type { Run } from '../state/runs'
import type { SupervisorRuntime } from './runtime'

export type ExampleLabel = 'real' | 'real-minor' | 'false' | 'missed'
export type ExampleSource = 'reaction' | 'test' | 'fix-commit' | 'xxx-220'

export type ReviewExample = {
  issue: string
  run: string
  repository: string
  base: string
  head: string
  file: string
  lines: string
  severity: string
  category: string
  confidence: number
  message: string
  evidence: string
  diff: string
  label: ExampleLabel
  source: ExampleSource
}

const HOUR_MS = 3600_000
const DAY_MS = 24 * HOUR_MS
const REACTION_WINDOW_MS = 30 * DAY_MS
const FIX_WINDOW_MS = 7 * DAY_MS
const LABELLED_AT = 'review_labels_at'
const LABEL_ERROR = 'review_labels_error'
const IMPORTED = 'review_labels_xxx220'
const FIX_SUBJECT = /^fix(\([^)]*\))?!?:/
const XXX_220_LABELS = ['labels0.json', 'labels1.json', 'labels2.json', 'labels3.json']

// Linear reports standard emojis by normalized name; the glyphs cover clients that send them raw.
const REACTIONS: Record<string, Exclude<ExampleLabel, 'missed'>> = {
  '👍': 'real',
  '+1': 'real',
  thumbsup: 'real',
  thumbs_up: 'real',
  '🤏': 'real-minor',
  pinching_hand: 'real-minor',
  '👎': 'false',
  '-1': 'false',
  thumbsdown: 'false',
  thumbs_down: 'false',
}

const SECRETS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\blin_(?:api|oauth)_[A-Za-z0-9]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /(?<=\bBearer\s+)[A-Za-z0-9._~+/-]{20,}=*/g,
]

export function reactionLabel(emoji: string): Exclude<ExampleLabel, 'missed'> | undefined {
  return REACTIONS[emoji]
}

export function latestReaction(c: Pick<LinearComment, 'reactions'>): ExampleLabel | undefined {
  const known = (c.reactions ?? []).filter((r) => reactionLabel(r.emoji) !== undefined)
  const newest = known.sort((a, b) => a.at.localeCompare(b.at)).at(-1)
  return newest && reactionLabel(newest.emoji)
}

// Hand labels win over automatic ones; a reaction always replaces what is there.
export function keepsExisting(
  existing: Pick<ReviewExample, 'source'> | undefined,
  next: ExampleSource,
): boolean {
  if (!existing || next === 'reaction') return false
  return existing.source === 'reaction' || existing.source === 'xxx-220'
}

export function redact(text: string): string {
  return SECRETS.reduce((t, re) => t.replace(re, '[REDACTED]'), text)
}

type Touched = { old: Set<number>; added: Set<number> }

// Per file: old-side lines a patch removes or inserts at, and new-side lines it adds.
export function touchedLines(patch: string): Map<string, Touched> {
  const out = new Map<string, Touched>()
  let cur: Touched | undefined
  let oldLine = 0
  let newLine = 0
  let from = ''
  for (const line of patch.split('\n')) {
    const header = /^diff --git a\/(\S+) b\/(\S+)/.exec(line)
    if (header) {
      from = header[1] as string
      cur = undefined
      continue
    }
    if (line.startsWith('--- ')) continue
    if (line.startsWith('+++ ')) {
      const path = line === '+++ /dev/null' ? from : line.replace(/^\+\+\+ b\//, '')
      cur = out.get(path) ?? { old: new Set(), added: new Set() }
      out.set(path, cur)
      continue
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[3])
      if (hunk[2] === '0') cur?.old.add(oldLine)
      continue
    }
    if (!cur) continue
    if (line.startsWith('-')) cur.old.add(oldLine++)
    else if (line.startsWith('+')) cur.added.add(newLine++)
    else if (line.startsWith(' ')) {
      oldLine++
      newLine++
    }
  }
  return out
}

function lineRange(lines: string | undefined): [number, number] | undefined {
  const m = /^(\d+)(?:-(\d+))?$/.exec(lines ?? '')
  return m ? [Number(m[1]), Number(m[2] ?? m[1])] : undefined
}

export function changesLines(patch: string, file: string, lines: string | undefined): boolean {
  const range = lineRange(lines)
  const touched = touchedLines(patch).get(file)
  if (!range || !touched) return false
  return [...touched.old].some((n) => n >= range[0] && n <= range[1])
}

export function isFixCommit(c: Pick<BaseCommit, 'subject'>): boolean {
  return FIX_SUBJECT.test(c.subject)
}

function span(nums: number[]): string {
  const sorted = [...nums].sort((a, b) => a - b)
  const [lo, hi] = [sorted[0], sorted.at(-1)]
  return lo === hi ? `${lo}` : `${lo}-${hi}`
}

function fileSection(patch: string, file: string): string {
  return patch
    .split(/^(?=diff --git )/m)
    .filter((part) => part.startsWith(`diff --git a/${file} `) || part.includes(`\n+++ b/${file}\n`))
    .join('')
}

export class ReviewExamples {
  constructor(readonly dir: string) {}

  path(run: string, n: number | string): string {
    return join(this.dir, `${`${run}-${n}`.replace(/[^\w.-]/g, '_')}.json`)
  }

  read(run: string, n: number | string): ReviewExample | undefined {
    const p = this.path(run, n)
    return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as ReviewExample) : undefined
  }

  // Returns whether the file changed.
  write(n: number | string, example: ReviewExample): boolean {
    const existing = this.read(example.run, n)
    if (keepsExisting(existing, example.source)) return false
    const clean: ReviewExample = {
      ...example,
      file: redact(example.file),
      message: redact(example.message),
      evidence: redact(example.evidence),
      diff: redact(example.diff),
    }
    const body = `${JSON.stringify(clean, null, 2)}\n`
    const p = this.path(example.run, n)
    if (existsSync(p) && readFileSync(p, 'utf8') === body) return false
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(`${p}.tmp`, body)
    renameSync(`${p}.tmp`, p)
    return true
  }
}

type Bundle = Partial<Omit<ReviewExample, 'label' | 'source' | 'confidence'>> & {
  id: string
  confidence?: number
}

// Imports the hand-labelled findings from `<evalDir>/reviewer-xxx-220/` once.
export function importXxx220(rt: SupervisorRuntime, evalDir: string): number {
  if (rt.meta(IMPORTED)) return 0
  const src = join(evalDir, 'reviewer-xxx-220')
  const bundlesPath = join(src, 'bundles.json')
  if (!existsSync(bundlesPath)) return 0
  const bundles = new Map(
    (JSON.parse(readFileSync(bundlesPath, 'utf8')) as Bundle[]).map((b) => [b.id, b] as const),
  )
  const labels = new Map<string, ExampleLabel>()
  for (const name of XXX_220_LABELS) {
    const p = join(src, name)
    if (!existsSync(p)) continue
    for (const l of JSON.parse(readFileSync(p, 'utf8')) as { id: string; label: ExampleLabel }[])
      labels.set(l.id, l.label)
  }
  const examples = new ReviewExamples(join(evalDir, 'reviewer'))
  let written = 0
  for (const [id, label] of labels) {
    const b = bundles.get(id)
    if (!b) continue
    const [run = b.run ?? id, n = '0'] = id.split('#')
    const known = rt.runs.get(run)
    const ok = examples.write(n, {
      issue: b.issue ?? known?.issue ?? '',
      run,
      repository: b.repository ?? known?.repository ?? '',
      base: b.base ?? known?.baseSha ?? '',
      head: b.head ?? known?.headSha ?? '',
      file: b.file ?? '',
      lines: b.lines ?? '',
      severity: b.severity ?? '',
      category: b.category ?? '',
      confidence: b.confidence ?? 0,
      message: b.message ?? '',
      evidence: b.evidence ?? '',
      diff: b.diff ?? '',
      label,
      source: 'xxx-220',
    })
    if (ok) written++
  }
  rt.setMeta(IMPORTED, rt.now().toISOString())
  return written
}

export class ReviewLabeller {
  private readonly examples: ReviewExamples

  constructor(
    private readonly rt: SupervisorRuntime,
    evalDir: string,
  ) {
    this.examples = new ReviewExamples(join(evalDir, 'reviewer'))
  }

  // Runs at most once an hour; a failure is kept in meta and retried next hour.
  async maybeLabel(): Promise<void> {
    const now = this.rt.now().getTime()
    const last = Date.parse(this.rt.meta(LABELLED_AT) ?? '')
    if (Number.isFinite(last) && now - last < HOUR_MS) return
    this.rt.setMeta(LABELLED_AT, this.rt.now().toISOString())
    try {
      await this.label()
      this.rt.setMeta(LABEL_ERROR, '')
    } catch (e) {
      this.rt.setMeta(LABEL_ERROR, (e as Error).message)
    }
  }

  async label(): Promise<number> {
    const now = this.rt.now().getTime()
    const since = new Date(now - REACTION_WINDOW_MS).toISOString()
    const reviews = this.rt.log
      .since(null, { types: ['REVIEW_RECEIVED'] })
      .filter((e) => e.ts >= since && e.run && e.issue)
    const threads = new Map<string, LinearComment[]>()
    const commits = new Map<string, BaseCommit[]>()
    const diffs = new Map<string, string>()
    let written = 0
    for (const event of reviews) {
      const run = this.rt.runs.get(event.run as string)
      if (!run) continue
      const findings = (event.data.findings ?? []) as ReviewFinding[]
      const issue = event.issue as string
      let thread = threads.get(issue)
      if (!thread && findings.length) {
        thread = await this.rt.deps.linear.comments(issue)
        threads.set(issue, thread)
      }
      const fixes = (await this.commitsFor(run.repository, since, commits)).filter(
        (c) => isFixCommit(c) && c.at > event.ts && Date.parse(c.at) - Date.parse(event.ts) <= FIX_WINDOW_MS,
      )
      const diff = await this.diffOf(run, diffs)
      for (const [i, f] of findings.entries()) {
        const n = i + 1
        const tag = `<!-- nightshift:${event.id}-${n} -->`
        const reaction = thread?.find((c) => c.body.includes(tag))
        const reacted = reaction && latestReaction(reaction)
        const fixed = f.severity === 'SUGGESTION' && fixes.some((c) => changesLines(c.patch, f.file, f.lines))
        const label: [ExampleLabel, ExampleSource] | undefined = reacted
          ? [reacted, 'reaction']
          : fixed
            ? ['real-minor', 'fix-commit']
            : undefined
        if (!label) continue
        const ok = this.examples.write(n, {
          ...this.base(event, run, diff),
          file: f.file,
          lines: f.lines ?? '',
          severity: f.severity,
          category: f.category,
          confidence: f.confidence,
          message: f.message,
          evidence: f.evidence,
          label: label[0],
          source: label[1],
        })
        if (ok) written++
      }
      if (event.data.verdict === 'pass' && this.merged(issue))
        written += this.missed(event, run, diff, findings.length, fixes)
    }
    return written
  }

  private missed(event: Event, run: Run, diff: string, offset: number, fixes: BaseCommit[]): number {
    const ours = touchedLines(diff)
    let written = 0
    let k = 0
    for (const c of fixes) {
      for (const [file, theirs] of touchedLines(c.patch)) {
        const added = ours.get(file)?.added
        const hit = [...theirs.old].filter((line) => added?.has(line))
        if (!hit.length) continue
        k++
        const ok = this.examples.write(offset + k, {
          ...this.base(event, run, diff),
          file,
          lines: span(hit),
          severity: 'BLOCKER',
          category: 'other',
          confidence: 0,
          message: c.subject,
          evidence: `${c.sha}\n${fileSection(c.patch, file)}`,
          label: 'missed',
          source: 'fix-commit',
        })
        if (ok) written++
      }
    }
    return written
  }

  private base(event: Event, run: Run, diff: string) {
    return {
      issue: event.issue as string,
      run: run.id,
      repository: run.repository,
      base: run.baseSha,
      head: run.headSha ?? '',
      diff,
    }
  }

  private merged(issue: string): boolean {
    return this.rt.log.since(null, { issue, types: ['MERGED'] }).length > 0
  }

  private async commitsFor(repository: string, since: string, cache: Map<string, BaseCommit[]>) {
    const hit = cache.get(repository)
    if (hit) return hit
    const list = (await this.rt.deps.repos.baseCommits?.(repository, since)) ?? []
    cache.set(repository, list)
    return list
  }

  private async diffOf(run: Run, cache: Map<string, string>): Promise<string> {
    const hit = cache.get(run.id)
    if (hit !== undefined) return hit
    let diff = ''
    try {
      if (run.baseSha && run.headSha)
        diff = (await this.rt.deps.repos.diff?.(run.repository, run.baseSha, run.headSha)) ?? ''
    } catch {}
    cache.set(run.id, diff)
    return diff
  }
}
