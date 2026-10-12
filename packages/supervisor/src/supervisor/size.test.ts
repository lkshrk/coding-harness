import { describe, expect, test } from 'bun:test'
import { snapshot } from '../testing/testing'
import { files, harness } from './testing'

const WORKERS = ['implementer', 'fixer', 'repairer', 'explorer']

function sized(limits: { max_estimate?: number; max_files?: number }) {
  const h = harness({ agentKind: (a) => (WORKERS.includes(a) ? 'worker' : 'single_call') })
  ;(h.config.profiles.default as { limits?: Record<string, unknown> }).limits = limits
  return h
}

describe('size gate on dispatch', () => {
  test('an oversized feature is not dispatched and goes back to decomposition', async () => {
    const h = sized({ max_estimate: 5 })
    h.linear.put(snapshot({ identifier: 'FOR-1', estimate: 8 }))
    await h.sup.start()
    const report = await h.sup.tick()
    expect(report.dispatched).toEqual([])
    expect(h.sup.runs.forIssue('FOR-1')).toEqual([])
    expect(h.linear.get('FOR-1').labels).toContain('ai-stage:decomposition')
    expect(h.of('SIZE_CHECKED').map((e) => e.data)).toEqual([
      expect.objectContaining({ over: ['estimate 8 > 5'], decision: 'decomposition', profile: 'default' }),
    ])
  })

  test('an oversized bug is held as too_large with the signals named, and --force-size dispatches it once', async () => {
    const h = sized({ max_files: 2 })
    h.linear.put(
      snapshot({
        identifier: 'FOR-1',
        project: null,
        labels: ['bug', 'ai-stage:implementation', 'repo:omni'],
        description: files('src/sync/', 'src/a.ts'),
      }),
    )
    await h.sup.start()
    await h.sup.tick()
    expect(h.sup.runs.forIssue('FOR-1')).toEqual([])
    expect(h.sup.awaiting('FOR-1')).toEqual({
      kind: 'too_large',
      stage: 'implementation',
      reason: 'files 4 > 2',
    })
    expect(h.linear.get('FOR-1').status).toBe('Blocked')
    const comments = await h.linear.comments('FOR-1')
    expect(comments.at(-1)?.body).toContain('files 4 > 2')
    expect(comments.at(-1)?.body).toContain('ns retry --force-size FOR-1')

    const checked = h.of('SIZE_CHECKED').length
    await expect(h.sup.retryRun('FOR-1', {}, 'cli')).rejects.toThrow('too large')
    expect(h.of('SIZE_CHECKED').length).toBe(checked + 1)
    expect(h.of('SIZE_CHECKED').at(-1)?.data).toMatchObject({ over: ['files 4 > 2'], decision: 'too_large' })
    const run = await h.sup.retryRun('FOR-1', { forceSize: true }, 'cli')
    expect(h.sup.runs.forIssue('FOR-1').map((r) => r.id)).toEqual([run.id])
    expect(h.of('SIZE_CHECKED').at(-1)?.data).toMatchObject({ decision: 'forced' })
  })

  test('an issue under the limits dispatches as before and logs SIZE_CHECKED', async () => {
    const h = sized({ max_estimate: 5, max_files: 8 })
    h.linear.put(snapshot({ identifier: 'FOR-1', estimate: 1 }))
    await h.sup.start()
    const report = await h.sup.tick()
    expect(report.dispatched).toEqual(['FOR-1'])
    expect(h.sup.runs.forIssue('FOR-1').map((r) => r.agent)).toEqual(['implementer'])
    expect(h.of('SIZE_CHECKED').map((e) => e.data)).toEqual([
      expect.objectContaining({ estimate: 1, files: 1, over: [], near: false, decision: 'dispatch' }),
    ])
  })

  test('a feature near the limit gets one explorer run before its first implementer run', async () => {
    const h = sized({ max_estimate: 5 })
    h.linear.put(snapshot({ identifier: 'FOR-1', estimate: 4 }))
    await h.sup.start()
    await h.sup.tick()
    const [explorer] = h.sup.runs.forIssue('FOR-1')
    expect(explorer?.agent).toBe('explorer')
    expect(h.of('SIZE_CHECKED').at(-1)?.data).toMatchObject({ near: true, decision: 'explore' })
    if (!explorer) throw new Error('no run')
    await h.sup.workerStarted(explorer.id, { sandbox: 'sb-1', session: 's-1' })
    await h.sup.workerFinished(explorer.id, {
      status: 'DONE',
      summary: 'mapped',
      evidence: [{ kind: 'file', ref: 'src/a.ts', result: 'info' }],
      report: {
        files: [{ path: 'src/a.ts', why: 'entry point' }],
        symbols: [],
        facts: [],
        open_questions: [],
        size_estimate: 3,
      },
    })
    expect(h.sup.runs.get(explorer.id)?.state).toBe('done')
    expect(h.of('SIZE_CHECKED').at(-1)?.data).toMatchObject({ explorer_estimate: 3 })
    expect(h.linear.get('FOR-1').status).toBe('Todo')
    await h.sup.tick()
    expect(h.sup.runs.forIssue('FOR-1').map((r) => r.agent)).toEqual(['explorer', 'implementer'])
  })

  test('an earlier ingest run does not skip the explorer on a near-limit feature', async () => {
    const h = sized({ max_estimate: 5 })
    h.linear.put(snapshot({ identifier: 'FOR-1', estimate: 4 }))
    await h.sup.start()
    const ingest = h.sup.runs.create({
      issue: 'FOR-1',
      agent: 'ingester',
      profile: 'default',
      model: 'm',
      repository: 'omni',
      baseSha: 'base',
      attempt: 1,
    })
    await h.sup.stopRun(ingest.id, 'ingested', { keepWork: false })
    const run = await h.sup.retryRun('FOR-1', {}, 'cli')
    expect(run.agent).toBe('explorer')
  })

  test('a manual retry of a near-limit feature runs the explorer before its first implementer run', async () => {
    const h = sized({ max_estimate: 5 })
    h.linear.put(snapshot({ identifier: 'FOR-1', estimate: 4 }))
    await h.sup.start()
    const run = await h.sup.retryRun('FOR-1', {}, 'cli')
    expect(run.agent).toBe('explorer')
    expect(h.of('SIZE_CHECKED').at(-1)?.data).toMatchObject({ near: true, decision: 'explore' })
  })

  test('a manual retry naming the implementer still runs the explorer first on a near-limit feature', async () => {
    const h = sized({ max_estimate: 5 })
    h.linear.put(snapshot({ identifier: 'FOR-1', estimate: 4 }))
    await h.sup.start()
    const run = await h.sup.retryRun('FOR-1', { agent: 'implementer' }, 'cli')
    expect(run.agent).toBe('explorer')
    expect(h.of('SIZE_CHECKED').at(-1)?.data).toMatchObject({ near: true, decision: 'explore' })
  })

  test('a manual retry under another profile logs SIZE_CHECKED with that profile', async () => {
    const h = sized({ max_estimate: 5 })
    const profiles = h.config.profiles as Record<string, unknown>
    profiles.big = { ...(profiles.default as object), limits: { max_estimate: 20 } }
    h.linear.put(snapshot({ identifier: 'FOR-1', estimate: 8 }))
    await h.sup.start()
    await expect(h.sup.retryRun('FOR-1', {}, 'cli')).rejects.toThrow('too large')
    expect(h.of('SIZE_CHECKED').at(-1)?.data).toMatchObject({ profile: 'default', decision: 'too_large' })
    const run = await h.sup.retryRun('FOR-1', { profile: 'big' }, 'cli')
    expect(run.profile).toBe('big')
    expect(h.of('SIZE_CHECKED').at(-1)?.data).toMatchObject({
      profile: 'big',
      over: [],
      decision: 'dispatch',
    })
  })
})
