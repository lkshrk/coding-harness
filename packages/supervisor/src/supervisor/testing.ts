import { openState } from '../state/db'
import type { EventType } from '../state/event-schema'
import {
  FakeExecutor,
  FakeLinear,
  FakeNotifier,
  FakeOutbox,
  FakeSandbox,
  FakeWorker,
  issueBody,
  snapshot,
  testConfig,
} from '../testing/testing'
import { Supervisor, type SupervisorDeps } from './supervisor'

const KINDS: Record<string, 'worker' | 'single_call'> = {
  intake: 'single_call',
  reviewer: 'single_call',
  acceptor: 'single_call',
  implementer: 'worker',
  'implementer-strong': 'worker',
  fixer: 'worker',
  repairer: 'worker',
}

export const files = (...f: string[]) => issueBody(f)

export function harness(over: Partial<SupervisorDeps> = {}) {
  let t = Date.parse('2026-10-04T10:00:00.000Z')
  const now = () => new Date(t)
  const config = testConfig()
  const db = openState(':memory:')
  const linear = new FakeLinear(config, now)
  const executor = new FakeExecutor()
  const sandbox = new FakeSandbox()
  const worker = new FakeWorker()
  const notifier = new FakeNotifier()
  const outbox = new FakeOutbox()
  const make = (more: Partial<SupervisorDeps> = {}) =>
    new Supervisor({
      config,
      db,
      linear,
      executor,
      sandbox,
      worker,
      notifier,
      outbox,
      repos: { baseSha: async () => 'base1' },
      agentKind: (a) => KINDS[a],
      modelFor: (agent, profile) => `${profile}/${agent}`,
      now,
      instanceId: 'inst-1',
      retry: { baseMs: 1000, maxMs: 8000 },
      ...over,
      ...more,
    })
  const sup = make()
  const types = (s = sup) => s.log.since(null).map((e) => e.type)
  const of = (type: EventType, s = sup) => s.log.since(null, { types: [type] })
  return {
    sup,
    make,
    config,
    db,
    linear,
    executor,
    sandbox,
    worker,
    notifier,
    outbox,
    types,
    of,
    advance: (ms: number) => (t += ms),
  }
}

export async function dispatchOne(h: ReturnType<typeof harness>, identifier = 'FOR-1') {
  h.linear.put(snapshot({ identifier }))
  await h.sup.start()
  await h.sup.tick()
  const run = h.sup.runs.forIssue(identifier).at(-1)
  if (!run) throw new Error('not dispatched')
  return run
}
