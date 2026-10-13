import { describe, expect, test } from 'bun:test'
import type { LeadQuestion, LeadReply } from '../ports'
import { dispatchOne, harness } from './testing'

function fakeLead() {
  const asked: LeadQuestion[] = []
  const pending: ((r: LeadReply | null) => void)[] = []
  return {
    asked,
    reply: async (r: LeadReply | null) => {
      pending.shift()?.(r)
      await Bun.sleep(0)
    },
    advisor: {
      ask: (q: LeadQuestion) => {
        asked.push(q)
        return new Promise<LeadReply | null>((resolve) => pending.push(resolve))
      },
    },
  }
}

async function askLead(h: ReturnType<typeof harness>, needs = 'context') {
  const run = await dispatchOne(h)
  await h.sup.workerStarted(run.id, { sandbox: 'sb-1', session: 's-1' })
  await h.sup.workerFinished(run.id, {
    status: needs === 'decision' ? 'BLOCKED' : 'NEEDS_CONTEXT',
    summary: 'missing',
    evidence: [],
    blocker: { needs, reason: 'which API?', question: 'Which API version?', options: ['v1', 'v2'] },
  })
  return { run, comment: String(h.of('QUESTION_ASKED')[0]?.data.comment) }
}

const questionsSent = (h: ReturnType<typeof harness>) => h.notifier.sent.filter((n) => n.kind === 'question')

describe('questions', () => {
  test('NEEDS_CONTEXT fails the run, asks the lead, and runs no gate', async () => {
    const h = harness()
    const run = await dispatchOne(h)
    await h.sup.workerStarted(run.id, { sandbox: 'sb-1', session: 's-1' })
    await h.sup.workerFinished(run.id, {
      status: 'NEEDS_CONTEXT',
      summary: 'missing',
      evidence: [],
      blocker: { needs: 'context', reason: 'which API?', question: 'Which API version?' },
    })
    expect(h.sup.runs.get(run.id)?.state).toBe('failed')
    expect(h.of('QUESTION_ASKED')[0]?.data).toMatchObject({ to: 'lead', question: 'Which API version?' })
    expect(h.executor.ops('runStep')).toEqual([])
    expect(h.linear.get('FOR-1')).toMatchObject({ status: 'Blocked', labels: ['ai-stage:implementation'] })
    expect(h.db.query('SELECT asked_to FROM questions').all()).toEqual([{ asked_to: 'lead' }])
  })

  test('an answer posted while nightshift was down emits QUESTION_ANSWERED', async () => {
    const h = harness()
    const run = await dispatchOne(h)
    await h.sup.workerStarted(run.id, { sandbox: 'sb-x', session: 's-1' })
    await h.sup.workerFinished(run.id, {
      status: 'NEEDS_CONTEXT',
      summary: 's',
      evidence: [],
      blocker: { needs: 'decision', reason: 'r', question: 'A or B?' },
    })
    const asked = h.of('QUESTION_ASKED')[0]
    expect(asked?.data).toMatchObject({ to: 'user' })
    h.linear.reply('FOR-1', String(asked?.data.comment), 'B')
    const restarted = h.make({ instanceId: 'inst-2' })
    const report = await restarted.start()
    expect(report.answered).toEqual(['FOR-1'])
    expect(h.of('QUESTION_ANSWERED', restarted)[0]?.data).toEqual({
      comment: asked?.data.comment,
      answer: 'B',
      by: 'you',
    })
  })

  test('a context question is answered by the lead, posted as a reply, and resumes the issue without the owner', async () => {
    const lead = fakeLead()
    const h = harness({ lead: lead.advisor })
    const { run, comment } = await askLead(h)
    expect(lead.asked).toEqual([{ issue: 'FOR-1', question: 'Which API version?', options: ['v1', 'v2'] }])
    expect(questionsSent(h)).toEqual([])
    await h.sup.tick()
    expect(lead.asked).toHaveLength(1)
    await lead.reply({ answer: 'Use v2.' })
    const reply = (await h.linear.comments('FOR-1')).find((c) => c.parentId === comment)
    expect(reply?.body).toBe('Use v2.')
    expect(h.of('MESSAGE_SENT').map((e) => [e.run, e.data])).toEqual([
      [run.id, { text: 'Use v2.', by: 'lead', comment }],
    ])
    await h.sup.tick()
    expect(h.of('QUESTION_ANSWERED')[0]?.data).toMatchObject({ comment, answer: 'Use v2.' })
    expect(h.linear.get('FOR-1').status).not.toBe('Blocked')
    expect(questionsSent(h)).toEqual([])
  })

  test('with the lead down the owner is notified and nothing is posted', async () => {
    const lead = fakeLead()
    const h = harness({ lead: lead.advisor })
    const { comment } = await askLead(h)
    await lead.reply(null)
    expect((await h.linear.comments('FOR-1')).filter((c) => c.parentId === comment)).toEqual([])
    expect(questionsSent(h)).toHaveLength(1)
    expect(questionsSent(h)[0]).toMatchObject({
      title: 'question for the lead: Which API version?',
      question: { comment, text: 'Which API version?', options: ['v1', 'v2'] },
    })
    expect(questionsSent(h)[0]?.context?.join('\n')).toContain('lead unavailable')
    expect(h.of('MESSAGE_SENT')).toEqual([])
  })

  test('an ESCALATE reply is not posted; the owner is notified with the reason', async () => {
    const lead = fakeLead()
    const h = harness({ lead: lead.advisor })
    const { comment } = await askLead(h, 'dependency')
    expect(lead.asked).toHaveLength(1)
    await lead.reply({ escalate: 'needs a product call' })
    expect((await h.linear.comments('FOR-1')).filter((c) => c.parentId === comment)).toEqual([])
    expect(questionsSent(h)[0]?.context?.join('\n')).toContain('needs a product call')
  })

  test('when posting the lead answer fails the owner is notified with the answer', async () => {
    const lead = fakeLead()
    const h = harness({ lead: lead.advisor })
    const { comment } = await askLead(h)
    h.linear.comment = async () => {
      throw new Error('rate limited')
    }
    await lead.reply({ answer: 'Use v2.' })
    expect(h.of('MESSAGE_SENT')).toEqual([])
    expect(questionsSent(h)).toHaveLength(1)
    expect(questionsSent(h)[0]?.question?.comment).toBe(comment)
    expect(questionsSent(h)[0]?.context?.join('\n')).toContain('rate limited')
    expect(questionsSent(h)[0]?.context?.join('\n')).toContain('Use v2.')
  })

  test('a decision question is never sent to the lead', async () => {
    const lead = fakeLead()
    const h = harness({ lead: lead.advisor })
    await askLead(h, 'decision')
    await h.sup.tick()
    expect(lead.asked).toEqual([])
    expect(questionsSent(h)).toHaveLength(1)
    expect(questionsSent(h)[0]?.title).toBe('question for the user: Which API version?')
  })

  test('without a lead the owner is notified as before', async () => {
    const h = harness()
    await askLead(h)
    expect(questionsSent(h)).toHaveLength(1)
  })

  test('after a restart an open lead question is forwarded once', async () => {
    const h = harness()
    const { comment } = await askLead(h)
    const lead = fakeLead()
    const restarted = h.make({ instanceId: 'inst-2', lead: lead.advisor })
    await restarted.start()
    await restarted.tick()
    await restarted.tick()
    expect(lead.asked).toEqual([{ issue: 'FOR-1', question: 'Which API version?', options: ['v1', 'v2'] }])
    await lead.reply({ answer: 'v1' })
    expect((await h.linear.comments('FOR-1')).find((c) => c.parentId === comment)?.body).toBe('v1')
  })
})
