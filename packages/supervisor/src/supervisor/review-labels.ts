import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LinearComment } from '../ports'
import { ControlError, type MissReport } from '../ports/control'
import type { ReviewFinding } from '../stages/gates/review'
import type { Event } from '../state/events'
import type { Run } from '../state/runs'
import type { SupervisorRuntime } from './runtime'

export type ExampleLabel = 'real' | 'real-minor' | 'false' | 'missed'
export type ExampleSource = 'reaction' | 'test' | 'manual' | 'xxx-220'

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
const LABELLED_AT = 'review_labels_at'
const LABEL_ERROR = 'review_labels_error'
const IMPORTED = 'review_labels_xxx220'
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

// Only the owner's reactions count: `owner` when configured, else the user nightshift acts for.
export function latestReaction(
  c: Pick<LinearComment, 'reactions'>,
  owner?: string,
): ExampleLabel | undefined {
  const known = (c.reactions ?? []).filter(
    (r) => (owner === undefined ? r.me === true : r.user === owner) && reactionLabel(r.emoji) !== undefined,
  )
  const newest = known.sort((a, b) => a.at.localeCompare(b.at)).at(-1)
  return newest && reactionLabel(newest.emoji)
}

// Hand labels win over automatic ones; a reaction always replaces what is there.
export function keepsExisting(
  existing: Pick<ReviewExample, 'source'> | undefined,
  next: ExampleSource,
): boolean {
  if (!existing || next === 'reaction') return false
  return existing.source === 'reaction' || existing.source === 'xxx-220' || existing.source === 'manual'
}

export function redact(text: string): string {
  return SECRETS.reduce((t, re) => t.replace(re, '[REDACTED]'), text)
}

export class ReviewExamples {
  constructor(readonly dir: string) {}

  private name(run: string, n: number | string): string {
    return `${run}-${n}`.replace(/[^\w.-]/g, '_')
  }

  path(run: string, n: number | string): string {
    return join(this.dir, `${this.name(run, n)}.json`)
  }

  read(run: string, n: number | string): ReviewExample | undefined {
    const p = this.path(run, n)
    return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as ReviewExample) : undefined
  }

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

// New-side line numbers each file's hunks add, keyed by the b/ path.
export function addedLines(patch: string): Map<string, Set<number>> {
  const added = new Map<string, Set<number>>()
  let file: Set<number> | undefined
  let line = 0
  for (const text of patch.split('\n')) {
    const header = /^\+\+\+ (?:b\/)?(.+)$/.exec(text)
    if (header) {
      const path = header[1] as string
      file = path === '/dev/null' ? undefined : (added.get(path) ?? new Set())
      if (file) added.set(path, file)
      continue
    }
    if (text.startsWith('diff --git ')) {
      file = undefined
      continue
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text)
    if (hunk) line = Number(hunk[1])
    else if (text.startsWith('+')) file?.add(line++)
    else if (text.startsWith(' ')) line++
  }
  return added
}

function prMatches(url: string, pr: string): boolean {
  if (/^\d+$/.test(pr)) return new RegExp(`/pull/${pr}/?$`).test(url)
  return url.replace(/\/+$/, '') === pr.replace(/\/+$/, '')
}

export async function recordMiss(rt: SupervisorRuntime, evalDir: string, miss: MissReport): Promise<string> {
  const range = /^(\d+)(?:-(\d+))?$/.exec(miss.lines)
  if (!range) throw new ControlError('bad_request', `lines must be N or N-M, got ${miss.lines}`)
  const from = Number(range[1])
  const to = Number(range[2] ?? range[1])
  if (to < from) throw new ControlError('bad_request', `empty line range ${miss.lines}`)
  const runs = new Map<string, Run>()
  for (const e of rt.log.since(null, { types: ['PR_CREATED'] })) {
    const run = e.run ? rt.runs.get(e.run) : undefined
    if (!run || !prMatches(String(e.data.url ?? ''), miss.pr)) continue
    if (miss.repository !== undefined && run.repository !== miss.repository) continue
    runs.set(run.id, run)
  }
  const where = miss.repository ? ` in ${miss.repository}` : ''
  if (runs.size === 0) throw new ControlError('not_found', `no nightshift run produced PR ${miss.pr}${where}`)
  if (runs.size > 1)
    throw new ControlError('refused', `PR ${miss.pr} matches runs in several repositories; pass --repo`)
  const run = [...runs.values()][0] as Run
  if (!run.baseSha || !run.headSha || !rt.deps.repos.diff)
    throw new ControlError('refused', `run ${run.id} has no diff to check ${miss.file}:${miss.lines} against`)
  const diff = await rt.deps.repos.diff(run.repository, run.baseSha, run.headSha)
  const added = addedLines(diff).get(miss.file)
  let hit = false
  for (let n = from; n <= to && !hit; n++) hit = added?.has(n) ?? false
  if (!hit) throw new ControlError('refused', `run ${run.id} did not add ${miss.file}:${miss.lines}`)
  const examples = new ReviewExamples(join(evalDir, 'reviewer'))
  let n = 1
  while (existsSync(examples.path(run.id, `m${n}`))) n++
  examples.write(`m${n}`, {
    issue: run.issue,
    run: run.id,
    repository: run.repository,
    base: run.baseSha,
    head: run.headSha,
    file: miss.file,
    lines: miss.lines,
    severity: 'BLOCKER',
    category: 'other',
    confidence: 0,
    message: miss.description,
    evidence: '',
    diff,
    label: 'missed',
    source: 'manual',
  })
  return examples.path(run.id, `m${n}`)
}

type Bundle = Partial<Omit<ReviewExample, 'label' | 'source' | 'confidence'>> & {
  id: string
  confidence?: number
}

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
    const diffs = new Map<string, string>()
    const owner = this.rt.config().linear.owner
    let written = 0
    for (const event of reviews) {
      const run = this.rt.runs.get(event.run as string)
      if (!run) continue
      const findings = (event.data.findings ?? []) as ReviewFinding[]
      if (!findings.length) continue
      const issue = event.issue as string
      let thread = threads.get(issue)
      if (!thread) {
        thread = await this.rt.deps.linear.comments(issue)
        threads.set(issue, thread)
      }
      const diff = await this.diffOf(run, diffs)
      for (const [i, f] of findings.entries()) {
        const n = i + 1
        const tag = `<!-- nightshift:${event.id}-${n} -->`
        const reaction = thread.find((c) => c.body.includes(tag))
        const reacted = reaction && latestReaction(reaction, owner)
        if (!reacted) continue
        const ok = this.examples.write(n, {
          ...this.base(event, run, diff),
          file: f.file,
          lines: f.lines ?? '',
          severity: f.severity,
          category: f.category,
          confidence: f.confidence,
          message: f.message,
          evidence: f.evidence,
          label: reacted,
          source: 'reaction',
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
