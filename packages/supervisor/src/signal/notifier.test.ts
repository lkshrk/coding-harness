import { afterEach, describe, expect, test } from 'bun:test'
import { openState } from '../db'
import { FakeNotifier } from '../testing'
import { SignalApi, SignalLink } from './api'
import { messageText, SignalNotifier } from './notifier'
import { SignalReceiver } from './receiver'
import { SignalStore } from './store'
import { API_KEY, FakeSignalServer } from './testing'

let server: FakeSignalServer | undefined
afterEach(() => server?.stop())

function setup() {
  server = new FakeSignalServer()
  const store = new SignalStore(openState(':memory:'))
  const fallback = new FakeNotifier()
  let now = 0
  const notifier = new SignalNotifier({
    link: new SignalLink(new SignalApi({ url: server.url, apiKey: async () => API_KEY }), 'h-cloud admin'),
    store,
    fallback,
    out: () => {},
    issueUrl: (issue) => `https://linear.app/h-cloud/issue/${issue}`,
    now: () => now,
  })
  return { server, store, fallback, notifier, advance: (ms: number) => (now += ms) }
}

describe('SignalNotifier', () => {
  test('one message per event: issue, one line and the Linear link', async () => {
    const s = setup()
    expect(
      await s.notifier.notify({ title: 'XXX-1 needs you: unknown', issue: 'XXX-1', kind: 'failed' }),
    ).toBe('signal')
    expect(s.server.messages).toEqual(['XXX-1 needs you: unknown\nhttps://linear.app/h-cloud/issue/XXX-1'])
    expect(s.store.lookup(1_786_850_001_000)).toMatchObject({ kind: 'failed', issue: 'XXX-1' })
    expect(s.fallback.sent).toHaveLength(1)
  })

  test('duplicates inside the rate-limit window are dropped', async () => {
    const s = setup()
    const n = { title: 'dispatch paused: rbw locked', kind: 'paused' as const }
    await s.notifier.notify(n)
    expect(await s.notifier.notify(n)).toBeNull()
    s.advance(16 * 60_000)
    await s.notifier.notify(n)
    expect(s.server.messages).toHaveLength(2)
  })

  test('a fixed-option question becomes a poll mapped to the question', async () => {
    const s = setup()
    await s.notifier.notify({
      title: 'XXX-1: question for the user: A or B?',
      issue: 'XXX-1',
      kind: 'question',
      question: { comment: 'c9', text: 'A or B?', options: ['A', 'B'] },
    })
    const poll = s.server.requests.find((r) => r.path.startsWith('/v1/polls/'))
    expect(poll?.body).toMatchObject({ question: 'XXX-1: A or B?', answers: ['A', 'B'] })
    expect(s.server.sent).toHaveLength(0)
    expect(s.store.lookup(1_786_850_001_000)).toMatchObject({
      comment: 'c9',
      options: ['A', 'B'],
      poll: true,
    })
  })

  test('an outage degrades to the fallback and marks Signal unavailable', async () => {
    const s = setup()
    s.server.failSend = true
    expect(await s.notifier.notify({ title: 'x', issue: 'XXX-1', kind: 'failed' })).toBeNull()
    expect(s.store.state()).toMatchObject({ state: 'unavailable' })
    expect(s.fallback.sent).toHaveLength(1)
    s.server.failSend = false
    await s.notifier.notify({ title: 'y', kind: 'paused' })
    expect(s.store.state()?.state).toBe('ok')
  })

  test('info and ci notices stay in the log and never reach Signal', async () => {
    const s = setup()
    expect(await s.notifier.notify({ title: 'config rejected: x', kind: 'info' })).toBeNull()
    expect(await s.notifier.notify({ title: 'no kind' })).toBeNull()
    expect(await s.notifier.notify({ title: 'CI passed', issue: 'XXX-1', kind: 'ci' })).toBeNull()
    expect(s.server.messages).toHaveLength(0)
    expect(s.fallback.sent).toHaveLength(3)
  })

  test('repeated failures of one issue send a single message until the window passes', async () => {
    const s = setup()
    await s.notifier.notify({
      title: 'run failed and needs you (unknown)',
      issue: 'XXX-1',
      kind: 'failed',
      context: ['attempt 2'],
    })
    expect(
      await s.notifier.notify({
        title: 'run failed and needs you (unknown)',
        issue: 'XXX-1',
        kind: 'failed',
        context: ['attempt 3'],
      }),
    ).toBeNull()
    expect(await s.notifier.notify({ title: 'other title', issue: 'XXX-1', kind: 'failed' })).toBeNull()
    expect(
      await s.notifier.notify({
        title: 'run failed and needs you (unknown)',
        issue: 'XXX-2',
        kind: 'failed',
      }),
    ).toBe('signal')
    s.advance(6 * 60 * 60_000)
    expect(
      await s.notifier.notify({
        title: 'run failed and needs you (unknown)',
        issue: 'XXX-1',
        kind: 'failed',
      }),
    ).toBe('signal')
    expect(s.server.messages).toHaveLength(3)
  })

  test('questions ask for a quote reply', () => {
    expect(messageText({ title: 'q?', issue: 'XXX-1', kind: 'question' }, () => null)).toBe(
      'XXX-1: q?\n→ Quote this message to answer.',
    )
  })

  test('a message that needs the user carries the issue title, context lines and the next action', () => {
    const text = messageText(
      {
        title: 'PR #170 ready for review',
        issue: 'ROU-570',
        subject: 'Stop replacement view swaps before alternatives are ready',
        kind: 'pr',
        url: 'https://github.com/o/r/pull/170',
        context: ['three placeholder rows while loading', '', 'gates: lint ✓, test ✓', 'x'.repeat(300)],
        action: 'Review and merge PR #170',
      },
      () => null,
    )
    expect(text.split('\n')).toEqual([
      'ROU-570 · Stop replacement view swaps before alternatives are ready',
      'PR #170 ready for review',
      '• three placeholder rows while loading',
      '• gates: lint ✓, test ✓',
      `• ${'x'.repeat(219)}…`,
      '→ Review and merge PR #170',
      'https://github.com/o/r/pull/170',
    ])
  })
})

describe('SignalReceiver backoff', () => {
  test('grows exponentially with jitter and is capped', () => {
    const r = new SignalReceiver({
      url: async () => '',
      headers: async () => ({}),
      onFrame: () => {},
      onOpen: () => {},
      onDown: () => {},
      random: () => 0,
    })
    expect([1, 2, 3].map((n) => r.backoff(n))).toEqual([125, 250, 500])
    expect(r.backoff(30)).toBe(15_000)
  })
})
