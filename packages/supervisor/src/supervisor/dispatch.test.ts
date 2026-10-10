import { describe, expect, test } from 'bun:test'

import { snapshot } from '../testing/testing'
import { dispatchOne, harness } from './testing'

describe('role stages without a handler', () => {
  test('a role stage with no handler is logged and held once, not left waiting silently', async () => {
    const h = harness()
    const logged: string[] = []
    const error = console.error
    console.error = (line: string) => logged.push(line)
    try {
      h.linear.put(snapshot({ identifier: 'FOR-1', status: 'Backlog', labels: ['ai-stage:intake'] }))
      await h.sup.start()
      for (let i = 0; i < 3; i++) {
        await h.sup.tick()
        await Bun.sleep(0)
      }
    } finally {
      console.error = error
    }
    expect(h.sup.awaiting('FOR-1')).toEqual({
      kind: 'escalated',
      stage: 'intake',
      reason: 'no handler for stage intake',
    })
    expect(h.linear.get('FOR-1').status).toBe('Blocked')
    expect(logged.filter((l) => l.includes('no handler for stage intake')).length).toBe(1)
    expect(h.notifier.sent.map((n) => [n.issue, n.title])).toEqual([['FOR-1', 'no handler for stage intake']])
  })
})

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

  test('a retry from integration with an open PR goes back to implementation and continues from the PR head', async () => {
    let bases = 0
    const h = harness({ repos: { baseSha: async () => `base${++bases}` } })
    const first = await dispatchOne(h)
    await h.sup.workerStarted(first.id, { sandbox: 'sb', session: 's' })
    await h.sup.workerFinished(first.id, {
      status: 'DONE',
      summary: 's',
      evidence: [{ kind: 'test', ref: 't', result: 'pass' }],
    })
    await h.sup.headImported(first.id, 'head1')
    await h.sup.stopRun(first.id, 'done elsewhere')
    const pr = {
      url: 'https://github.com/lkshrk/omni/pull/1',
      number: 1,
      repository: 'omni',
      repo: 'lkshrk/omni',
      branch: 'ns/FOR-1',
      base: 'main',
      account: 'agent',
      issue: 'FOR-1',
      run: first.id,
      headSha: 'head1',
      mode: 'manual' as const,
      draft: false,
      ci: 'passed' as const,
    }
    h.sup.pullRequests.put(pr)
    h.linear.patch('FOR-1', { status: 'In Review', labels: ['ai-stage:integration'] })

    const next = await h.sup.retryRun('FOR-1', {}, 'cli')
    expect(next).toMatchObject({ attempt: 2, baseSha: 'base1', agent: 'implementer' })
    expect(h.executor.starts.at(-1)?.repairFrom).toEqual({ run: first.id, headSha: 'head1' })
    expect(h.linear.get('FOR-1')).toMatchObject({
      status: 'In Progress',
      labels: ['ai-stage:implementation'],
    })
    await h.sup.tick()
    await h.sup.tick()
    expect(h.sup.runs.get(next.id)?.state).not.toBe('stopped')
    expect(h.of('WORKER_FAILED').filter((e) => e.run === next.id)).toEqual([])
    expect(h.linear.get('FOR-1').status).toBe('In Progress')
    expect(h.sup.pullRequests.get('FOR-1')).toEqual(pr)
  })

  test('--continue with an open PR resumes from the PR head, not a later unpushed attempt', async () => {
    let bases = 0
    const h = harness({ repos: { baseSha: async () => `base${++bases}` } })
    const first = await dispatchOne(h)
    await h.sup.workerStarted(first.id, { sandbox: 'sb', session: 's' })
    await h.sup.workerFinished(first.id, {
      status: 'DONE',
      summary: 's',
      evidence: [{ kind: 'test', ref: 't', result: 'pass' }],
    })
    await h.sup.headImported(first.id, 'head1')
    await h.sup.stopRun(first.id, 'done elsewhere')
    h.sup.pullRequests.put({
      url: 'https://github.com/lkshrk/omni/pull/1',
      number: 1,
      repository: 'omni',
      repo: 'lkshrk/omni',
      branch: 'ns/FOR-1',
      base: 'main',
      account: 'agent',
      issue: 'FOR-1',
      run: first.id,
      headSha: 'head1',
      mode: 'manual',
      draft: false,
      ci: 'passed',
    })
    h.linear.patch('FOR-1', { status: 'In Review', labels: ['ai-stage:integration'] })

    const second = await h.sup.retryRun('FOR-1', {}, 'cli')
    await h.sup.workerStarted(second.id, { sandbox: 'sb2', session: 's2' })
    await h.sup.headImported(second.id, 'head2')
    await h.sup.workerFailed(second.id, 'crash', 'segfault')
    expect(h.sup.runs.get(second.id)?.headSha).toBe('head2')

    const third = await h.sup.retryRun('FOR-1', { continue: true }, 'cli')
    expect(third).toMatchObject({ attempt: 3, baseSha: 'base1' })
    expect(h.executor.starts.at(-1)?.repairFrom).toEqual({ run: first.id, headSha: 'head1' })
    expect(h.of('DISPATCHED').at(-1)?.data).toMatchObject({ continues: first.id })
  })

  test.each([
    ['a plain retry', {}],
    ['--continue', { continue: true }],
  ])('%s with an open PR whose head is not a nightshift attempt is refused', async (_, o) => {
    const h = harness()
    const first = await dispatchOne(h)
    await h.sup.workerStarted(first.id, { sandbox: 'sb', session: 's' })
    await h.sup.headImported(first.id, 'head1')
    await h.sup.workerFailed(first.id, 'crash', 'segfault')
    h.sup.pullRequests.put({
      url: 'https://github.com/lkshrk/omni/pull/1',
      number: 1,
      repository: 'omni',
      repo: 'lkshrk/omni',
      branch: 'ns/FOR-1',
      base: 'main',
      account: 'agent',
      issue: 'FOR-1',
      run: first.id,
      headSha: 'pushed-elsewhere',
      mode: 'manual',
      draft: false,
      ci: 'passed',
    })
    h.linear.patch('FOR-1', { status: 'In Review', labels: ['ai-stage:integration'] })

    await expect(h.sup.retryRun('FOR-1', o, 'cli')).rejects.toMatchObject({
      code: 'refused',
      message:
        'FOR-1: the open PR head pushed-elsewhere is not a nightshift attempt; continuing from a PR head pushed outside nightshift is XXX-293',
    })
    expect(h.sup.runs.forIssue('FOR-1').length).toBe(1)
    expect(h.linear.get('FOR-1')).toMatchObject({ status: 'In Review', labels: ['ai-stage:integration'] })
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
