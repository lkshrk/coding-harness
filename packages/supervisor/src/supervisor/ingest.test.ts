import { describe, expect, test } from 'bun:test'
import { snapshot } from '../testing/testing'
import { harness } from './testing'

describe('vault ingest lifecycle', () => {
  function setup() {
    const prepared: unknown[] = []
    const published: string[] = []
    const ingest = {
      prepare: async (input: unknown) => {
        prepared.push(input)
        return {
          repository: 'nightshift-vault',
          baseSha: 'vault-base',
          files: ['raw/linear/2026-10-04-FOR-1.md'],
          sourceFiles: [{ path: 'raw/linear/2026-10-04-FOR-1.md', content: 'source' }],
        }
      },
      publish: async (run: { id: string }) => {
        published.push(run.id)
        return ['vault-commit']
      },
    }
    const h = harness({ ingest })
    h.config.stages.acceptance = { automatic: true, human_checkpoint: 'none' }
    h.linear.put(snapshot({ identifier: 'FOR-1', status: 'Done', labels: ['ai-stage:acceptance'] }))
    return { ...h, ingest, prepared, published }
  }

  test.each(['feature', 'improvement', 'bug', 'chore'])(
    'last stage ingests once for %s',
    async (pipeline) => {
      const h = setup()
      h.config.pipelines[pipeline] = ['implementation', 'acceptance']
      h.linear.patch('FOR-1', { labels: ['ai-stage:acceptance', `type:${pipeline}`] })
      await h.sup.start()
      await Promise.all([h.sup.completeStage('FOR-1'), h.sup.completeStage('FOR-1')])
      expect(h.prepared).toHaveLength(1)
      expect(h.executor.starts).toHaveLength(1)
      expect(h.executor.starts[0]).toMatchObject({
        run: { agent: 'ingester', repository: 'nightshift-vault', state: 'starting' },
        files: ['raw/linear/2026-10-04-FOR-1.md'],
        sourceFiles: [{ path: 'raw/linear/2026-10-04-FOR-1.md', content: 'source' }],
      })
      await h.sup.tick()
      expect(h.executor.ops('stop')).toEqual([])
      expect(h.linear.get('FOR-1').status).toBe('Done')
    },
  )

  test('non-final and disabled closeout start no ingest', async () => {
    const h = setup()
    await h.sup.start()
    h.linear.patch('FOR-1', { labels: ['ai-stage:verification'] })
    await h.sup.completeStage('FOR-1')
    h.config.stages.closeout = { automatic: true, human_checkpoint: 'none', ingest: false }
    h.linear.patch('FOR-1', { labels: ['ai-stage:acceptance'] })
    await h.sup.completeStage('FOR-1')
    expect(h.prepared).toEqual([])
    expect(h.executor.starts).toEqual([])
  })

  test('publishes success and restart never repeats a completed ingest', async () => {
    const h = setup()
    await h.sup.start()
    await h.sup.completeStage('FOR-1')
    const run = h.executor.starts[0]?.run
    if (!run) throw new Error('ingester not started')
    await h.sup.workerStarted(run.id, { sandbox: 'vault-sandbox', session: 'vault-session' })
    await h.sup.workerFinished(run.id, {
      status: 'DONE',
      summary: 'Ingested',
      evidence: [{ kind: 'command', ref: 'bun scripts/lint.ts', result: 'pass' }],
    })
    expect(h.published).toEqual([run.id])
    expect(h.of('VAULT_INGESTED')[0]?.data).toEqual({ commits: ['vault-commit'] })
    expect(h.sup.runs.get(run.id)?.state).toBe('done')
    const restarted = h.make()
    await restarted.start()
    await restarted.completeStage('FOR-1')
    expect(h.executor.starts).toHaveLength(1)
    expect(h.sup.awaiting('FOR-1')).toBeNull()
    expect(h.linear.updates).toEqual([])
  })

  test.each(['blocked', 'crash', 'publish'])('%s failure only logs and notifies once', async (failure) => {
    const h = setup()
    await h.sup.start()
    await h.sup.completeStage('FOR-1')
    const run = h.executor.starts[0]?.run
    if (!run) throw new Error('ingester not started')
    await h.sup.workerStarted(run.id, { sandbox: 'vault-sandbox', session: 'vault-session' })
    if (failure === 'crash') await h.sup.workerFailed(run.id, 'sandbox_error', 'missing tooling')
    else {
      if (failure === 'publish')
        h.ingest.publish = async () => {
          throw new Error('push rejected')
        }
      await h.sup.workerFinished(
        run.id,
        failure === 'blocked'
          ? {
              status: 'BLOCKED',
              summary: 'No lint',
              blocker: { needs: 'environment', reason: 'missing tooling' },
            }
          : {
              status: 'DONE',
              summary: 'Ingested',
              evidence: [{ kind: 'command', ref: 'bun scripts/lint.ts', result: 'pass' }],
            },
      )
    }
    await h.sup.workerFailed(run.id, 'crash', 'duplicate callback')
    expect(h.of('VAULT_INGEST_FAILED')).toHaveLength(1)
    expect(h.notifier.sent.filter((n) => n.kind === 'info')).toHaveLength(1)
    expect(h.of('FAILURE_CLASSIFIED')).toEqual([])
    expect(h.linear.updates).toEqual([])
    expect(h.linear.get('FOR-1').status).toBe('Done')
    expect(h.sup.awaiting('FOR-1')).toBeNull()
    const restarted = h.make()
    await restarted.start()
    await restarted.completeStage('FOR-1')
    expect(h.executor.starts).toHaveLength(1)
  })

  test('preparation failure and interrupted starts are not retried', async () => {
    const h = setup()
    h.ingest.prepare = async () => {
      throw new Error('vault missing')
    }
    await h.sup.start()
    await h.sup.completeStage('FOR-1')
    expect(h.of('VAULT_INGEST_FAILED')).toHaveLength(1)
    const restarted = h.make()
    await restarted.start()
    await restarted.completeStage('FOR-1')
    expect(h.executor.starts).toEqual([])
    expect(h.linear.updates).toEqual([])
  })

  test('restart of active ingest fails it without changing issue or starting another', async () => {
    const h = setup()
    await h.sup.start()
    await h.sup.completeStage('FOR-1')
    const restarted = h.make()
    await restarted.start()
    await restarted.completeStage('FOR-1')
    expect(h.executor.starts).toHaveLength(1)
    expect(h.of('VAULT_INGEST_FAILED')).toHaveLength(1)
    expect(h.linear.updates).toEqual([])
    expect(restarted.awaiting('FOR-1')).toBeNull()
  })
})
