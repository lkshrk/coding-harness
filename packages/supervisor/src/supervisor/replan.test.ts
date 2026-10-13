import { describe, expect, test } from 'bun:test'
import { validateIssue } from '@nightshift/core'
import type { ReplanReport } from '../ports'
import { TaskTooLargeError } from '../stages/context'
import { issueBody, snapshot } from '../testing/testing'
import { proposalErrors } from './replan'
import { dispatchOne, harness } from './testing'

const part = (file: string) => issueBody([file])

const split: ReplanReport = {
  action: 'split',
  sub_issues: [
    { title: 'Part A', description: part('src/a.ts') },
    { title: 'Part B', description: part('src/b.ts') },
  ],
  reason: 'step cap after part A',
}

async function proposed(report: ReplanReport = split) {
  let calls = 0
  const h = harness({
    replanner: {
      replan: async () => {
        calls++
        return report
      },
    },
  })
  h.executor.failStart = new TaskTooLargeError('too big')
  h.linear.put(snapshot({ identifier: 'FOR-1', description: issueBody(['src/a.ts', 'src/b.ts']) }))
  await h.sup.start()
  await h.sup.tick()
  const proposal = (await h.linear.comments('FOR-1')).find((c) => c.body.startsWith('Proposal:'))
  if (!proposal) throw new Error('no proposal')
  return { h, proposal, calls: () => calls }
}

describe('replan proposals', () => {
  test('a task_too_large failure posts one proposal and holds the issue as split_proposed', async () => {
    const { h, proposal, calls } = await proposed()
    expect(calls()).toBe(1)
    const bodies = (await h.linear.comments('FOR-1')).map((c) => c.body)
    expect(bodies.filter((b) => b.startsWith('Proposal:')).length).toBe(1)
    expect(proposal.body).toContain('| title | estimate | files | blocks |')
    expect(proposal.body).toContain('| Part A | – | `src/a.ts` | FOR-1 |')
    expect(h.sup.awaiting('FOR-1')).toEqual({ kind: 'split_proposed', stage: 'implementation' })
    expect(h.linear.get('FOR-1').status).toBe('Blocked')
    expect(h.linear.store.size).toBe(1)
    await h.sup.tick()
    expect((await h.linear.comments('FOR-1')).filter((c) => c.body.startsWith('Proposal:')).length).toBe(1)
  })

  test('approving creates the children, each blocking the original and passing the template check', async () => {
    const { h, proposal } = await proposed()
    h.linear.reply('FOR-1', proposal.id, 'approve')
    await h.sup.tick()
    const children = [...h.linear.store.values()].filter((i) => i.parent === 'FOR-1')
    expect(children.map((c) => c.title)).toEqual(['Part A', 'Part B'])
    for (const c of children) expect(validateIssue(c.description)).toMatchObject({ ok: true })
    expect(
      h.linear
        .get('FOR-1')
        .blockedBy.map((b) => b.identifier)
        .sort(),
    ).toEqual(children.map((c) => c.identifier).sort())
    expect(children.every((c) => c.project?.id === h.linear.get('FOR-1').project?.id)).toBe(true)
    expect(h.sup.awaiting('FOR-1')?.kind).toBe('escalated')
  })

  test('approving through ns answer creates the children', async () => {
    const { h } = await proposed()
    await h.sup.answerQuestion('FOR-1', 'approve', 'cli')
    await h.sup.tick()
    expect([...h.linear.store.values()].filter((i) => i.parent === 'FOR-1').length).toBe(2)
  })

  test('a failed creation keeps the proposal and completes on a later tick without duplicates', async () => {
    const { h, proposal } = await proposed()
    let failures = 2
    const createChild = h.linear.createChild.bind(h.linear)
    const addBlocks = h.linear.addBlocks.bind(h.linear)
    h.linear.createChild = async (parent, issue) => {
      if (issue.title === 'Part B' && failures-- > 0) throw new Error('linear: 503')
      return createChild(parent, issue)
    }
    let linkFailures = 1
    h.linear.addBlocks = async (blocker, blocked) => {
      if (linkFailures-- > 0) throw new Error('linear: 502')
      return addBlocks(blocker, blocked)
    }
    h.linear.reply('FOR-1', proposal.id, 'approve')
    await h.sup.tick()
    expect(h.sup.awaiting('FOR-1')?.kind).toBe('split_proposed')
    await h.sup.tick()
    expect(h.sup.awaiting('FOR-1')?.kind).toBe('split_proposed')
    await h.sup.tick()
    const children = [...h.linear.store.values()].filter((i) => i.parent === 'FOR-1')
    expect(children.map((c) => c.title)).toEqual(['Part A', 'Part B'])
    expect(
      h.linear
        .get('FOR-1')
        .blockedBy.map((b) => b.identifier)
        .sort(),
    ).toEqual(children.map((c) => c.identifier).sort())
    expect(h.sup.awaiting('FOR-1')?.kind).toBe('escalated')
    await h.sup.tick()
    expect([...h.linear.store.values()].filter((i) => i.parent === 'FOR-1').length).toBe(2)
    expect((await h.linear.comments('FOR-1')).filter((c) => c.body.startsWith('Created ')).length).toBe(1)
  })

  test('rejecting creates nothing and leaves the issue held', async () => {
    const { h, proposal } = await proposed()
    h.linear.reply('FOR-1', proposal.id, 'reject')
    await h.sup.tick()
    expect(h.linear.store.size).toBe(1)
    expect(h.linear.get('FOR-1').status).toBe('Blocked')
    expect(h.sup.awaiting('FOR-1')?.kind).toBe('escalated')
  })

  test.each(['approve if the tests pass', 'approve?', 'approve, but rename the second'])(
    'a conditional or questioning reply (%s) creates nothing',
    async (reply) => {
      const { h, proposal } = await proposed()
      h.linear.reply('FOR-1', proposal.id, reply)
      await h.sup.tick()
      expect(h.linear.store.size).toBe(1)
      expect(h.sup.awaiting('FOR-1')?.kind).toBe('escalated')
    },
  )

  test('create_blocker is proposed and approved the same way', async () => {
    const { h, proposal } = await proposed({
      action: 'create_blocker',
      blocker: { title: 'Missing API', description: part('src/api.ts') },
      reason: 'needs the API',
    })
    h.linear.reply('FOR-1', proposal.id, 'approve')
    await h.sup.tick()
    expect([...h.linear.store.values()].filter((i) => i.parent === 'FOR-1').map((i) => i.title)).toEqual([
      'Missing API',
    ])
  })

  test('an approved create_blocker parks the issue in Backlog, then Todo once the blocker is Done', async () => {
    const { h, proposal } = await proposed({
      action: 'create_blocker',
      blocker: { title: 'Missing API', description: part('src/api.ts') },
      reason: 'needs the API',
    })
    h.linear.reply('FOR-1', proposal.id, 'approve')
    await h.sup.tick()
    const blockers = [...h.linear.store.values()].filter((i) => i.parent === 'FOR-1')
    expect(blockers.length).toBe(1)
    const blocker = blockers[0]?.identifier as string
    expect(h.linear.get('FOR-1').blockedBy.map((b) => b.identifier)).toEqual([blocker])
    expect(h.linear.get('FOR-1').status).toBe('Backlog')
    expect(h.sup.awaiting('FOR-1')).toBeNull()
    await h.sup.tick()
    expect(h.linear.get('FOR-1').status).toBe('Backlog')
    h.linear.patch(blocker, { status: 'Done' })
    await h.sup.tick()
    expect(h.linear.get('FOR-1').status).toBe('Todo')
  })

  test('a retried create_blocker completion creates no duplicate issue or relation', async () => {
    const { h, proposal } = await proposed({
      action: 'create_blocker',
      blocker: { title: 'Missing API', description: part('src/api.ts') },
      reason: 'needs the API',
    })
    const addBlocks = h.linear.addBlocks.bind(h.linear)
    let linkFailures = 1
    h.linear.addBlocks = async (blocker, blocked) => {
      if (linkFailures-- > 0) throw new Error('linear: 502')
      return addBlocks(blocker, blocked)
    }
    h.linear.reply('FOR-1', proposal.id, 'approve')
    await h.sup.tick()
    await h.sup.tick()
    await h.sup.tick()
    expect(linkFailures).toBeLessThan(0)
    expect([...h.linear.store.values()].filter((i) => i.parent === 'FOR-1').length).toBe(1)
    expect(h.linear.get('FOR-1').blockedBy.length).toBe(1)
    expect(h.linear.get('FOR-1').status).toBe('Backlog')
    expect((await h.linear.comments('FOR-1')).filter((c) => c.body.startsWith('Created ')).length).toBe(1)
  })
})

describe('escalate_lead', () => {
  const lead = (over: Parameters<typeof harness>[0] = {}) =>
    harness({
      classifier: { classify: async () => ({ class: 'architectural_conflict', action: 'escalate_lead' }) },
      ...over,
    })

  async function expectLeadQuestion(h: ReturnType<typeof harness>, reason: string) {
    expect(h.of('QUESTION_ASKED').map((e) => e.data.to)).toEqual(['lead'])
    const bodies = (await h.linear.comments('FOR-1')).map((c) => c.body)
    const questions = bodies.filter((b) => b.startsWith('Question for the lead'))
    expect(questions.length).toBe(1)
    expect(questions[0]).toContain(
      `Design question after attempt 1 (architectural_conflict): ${reason}. How should FOR-1 proceed?`,
    )
    expect(h.db.query('SELECT asked_to FROM questions').all()).toEqual([{ asked_to: 'lead' }])
    expect(h.linear.get('FOR-1').status).toBe('Blocked')
    expect(h.sup.awaiting('FOR-1')?.kind).not.toBe('escalated')
    expect(bodies.some((b) => b.startsWith('Replanner:'))).toBe(false)
  }

  test('a replanner escalate_lead asks the lead instead of escalating to you', async () => {
    const h = lead({
      replanner: { replan: async () => ({ action: 'escalate_lead', reason: 'design open' }) },
    })
    const run = await dispatchOne(h)
    await h.sup.workerFailed(run.id, 'crash')
    await expectLeadQuestion(h, 'design open')
  })

  test('a classified escalate_lead without a replanner asks the lead', async () => {
    const h = lead()
    const run = await dispatchOne(h)
    await h.sup.workerFailed(run.id, 'crash', 'two modules disagree')
    await expectLeadQuestion(h, 'two modules disagree')
  })

  test('a classified escalate_lead with a null replanner report asks the lead', async () => {
    const h = lead({ replanner: { replan: async () => null } })
    const run = await dispatchOne(h)
    await h.sup.workerFailed(run.id, 'crash')
    await expectLeadQuestion(h, 'architectural_conflict')
  })

  test('a reply to the lead question resumes the issue', async () => {
    const h = lead()
    const run = await dispatchOne(h)
    await h.sup.workerFailed(run.id, 'crash')
    const comment = String(h.of('QUESTION_ASKED')[0]?.data.comment)
    h.linear.reply('FOR-1', comment, 'Keep the module boundary.')
    await h.sup.tick()
    expect(h.of('QUESTION_ANSWERED')[0]?.data).toMatchObject({ comment, answer: 'Keep the module boundary.' })
    expect(h.linear.get('FOR-1').status).not.toBe('Blocked')
  })

  test('the lead question is posted once per failure event', async () => {
    const h = lead()
    const run = await dispatchOne(h)
    await h.sup.workerFailed(run.id, 'crash')
    await h.sup.tick()
    const bodies = (await h.linear.comments('FOR-1')).map((c) => c.body)
    expect(bodies.filter((b) => b.startsWith('Question for the lead')).length).toBe(1)
  })

  test('an invalid split proposal still escalates to you', async () => {
    const h = harness({
      replanner: {
        replan: async () => ({
          action: 'split',
          sub_issues: [
            { title: 'a', description: 'no template' },
            { title: 'b', description: 'no template' },
          ],
          reason: 'r',
        }),
      },
    })
    h.executor.failStart = new TaskTooLargeError('too big')
    await dispatchOne(h)
    expect(h.sup.awaiting('FOR-1')).toEqual({ kind: 'escalated', stage: 'implementation' })
    expect(h.of('QUESTION_ASKED')).toEqual([])
  })
})

describe('proposalErrors', () => {
  const original = issueBody(['src/a.ts', 'src/b.ts'])

  test('a split covering the files and criteria is valid', () => {
    expect(proposalErrors(original, split)).toEqual([])
  })

  test('a split must cover every file and criterion of the original', () => {
    const missing: ReplanReport = {
      action: 'split',
      sub_issues: [
        { title: 'A', description: part('src/a.ts') },
        { title: 'A2', description: part('src/a.ts').replace('- it works', '- something else') },
      ],
      reason: 'r',
    }
    expect(proposalErrors(original, missing)).toEqual(['no sub-issue covers file src/b.ts'])
    const noCriterion: ReplanReport = {
      action: 'split',
      sub_issues: [
        { title: 'A', description: part('src/a.ts').replace('- it works', '- x') },
        { title: 'B', description: part('src/b.ts').replace('- it works', '- y') },
      ],
      reason: 'r',
    }
    expect(proposalErrors(original, noCriterion)).toEqual(['no sub-issue covers criterion: it works'])
  })
})
