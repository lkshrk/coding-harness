import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LinearComment } from '../ports'
import { findingComment, type ReviewFinding } from '../stages/gates/review'
import { keepsExisting, latestReaction, type ReviewExample, reactionLabel, redact } from './review-labels'
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
  const h = harness({
    evalDir: dir,
    repos: {
      baseSha: async () => 'base1',
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
  return { h, run, review, example, label }
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
          { emoji: '+1', at: '2026-10-01T00:00:00.000Z', me: true },
          { emoji: '-1', at: '2026-10-02T00:00:00.000Z', me: true },
          { emoji: 'heart', at: '2026-10-03T00:00:00.000Z', me: true },
        ],
      }),
    ).toBe('false')
    expect(latestReaction({})).toBeUndefined()
  })

  test("only the owner's reactions count: the acting user, or the configured owner id", () => {
    const reactions: NonNullable<LinearComment['reactions']> = [
      { emoji: '+1', at: '2026-10-01T00:00:00.000Z', user: 'u-owner', me: true },
      { emoji: '-1', at: '2026-10-02T00:00:00.000Z', user: 'u-other' },
    ]
    expect(latestReaction({ reactions })).toBe('real')
    expect(latestReaction({ reactions }, 'u-other')).toBe('false')
    expect(latestReaction({ reactions: reactions.slice(1) })).toBeUndefined()
  })

  test('only a reaction replaces a reaction or a hand label', () => {
    expect(keepsExisting({ source: 'reaction' }, 'xxx-220')).toBe(true)
    expect(keepsExisting({ source: 'xxx-220' }, 'manual')).toBe(true)
    expect(keepsExisting({ source: 'manual' }, 'xxx-220')).toBe(true)
    expect(keepsExisting({ source: 'reaction' }, 'reaction')).toBe(false)
    expect(keepsExisting({ source: 'test' }, 'manual')).toBe(false)
    expect(keepsExisting(undefined, 'xxx-220')).toBe(false)
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

  test('a reaction by someone other than the owner labels nothing', async () => {
    const s = setup()
    const { replies } = await s.review([SUGGESTION])
    s.h.linear.react('FOR-1', replies[0]?.id as string, '-1', { user: 'u-other' })
    await s.h.sup.start()
    await s.label()
    expect(s.example(1)).toBeUndefined()
  })

  test("with linear.owner set, that user's reaction decides", async () => {
    const s = setup()
    s.h.config.linear.owner = 'u-lead'
    const { replies } = await s.review([SUGGESTION])
    s.h.linear.react('FOR-1', replies[0]?.id as string, '-1', { user: 'u-lead' })
    s.h.linear.react('FOR-1', replies[0]?.id as string, '+1')
    await s.h.sup.start()
    await s.label()
    expect(s.example(1)).toMatchObject({ label: 'false', source: 'reaction' })
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

  test('a merged pass writes no example and posts no comment until the owner reacts', async () => {
    const s = setup({ diff: PATCH('src/b.ts', 5, 1) })
    const { replies } = await s.review([SUGGESTION], 'pass')
    s.h.sup.log.append({
      type: 'MERGED',
      issue: 'FOR-1',
      run: s.run.id,
      data: { url: 'https://github.test/pr/1', branch: 'ns/FOR-1-1' },
    })
    const before = (await s.h.linear.comments('FOR-1')).length
    await s.h.sup.start()
    await s.label()
    await s.label()
    expect(existsSync(join(dir, 'reviewer'))).toBe(false)
    expect(await s.h.linear.comments('FOR-1')).toHaveLength(before)

    s.h.linear.react('FOR-1', replies[0]?.id as string, '🤏')
    await s.label()
    expect(readdirSync(join(dir, 'reviewer'))).toEqual([`${s.run.id}-1.json`])
    expect(s.example(1)).toMatchObject({ label: 'real-minor', source: 'reaction' })
  })

  test('a reaction replaces an earlier reaction label', async () => {
    const s = setup()
    const { replies } = await s.review([SUGGESTION])
    s.h.linear.react('FOR-1', replies[0]?.id as string, '👎')
    await s.h.sup.start()
    await s.label()
    expect(s.example(1)).toMatchObject({ label: 'false', source: 'reaction' })

    s.h.linear.react('FOR-1', replies[0]?.id as string, '+1')
    await s.label()
    expect(s.example(1)).toMatchObject({ label: 'real', source: 'reaction' })
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

describe('import of hand-labelled findings', () => {
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

describe('recording a missed bug by hand', () => {
  const PR = 'https://github.com/lkshrk/omni/pull/7'
  const opened = (s: ReturnType<typeof setup>, url = PR) =>
    s.h.sup.log.append({
      type: 'PR_CREATED',
      issue: 'FOR-1',
      run: s.run.id,
      data: { url, branch: 'ns/FOR-1-1', account: 'bot', mode: 'auto' },
    })

  test('writes a manual missed example for lines the run added and never rewrites one', async () => {
    const s = setup({ diff: PATCH('src/a.ts', 10, 2, 12) })
    opened(s)
    const path = await s.h.sup.recordMiss({
      pr: '7',
      file: 'src/a.ts',
      lines: '11-12',
      description: 'leaks fd',
    })
    expect(path).toBe(join(dir, 'reviewer', `${s.run.id}-m1.json`))
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      issue: 'FOR-1',
      run: s.run.id,
      repository: 'omni',
      base: 'base1',
      head: 'head1',
      file: 'src/a.ts',
      lines: '11-12',
      severity: 'BLOCKER',
      category: 'other',
      confidence: 0,
      message: 'leaks fd',
      evidence: '',
      diff: PATCH('src/a.ts', 10, 2, 12),
      label: 'missed',
      source: 'manual',
    })
    const second = await s.h.sup.recordMiss({ pr: PR, file: 'src/a.ts', lines: '12', description: 'other' })
    expect(second).toBe(join(dir, 'reviewer', `${s.run.id}-m2.json`))
    expect(JSON.parse(readFileSync(path, 'utf8')).message).toBe('leaks fd')
  })

  test('refuses lines the run did not add, naming the file and range', async () => {
    const s = setup({ diff: PATCH('src/a.ts', 10, 1) })
    opened(s)
    await expect(
      s.h.sup.recordMiss({ pr: '7', file: 'src/a.ts', lines: '20-25', description: 'x' }),
    ).rejects.toMatchObject({ code: 'refused', message: expect.stringContaining('src/a.ts:20-25') })
    await expect(
      s.h.sup.recordMiss({ pr: '7', file: 'src/b.ts', lines: '10', description: 'x' }),
    ).rejects.toMatchObject({ code: 'refused', message: expect.stringContaining('src/b.ts:10') })
    expect(existsSync(join(dir, 'reviewer'))).toBe(false)
  })

  test('accepts a range that includes context lines around an added line', async () => {
    const s = setup({ diff: PATCH('src/a.ts', 10, 1) })
    opened(s)
    const path = await s.h.sup.recordMiss({ pr: '7', file: 'src/a.ts', lines: '8-14', description: 'x' })
    expect(JSON.parse(readFileSync(path, 'utf8')).lines).toBe('8-14')
  })

  test('refuses a PR no nightshift run produced', async () => {
    const s = setup()
    opened(s)
    await expect(
      s.h.sup.recordMiss({ pr: '8', file: 'src/a.ts', lines: '10', description: 'x' }),
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(
      s.h.sup.recordMiss({ pr: '7', file: 'src/a.ts', lines: '10', description: 'x', repository: 'other' }),
    ).rejects.toMatchObject({ code: 'not_found' })
    expect(existsSync(join(dir, 'reviewer'))).toBe(false)
  })
})
