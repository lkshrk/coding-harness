import { describe, expect, test } from 'bun:test'
import { SecretLockedError, SecretResolver } from '@nightshift/core'
import { openState } from '../state/db'
import { Supervisor } from '../supervisor/supervisor'
import {
  FakeExecutor,
  FakeLinear,
  FakeNotifier,
  FakeOutbox,
  FakeSandbox,
  FakeWorker,
  snapshot,
  testConfig,
} from '../testing/testing'

function harness() {
  const now = () => new Date('2026-10-04T10:00:00.000Z')
  const config = testConfig()
  const linear = new FakeLinear(config, now)
  const notifier = new FakeNotifier()
  const vault = { unlocked: false, probes: 0 }
  const resolver = new SecretResolver({
    env: {},
    run: async (cmd) => {
      if (cmd[1] === 'unlocked') {
        vault.probes++
        return { exitCode: vault.unlocked ? 0 : 1, stdout: '', stderr: '' }
      }
      return { exitCode: 0, stdout: 'value\n', stderr: '' }
    },
  })
  const sup = new Supervisor({
    config,
    db: openState(':memory:'),
    linear,
    executor: new FakeExecutor(),
    sandbox: new FakeSandbox(),
    worker: new FakeWorker(),
    notifier,
    outbox: new FakeOutbox(),
    repos: { baseSha: async () => 'base1' },
    agentKind: () => 'worker',
    modelFor: (agent, profile) => `${profile}/${agent}`,
    secretsLocked: () => resolver.locked(),
    now,
    instanceId: 'inst-1',
  })
  const events = (type: string) => sup.log.since(null).filter((e) => e.type === type)
  return { sup, linear, notifier, vault, resolver, events }
}

describe('a locked rbw profile', () => {
  test('pauses dispatch without creating a run and notifies once', async () => {
    const h = harness()
    await expect(h.resolver.resolve('rbw:llm-gateway')).rejects.toBeInstanceOf(SecretLockedError)
    h.linear.put(snapshot({ identifier: 'FOR-1' }))
    await h.sup.start()
    expect((await h.sup.tick()).dispatched).toEqual([])
    expect((await h.sup.tick()).waiting).toContainEqual({ identifier: 'FOR-1', reason: 'dispatch paused' })
    expect(h.sup.runs.forIssue('FOR-1')).toEqual([])
    expect(h.events('DISPATCH_PAUSED').map((e) => e.data)).toEqual([
      { reason: 'rbw locked', by: 'supervisor' },
    ])
    expect(h.notifier.sent).toHaveLength(1)
    expect(h.notifier.sent[0]?.title).toContain('RBW_PROFILE=nightshift rbw unlock')
    expect(h.events('NOTIFICATION_SENT')).toHaveLength(1)
    expect(h.sup.status().dispatch).toBe('paused')
  })

  test('resumes on the next tick once unlocked and dispatches', async () => {
    const h = harness()
    h.linear.put(snapshot({ identifier: 'FOR-1' }))
    await h.sup.start()
    await h.sup.tick()
    h.vault.unlocked = true
    expect((await h.sup.tick()).dispatched).toEqual(['FOR-1'])
    expect(h.events('DISPATCH_RESUMED').map((e) => e.data)).toEqual([
      { reason: 'rbw unlocked', by: 'supervisor' },
    ])
    expect(h.notifier.sent).toHaveLength(1)
  })

  test('a pause set by hand is not resumed by an unlock', async () => {
    const h = harness()
    h.vault.unlocked = true
    h.linear.put(snapshot({ identifier: 'FOR-1' }))
    await h.sup.start()
    h.sup.pause('ns pause')
    expect((await h.sup.tick()).dispatched).toEqual([])
    expect(h.events('DISPATCH_RESUMED')).toEqual([])
    expect(h.events('DISPATCH_PAUSED').map((e) => e.data)).toEqual([{ reason: 'ns pause', by: 'cli' }])
  })

  test('is not probed while nothing is ready to dispatch', async () => {
    const h = harness()
    await h.sup.start()
    await h.sup.tick()
    expect(h.vault.probes).toBe(0)
    expect(h.events('DISPATCH_PAUSED')).toEqual([])
  })

  test('the pause survives a restart and still resumes on unlock', async () => {
    const h = harness()
    h.linear.put(snapshot({ identifier: 'FOR-1' }))
    await h.sup.start()
    await h.sup.tick()
    await h.sup.start()
    h.vault.unlocked = true
    expect((await h.sup.tick()).dispatched).toEqual(['FOR-1'])
  })
})
