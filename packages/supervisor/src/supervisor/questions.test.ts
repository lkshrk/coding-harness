import { describe, expect, test } from 'bun:test'
import { dispatchOne, harness } from './testing'

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
})
