import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BaseCommit } from '../ports'
import { findingComment, type ReviewFinding } from '../stages/gates/review'
import {
  changesLines,
  keepsExisting,
  latestReaction,
  type ReviewExample,
  reactionLabel,
  redact,
} from './review-labels'
import { harness } from './testing'

const SUGGESTION: ReviewFinding = {
  severity: 'SUGGESTION',
  file: 'src/a.ts',
  lines: '10-12',
  message: 'off by one',
  evidence: '+for (i = 0; i <= n; i++)',
  category: 'other',
  confidence: 0.7,
}

const BLOCKER: ReviewFinding = { ...SUGGESTION, severity: 'BLOCKER', lines: '40', message: 'leaks' }

const PATCH = (file: string, oldStart: number, oldCount: number, newStart = oldStart) =>
  [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${oldStart},${oldCount} +${newStart},1 @@`,
    ...Array.from({ length: oldCount }, () => '-old'),
    '+new',
    '',
  ].join('\n')

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ns-labels-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function setup(o: { diff?: string } = {}) {
  const commits: BaseCommit[] = []
  const h = harness({
    evalDir: dir,
    repos: {
      baseSha: async () => 'base1',
      baseCommits: async () => commits,
      diff: async () => o.diff ?? PATCH('src/a.ts', 10, 1),
    },
  })
  const run = h.sup.runs.create({
    issue: 'FOR-1',
    agent: 'implementer',
    profile: 'default',
    model: 'm',
    repository: 'omni',
    baseSha: 'base1',
    attempt: 1,
  })
  h.sup.runs.update(run.id, { headSha: 'head1' })
  const review = async (findings: ReviewFinding[], verdict: 'pass' | 'fail' = 'fail') => {
    const event = h.sup.log.append({
      type: 'REVIEW_RECEIVED',
      issue: 'FOR-1',
      run: run.id,
      data: { verdict, model: 'glm', findings },
    })
    const head = await h.linear.comment('FOR-1', `Review\n\n<!-- nightshift:${event.id} -->`)
    const replies = []
    for (const [i, f] of findings.entries())
      replies.push(
        await h.linear.comment('FOR-1', findingComment(f, `${event.id}-${i + 1}`), { parentId: head.id }),
      )
    return { event, replies }
  }
  const example = (n: number): ReviewExample | undefined => {
    const p = join(dir, 'reviewer', `${run.id}-${n}.json`)
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : undefined
  }
  const label = async () => {
    await h.sup.tick()
    h.advance(3600_000)
  }
  return { h, run, review, example, label, commits }
}

describe('reaction mapping', () => {
  test('maps 👍 🤏 👎 by glyph and by Linear name', () => {
    expect(['👍', '+1', 'thumbsup'].map(reactionLabel)).toEqual(['real', 'real', 'real'])
    expect(['🤏', 'pinching_hand'].map(reactionLabel)).toEqual(['real-minor', 'real-minor'])
    expect(['👎', '-1', 'thumbsdown'].map(reactionLabel)).toEqual(['false', 'false', 'false'])
    expect(reactionLabel('heart')).toBeUndefined()
  })

  test('the newest known reaction decides', () => {
    expect(
      latestReaction({
        reactions: [
          { emoji: '+1', at: '2026-10-01T00:00:00.000Z' },
          { emoji: '-1', at: '2026-10-02T00:00:00.000Z' },
          { emoji: 'heart', at: '2026-10-03T00:00:00.000Z' },
        ],
      }),
    ).toBe('false')
    expect(latestReaction({})).toBeUndefined()
  })

  test('only a reaction replaces a reaction or a hand label', () => {
    expect(keepsExisting({ source: 'reaction' }, 'fix-commit')).toBe(true)
    expect(keepsExisting({ source: 'xxx-220' }, 'fix-commit')).toBe(true)
    expect(keepsExisting({ source: 'reaction' }, 'reaction')).toBe(false)
    expect(keepsExisting({ source: 'fix-commit' }, 'fix-commit')).toBe(false)
    expect(keepsExisting(undefined, 'fix-commit')).toBe(false)
  })
})

describe('fix-commit detection', () => {
  test('a commit changing a line inside the finding range overlaps', () => {
    expect(changesLines(PATCH('src/a.ts', 11, 1), 'src/a.ts', '10-12')).toBe(true)
    expect(changesLines(PATCH('src/a.ts', 9, 2), 'src/a.ts', '10-12')).toBe(true)
    expect(changesLines(PATCH('src/a.ts', 12, 1), 'src/a.ts', '12')).toBe(true)
  })

  test('lines outside the range, another file or no lines do not overlap', () => {
    expect(changesLines(PATCH('src/a.ts', 13, 2), 'src/a.ts', '10-12')).toBe(false)
    expect(changesLines(PATCH('src/a.ts', 1, 9), 'src/a.ts', '10-12')).toBe(false)
    expect(changesLines(PATCH('src/b.ts', 11, 1), 'src/a.ts', '10-12')).toBe(false)
    expect(changesLines(PATCH('src/a.ts', 11, 1), 'src/a.ts', undefined)).toBe(false)
  })
})

describe('review labeller', () => {
  test('a 👎 on a finding writes a false example from the reaction, in the documented shape', async () => {
    const s = setup()
    const { replies } = await s.review([SUGGESTION, BLOCKER])
    s.h.linear.react('FOR-1', replies[1]?.id as string, '-1')
    await s.h.sup.start()
    await s.label()

    expect(s.example(1)).toBeUndefined()
    expect(s.example(2)).toEqual({
      issue: 'FOR-1',
      run: s.run.id,
      repository: 'omni',
      base: 'base1',
      head: 'head1',
      file: 'src/a.ts',
      lines: '40',
      severity: 'BLOCKER',
      category: 'other',
      confidence: 0.7,
      message: 'leaks',
      evidence: '+for (i = 0; i <= n; i++)',
      diff: PATCH('src/a.ts', 10, 1),
      label: 'false',
      source: 'reaction',
    })
  })

  test('labels at most once an hour', async () => {
    const s = setup()
    const { replies } = await s.review([SUGGESTION])
    await s.h.sup.start()
    await s.h.sup.tick()
    s.h.linear.react('FOR-1', replies[0]?.id as string, '+1')
    s.h.advance(30 * 60_000)
    await s.h.sup.tick()
    expect(s.example(1)).toBeUndefined()
    s.h.advance(30 * 60_000)
    await s.h.sup.tick()
    expect(s.example(1)?.label).toBe('real')
  })

  test('a SUGGESTION whose lines a later fix commit changes is real-minor, a BLOCKER is not', async () => {
    const s = setup()
    const { event } = await s.review([SUGGESTION, { ...BLOCKER, lines: '11' }])
    const at = new Date(Date.parse(event.ts) + 86_400_000).toISOString()
    s.commits.push(
      { sha: 'f1', at, subject: 'fix(a): bound the loop', patch: PATCH('src/a.ts', 11, 1) },
      { sha: 'f2', at, subject: 'feat: other', patch: PATCH('src/a.ts', 10, 1) },
    )
    await s.h.sup.start()
    await s.label()
    expect(s.example(1)).toMatchObject({ label: 'real-minor', source: 'fix-commit' })
    expect(s.example(2)).toBeUndefined()
  })

  test('a fix commit after seven days or before the review labels nothing', async () => {
    const s = setup()
    const { event } = await s.review([SUGGESTION])
    const patch = PATCH('src/a.ts', 11, 1)
    const at = (ms: number) => new Date(Date.parse(event.ts) + ms).toISOString()
    s.commits.push(
      { sha: 'f0', at: at(-1000), subject: 'fix: early', patch },
      { sha: 'f9', at: at(8 * 86_400_000), subject: 'fix: late', patch },
    )
    await s.h.sup.start()
    await s.label()
    expect(s.example(1)).toBeUndefined()
  })

  test('a reaction overrides the automatic label, and a later reaction overwrites it', async () => {
    const s = setup()
    const { event, replies } = await s.review([SUGGESTION])
    const at = new Date(Date.parse(event.ts) + 1000).toISOString()
    s.commits.push({ sha: 'f1', at, subject: 'fix: loop', patch: PATCH('src/a.ts', 10, 1) })
    await s.h.sup.start()
    await s.label()
    expect(s.example(1)).toMatchObject({ label: 'real-minor', source: 'fix-commit' })

    s.h.linear.react('FOR-1', replies[0]?.id as string, '👎')
    await s.label()
    expect(s.example(1)).toMatchObject({ label: 'false', source: 'reaction' })

    s.h.linear.react('FOR-1', replies[0]?.id as string, '+1')
    await s.label()
    expect(s.example(1)).toMatchObject({ label: 'real', source: 'reaction' })
  })

  test('reactions on reviews older than 30 days are not read', async () => {
    const s = setup()
    const { replies } = await s.review([SUGGESTION])
    s.h.linear.react('FOR-1', replies[0]?.id as string, '-1')
    s.h.advance(31 * 86_400_000)
    let reads = 0
    const comments = s.h.linear.comments.bind(s.h.linear)
    s.h.linear.comments = async (id) => {
      reads++
      return comments(id)
    }
    await s.h.sup.start()
    await s.label()
    expect(s.example(1)).toBeUndefined()
    expect(reads).toBe(0)
  })

  test('a passing, merged review whose added lines a fix commit changes yields a missed example', async () => {
    const s = setup({ diff: PATCH('src/b.ts', 5, 1) })
    const { event } = await s.review([], 'pass')
    s.h.sup.log.append({
      type: 'MERGED',
      issue: 'FOR-1',
      run: s.run.id,
      data: { url: 'https://github.test/pr/1', branch: 'ns/FOR-1-1' },
    })
    const at = new Date(Date.parse(event.ts) + 1000).toISOString()
    s.commits.push({ sha: 'f1', at, subject: 'fix: b was wrong', patch: PATCH('src/b.ts', 5, 1) })
    await s.h.sup.start()
    await s.label()
    expect(s.example(1)).toMatchObject({
      file: 'src/b.ts',
      lines: '5',
      message: 'fix: b was wrong',
      label: 'missed',
      source: 'fix-commit',
    })
  })

  test('secrets in a finding are redacted before they are stored', async () => {
    const token = `ghp_${'a'.repeat(36)}`
    expect(redact(`token ${token} here`)).toBe('token [REDACTED] here')
    const s = setup()
    const { replies } = await s.review([{ ...SUGGESTION, evidence: `+const t = '${token}'` }])
    s.h.linear.react('FOR-1', replies[0]?.id as string, '+1')
    await s.h.sup.start()
    await s.label()
    expect(s.example(1)?.evidence).toBe("+const t = '[REDACTED]'")
  })
})

describe('XXX-220 import', () => {
  test('imports the hand labels once at start with source xxx-220', async () => {
    const src = join(dir, 'reviewer-xxx-220')
    mkdirSync(src, { recursive: true })
    const bundle = (id: string, file: string) => ({
      id,
      issue: 'XXX-1',
      run: id.split('#')[0],
      base: 'b0',
      file,
      lines: '3',
      severity: 'BLOCKER',
      category: 'other',
      confidence: 0.8,
      message: `msg ${id}`,
      evidence: 'ev',
      diff: 'diff --git a/x b/x',
    })
    writeFileSync(
      join(src, 'bundles.json'),
      JSON.stringify([bundle('R1#1', 'a.ts'), bundle('R1#2', 'b.ts'), bundle('R2#1', 'c.ts')]),
    )
    const labels = [
      [{ id: 'R1#1', label: 'real', reason: 'r' }],
      [{ id: 'R1#2', label: 'false', reason: 'r' }],
      [{ id: 'R2#1', label: 'real-minor', reason: 'r' }],
      [],
    ]
    for (const [i, l] of labels.entries()) writeFileSync(join(src, `labels${i}.json`), JSON.stringify(l))
    const s = setup()
    await s.h.sup.start()

    const out = join(dir, 'reviewer')
    expect(readdirSync(out).sort()).toEqual(['R1-1.json', 'R1-2.json', 'R2-1.json'])
    expect(JSON.parse(readFileSync(join(out, 'R1-1.json'), 'utf8'))).toEqual({
      issue: 'XXX-1',
      run: 'R1',
      repository: '',
      base: 'b0',
      head: '',
      file: 'a.ts',
      lines: '3',
      severity: 'BLOCKER',
      category: 'other',
      confidence: 0.8,
      message: 'msg R1#1',
      evidence: 'ev',
      diff: 'diff --git a/x b/x',
      label: 'real',
      source: 'xxx-220',
    })
    expect(JSON.parse(readFileSync(join(out, 'R2-1.json'), 'utf8')).label).toBe('real-minor')

    rmSync(join(out, 'R1-1.json'))
    await s.h.make().start()
    expect(existsSync(join(out, 'R1-1.json'))).toBe(false)
  })
})
