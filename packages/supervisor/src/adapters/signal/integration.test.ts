import { afterEach, describe, expect, test } from 'bun:test'
import { Supervisor } from '../../index'
import { type Db, openState } from '../../state/db'
import {
  FakeExecutor,
  FakeLinear,
  FakeNotifier,
  FakeOutbox,
  FakeSandbox,
  FakeWorker,
  snapshot,
  testConfig,
} from '../../testing/testing'
import { SignalApi, SignalLink } from './api'
import { SignalInbox } from './inbox'
import { SignalNotifier } from './notifier'
import { SignalReceiver } from './receiver'
import { SignalStore } from './store'
import { API_KEY, BOT, FakeSignalServer, textFrame, until, voteFrame } from './testing'

const cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

async function harness() {
  const server = new FakeSignalServer()
  const config = testConfig()
  const db = openState(':memory:')
  const now = () => new Date('2026-10-04T10:00:00.000Z')
  const linear = new FakeLinear(config, now)
  const executor = new FakeExecutor()
  const api = new SignalApi({ url: server.url, apiKey: async () => API_KEY })
  const link = new SignalLink(api, 'h-cloud admin')
  const store = new SignalStore(db)
  const notifier = new SignalNotifier({
    link,
    store,
    fallback: new FakeNotifier(),
    out: () => {},
    issueUrl: (issue) => `https://linear.app/h-cloud/issue/${issue}`,
  })
  const sup = new Supervisor({
    config,
    db,
    linear,
    executor,
    sandbox: new FakeSandbox(),
    worker: new FakeWorker(),
    notifier,
    outbox: new FakeOutbox(),
    repos: { baseSha: async () => 'base1' },
    agentKind: (a) => (a === 'reviewer' ? 'single_call' : 'worker'),
    modelFor: (agent, profile) => `${profile}/${agent}`,
    now,
    instanceId: 'inst-1',
  })
  const inbox = new SignalInbox({
    link,
    store,
    actions: () => sup,
    user: () => '00000000-0000-4000-8000-000000000001',
    takePairing: () => false,
    out: () => {},
    receiver: (hooks) =>
      new SignalReceiver({ url: async () => api.receiveUrl(BOT), headers: () => api.headers(), ...hooks }),
  })
  cleanup.push(
    () => server.stop(),
    () => inbox.stop(),
  )
  linear.put(snapshot({ identifier: 'FOR-1' }))
  await sup.start()
  await sup.tick()
  const run = sup.runs.forIssue('FOR-1').at(-1)
  if (!run) throw new Error('not dispatched')
  await sup.workerStarted(run.id, { sandbox: 'sb-1', session: 's-1' })
  inbox.start()
  await until(() => server.connects === 1)
  return { server, sup, linear, db, run }
}

const ask = (options?: string[]) => ({
  status: 'NEEDS_CONTEXT',
  summary: 's',
  evidence: [],
  blocker: { needs: 'decision', reason: 'r', question: 'A or B?', ...(options ? { options } : {}) },
})

describe('Signal question round trip', () => {
  test('a worker question reaches the group once; a quote reply answers it and the issue runs again', async () => {
    const h = await harness()
    await h.sup.workerFinished(h.run.id, ask())
    const questions = h.server.sent.filter((r) => String(r.body?.message).includes('A or B?'))
    expect(questions).toHaveLength(1)
    expect(String(questions[0]?.body?.message)).toContain('FOR-1')
    const ts = mapped(h.db)

    h.server.push(textFrame('B', { quote: ts }))
    await until(() => h.server.messages.includes('✓ FOR-1: answered'))
    const sent = h.sup.log.since(null, { types: ['MESSAGE_SENT'] })
    expect(sent.map((e) => e.data)).toEqual([{ text: 'B', by: 'signal', comment: expect.any(String) }])
    const comments = await h.linear.comments('FOR-1')
    expect(comments.some((c) => c.body === 'B' && c.parentId === sent[0]?.data.comment)).toBe(true)

    await h.sup.tick()
    expect(h.sup.log.since(null, { types: ['QUESTION_ANSWERED'] })[0]?.data).toMatchObject({ answer: 'B' })
    expect(h.sup.runs.forIssue('FOR-1')).toHaveLength(2)
  })

  test('a fixed-option question is a poll; the vote answers it and closes the poll', async () => {
    const h = await harness()
    await h.sup.workerFinished(h.run.id, ask(['A', 'B']))
    const poll = h.server.requests.find((r) => r.method === 'POST' && r.path === `/v1/polls/${BOT}`)
    expect(poll?.body).toMatchObject({ question: 'FOR-1: A or B?', answers: ['A', 'B'] })
    const ts = mapped(h.db)

    h.server.push(voteFrame(ts, 0))
    await until(() => h.server.messages.includes('✓ FOR-1: answered "A"'))
    expect(h.server.requests.some((r) => r.method === 'DELETE')).toBe(true)
    expect(h.sup.log.since(null, { types: ['MESSAGE_SENT'] })[0]?.data).toMatchObject({
      text: 'A',
      by: 'signal',
    })
  })
})

function mapped(db: Db): number {
  const raw = db
    .query<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?')
    .get('signal_messages')
  return Number(Object.keys(JSON.parse(raw?.value ?? '{}'))[0])
}
