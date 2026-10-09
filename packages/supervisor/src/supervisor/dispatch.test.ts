import { describe, expect, test } from 'bun:test'

import { dispatchOne, harness } from './testing'

describe('manual retry', () => {
  async function failedWithCommit(h: ReturnType<typeof harness>) {
    const run = await dispatchOne(h)
    await h.sup.workerStarted(run.id, { sandbox: 'sb', session: 's' })
    await h.sup.headImported(run.id, 'head1')
    await h.sup.workerFailed(run.id, 'crash', 'segfault')
    expect(h.sup.runs.get(run.id)?.failure).toBe('unknown')
    return run
  }

  test('--continue resumes from the commit of a failed attempt whatever its failure class', async () => {
    let bases = 0
    const h = harness({ repos: { baseSha: async () => `base${++bases}` } })
    const first = await failedWithCommit(h)
    const next = await h.sup.retryRun('FOR-1', { continue: true }, 'cli')
    expect(next).toMatchObject({ attempt: 2, baseSha: 'base1' })
    expect(h.executor.starts.at(-1)?.repairFrom).toEqual({ run: first.id, headSha: 'head1' })
    expect(h.of('DISPATCHED').at(-1)?.data).toMatchObject({ continues: first.id, reason: 'manual retry' })
  })

  test('--continue skips later attempts without a commit and uses the latest one that has one', async () => {
    let bases = 0
    const h = harness({ repos: { baseSha: async () => `base${++bases}` } })
    const first = await failedWithCommit(h)
    const second = await h.sup.retryRun('FOR-1', {}, 'cli')
    await h.sup.workerFailed(second.id, 'crash', 'segfault')
    const third = await h.sup.retryRun('FOR-1', { continue: true }, 'cli')
    expect(third).toMatchObject({ attempt: 3, baseSha: 'base1' })
    expect(h.executor.starts.at(-1)?.repairFrom).toEqual({ run: first.id, headSha: 'head1' })
  })

  test('--continue is refused when no earlier attempt has a commit', async () => {
    const h = harness()
    const run = await dispatchOne(h)
    await h.sup.workerFailed(run.id, 'crash', 'segfault')
    await expect(h.sup.retryRun('FOR-1', { continue: true }, 'cli')).rejects.toMatchObject({
      code: 'refused',
      message: 'FOR-1: no earlier attempt has a commit to continue from',
    })
    expect(h.sup.runs.forIssue('FOR-1').length).toBe(1)
  })

  async function runningWithCommit(h: ReturnType<typeof harness>) {
    const run = await dispatchOne(h)
    h.sandbox.add(run.id)
    await h.sup.workerStarted(run.id, { sandbox: `sb-${run.id}`, session: 's-1' })
    h.executor.heads.set(run.id, 'head1')
    return run
  }

  const exits: [string, (h: ReturnType<typeof harness>, id: string) => Promise<void>][] = [
    [
      'BLOCKED finish',
      (h, id) =>
        h.sup.workerFinished(id, {
          status: 'BLOCKED',
          summary: 's',
          evidence: [{ kind: 'test', ref: 't', result: 'pass' }],
          blocker: { needs: 'decision', reason: 'r' },
        }),
    ],
    ['step limit', (h, id) => h.sup.workerFailed(id, 'step_cap')],
    ['time limit', (h, id) => h.sup.workerFailed(id, 'time_cap')],
    [
      'stall',
      async (h, id) => {
        await h.sup.workerStalled(id, 'no_tool_calls')
        await h.sup.workerStalled(id, 'no_tool_calls')
      },
    ],
    ['supervisor stop', (h, id) => h.sup.stopRun(id, 'issue changed in Linear')],
  ]

  test.each(exits)('a run ending by %s records its commit and --continue resumes from it', async (_, end) => {
    let bases = 0
    const h = harness({ repos: { baseSha: async () => `base${++bases}` } })
    const run = await runningWithCommit(h)
    await end(h, run.id)
    expect(h.sup.runs.get(run.id)?.headSha).toBe('head1')
    expect(h.executor.calls.find((c) => c.op === 'captureHead')).toEqual({
      op: 'captureHead',
      run: run.id,
      detail: `sb-${run.id}`,
    })
    h.linear.patch('FOR-1', { status: 'Todo', labels: ['ai-stage:implementation'] })
    const next = await h.sup.retryRun('FOR-1', { continue: true }, 'cli')
    expect(next).toMatchObject({ attempt: 2, baseSha: 'base1' })
    expect(h.executor.starts.at(-1)?.repairFrom).toEqual({ run: run.id, headSha: 'head1' })
  })

  test('a run ending on a limit passes its cause to the capture and logs the WIP commit', async () => {
    const h = harness()
    const run = await runningWithCommit(h)
    const sha = 'a'.repeat(40)
    const statuses: (string | undefined)[] = []
    h.executor.captureHead = async (r, status) => {
      statuses.push(status)
      await h.sup.wipCommitted(r.id, { sha, lines: 12 })
      return sha
    }
    await h.sup.workerFailed(run.id, 'step_cap')
    expect(statuses).toEqual(['step_cap'])
    expect(h.of('WIP_COMMITTED').map((e) => [e.issue, e.run, e.data])).toEqual([
      ['FOR-1', run.id, { run: run.id, sha, lines: 12 }],
    ])
  })

  test('a supervisor stop captures the commit before the sandbox is destroyed', async () => {
    const h = harness()
    const run = await runningWithCommit(h)
    let alive: boolean | undefined
    h.executor.captureHead = async (r) => {
      alive = h.sandbox.sandboxes.has(`sb-${r.id}`)
      return 'head1'
    }
    await h.sup.stopRun(run.id, 'retry requested')
    expect(alive).toBe(true)
    expect(h.sandbox.destroyed).toEqual([`sb-${run.id}`])
    expect(h.sup.runs.get(run.id)?.headSha).toBe('head1')
  })

  test('a failed run without commits keeps a null head and --continue is refused', async () => {
    const h = harness()
    const run = await dispatchOne(h)
    await h.sup.workerStarted(run.id, { sandbox: `sb-${run.id}`, session: 's-1' })
    await h.sup.workerFailed(run.id, 'step_cap')
    expect(h.sup.runs.get(run.id)?.headSha).toBeNull()
    await expect(h.sup.retryRun('FOR-1', { continue: true }, 'cli')).rejects.toMatchObject({
      code: 'refused',
    })
  })

  test('a plain retry after a failure with a commit starts fresh from the current base', async () => {
    let bases = 0
    const h = harness({ repos: { baseSha: async () => `base${++bases}` } })
    await failedWithCommit(h)
    const next = await h.sup.retryRun('FOR-1', {}, 'cli')
    expect(next).toMatchObject({ attempt: 2, baseSha: 'base2' })
    expect(h.executor.starts.at(-1)?.repairFrom).toBeUndefined()
    expect(h.of('DISPATCHED').at(-1)?.data).not.toHaveProperty('continues')
  })
})
