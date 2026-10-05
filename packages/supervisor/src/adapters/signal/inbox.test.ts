import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ControlError } from '../../control/socket/errors'
import { openState } from '../../state/db'
import type { SupervisorStatus } from '../../state/status'
import { SignalApi, SignalLink } from './api'
import { BACK_MESSAGE, type SignalActions, SignalInbox } from './inbox'
import { SignalReceiver } from './receiver'
import { SignalStore, startPairing, takePairing } from './store'
import {
  API_KEY,
  BOT,
  FakeSignalServer,
  frame,
  OTHER_GROUP_RAW,
  OTHER_UUID,
  textFrame,
  USER_UUID,
  until,
  voteFrame,
} from './testing'

const cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

const STATUS: SupervisorStatus = {
  dispatch: 'running',
  restartRequired: false,
  activeProfile: 'default',
  active: [],
  waiting: [],
  questions: [],
  failures: [],
  held: [],
  covered: [],
  linearOrg: null,
}

async function setup(o: { user?: string } = { user: USER_UUID }) {
  const server = new FakeSignalServer()
  const dir = mkdtempSync(join(tmpdir(), 'ns-signal-'))
  const db = openState(':memory:')
  const store = new SignalStore(db)
  const api = new SignalApi({ url: server.url, apiKey: async () => API_KEY })
  const link = new SignalLink(api, 'h-cloud admin')
  const calls: [string, ...unknown[]][] = []
  const record =
    (name: string, result?: unknown) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args])
      if (result instanceof Error) throw result
      return result
    }
  const actions = {
    answerQuestion: record('answerQuestion'),
    sendMessage: record('sendMessage', new ControlError('not_found', 'no active run for XXX-2')),
    pause: (...a: unknown[]) => calls.push(['pause', ...a]),
    resume: (...a: unknown[]) => calls.push(['resume', ...a]),
    hold: (...a: unknown[]) => calls.push(['hold', ...a]),
    unhold: (...a: unknown[]) => calls.push(['unhold', ...a]),
    cover: (...a: unknown[]) => calls.push(['cover', ...a]),
    stopForUser: record('stopForUser', { id: 'run-1', issue: 'XXX-1' }),
    retryRun: record('retryRun', { id: 'run-2', issue: 'XXX-1' }),
    status: () => STATUS,
  } as unknown as SignalActions
  const out: string[] = []
  const inbox = new SignalInbox({
    link,
    store,
    actions: () => actions,
    user: () => o.user,
    takePairing: (code) => takePairing(dir, code),
    out: (l) => out.push(l),
    backQuietMs: 0,
    receiver: (hooks) =>
      new SignalReceiver({
        url: async () => api.receiveUrl(BOT),
        headers: () => api.headers(),
        backoff: { minMs: 10, maxMs: 40 },
        ...hooks,
      }),
  })
  cleanup.push(
    () => server.stop(),
    () => rmSync(dir, { recursive: true, force: true }),
    () => inbox.stop(),
  )
  inbox.start()
  await until(() => server.connects === 1)
  const sentBefore = server.messages.length
  const deliver = async (f: unknown, replies = 1) => {
    const want = server.messages.length + replies
    server.push(f)
    if (replies) await until(() => server.messages.length >= want)
    else {
      await Bun.sleep(50)
      await inbox.idle()
    }
    return server.messages.slice(want - replies)
  }
  return { server, dir, db, store, calls, inbox, out, deliver, sentBefore }
}

describe('allowlist and frame filtering', () => {
  test('typing, receipt and poll-create frames are ignored', async () => {
    const s = await setup()
    for (const name of ['typing_message', 'receipt_message', 'poll_create']) await s.deliver(frame(name), 0)
    expect(s.calls).toEqual([])
    expect(s.server.messages.length).toBe(s.sentBefore)
  })

  test('commands from another sender or another group are ignored', async () => {
    const s = await setup()
    await s.deliver(textFrame('ns pause', { from: OTHER_UUID }), 0)
    await s.deliver(textFrame('ns pause', { group: OTHER_GROUP_RAW }), 0)
    await s.deliver(textFrame('just chatting'), 0)
    expect(s.calls).toEqual([])
  })

  test('nothing is acted on before an account is paired', async () => {
    const s = await setup({})
    expect(s.store.state()?.state).toBe('unpaired')
    await s.deliver(textFrame('ns pause'), 0)
    expect(s.calls).toEqual([])
  })
})

describe('commands', () => {
  test('ns status replies with the status', async () => {
    const s = await setup()
    const [reply] = await s.deliver(textFrame('ns status'))
    expect(reply).toContain('dispatch: running')
    expect(reply).toContain('workers: none')
  })

  test('ns pause and ns resume act with by signal; issue arguments hold and release', async () => {
    const s = await setup()
    expect(await s.deliver(textFrame('ns pause'))).toEqual(['✓ dispatch paused'])
    expect(await s.deliver(textFrame('ns resume'))).toEqual(['✓ dispatch resumed'])
    expect(await s.deliver(textFrame('ns pause xxx-3'))).toEqual(['✓ XXX-3 paused'])
    expect(s.calls).toEqual([
      ['pause', 'paused from Signal', 'signal'],
      ['resume', 'resumed from Signal', 'signal'],
      ['hold', 'XXX-3', 'signal'],
    ])
  })

  test('implement, stop and retry map to the supervisor actions', async () => {
    const s = await setup()
    await s.deliver(textFrame('ns implement XXX-1'))
    await s.deliver(textFrame('ns stop XXX-1'))
    const [retry] = await s.deliver(textFrame('ns retry XXX-1'))
    expect(retry).toBe('✓ dispatched run run-2 for XXX-1')
    expect(s.calls).toEqual([
      ['cover', 'XXX-1', 'signal'],
      ['stopForUser', 'XXX-1', 'stopped from Signal', 'signal'],
      ['retryRun', 'XXX-1', {}, 'signal'],
    ])
  })

  test('unknown commands and bad arguments get short help', async () => {
    const s = await setup()
    expect((await s.deliver(textFrame('ns frobnicate')))[0]).toContain('ns implement <issue>')
    expect(await s.deliver(textFrame('ns stop nope'))).toEqual(['✗ usage: ns stop <issue>'])
  })
})

describe('quote replies', () => {
  test('a quote of a question answers it; a quote of another message goes to the worker', async () => {
    const s = await setup()
    s.store.remember(111, { kind: 'question', issue: 'XXX-1', comment: 'c1' })
    s.store.remember(222, { kind: 'failed', issue: 'XXX-2' })
    expect(await s.deliver(textFrame('B please', { quote: 111 }))).toEqual(['✓ XXX-1: answered'])
    expect(await s.deliver(textFrame('try again', { quote: 222 }))).toEqual([
      '✗ XXX-2: no active run for XXX-2',
    ])
    expect(s.calls).toEqual([
      ['answerQuestion', 'XXX-1', 'B please', 'signal'],
      ['sendMessage', 'XXX-2', 'try again', 'signal'],
    ])
  })

  test('the captured quote-reply shape maps through its quoted timestamp', async () => {
    const s = await setup()
    s.store.remember(1786852650000, { kind: 'question', issue: 'XXX-1', comment: 'c1' })
    await s.deliver(frame('group_quote_reply'))
    expect(s.calls).toEqual([['answerQuestion', 'XXX-1', 'B, keep the old API', 'signal']])
  })
})

describe('polls', () => {
  test("the user's vote answers, closes the poll and is final", async () => {
    const s = await setup()
    s.store.remember(333, {
      kind: 'question',
      issue: 'XXX-1',
      comment: 'c1',
      options: ['A', 'B'],
      poll: true,
    })
    expect(await s.deliver(voteFrame(333, 1))).toEqual(['✓ XXX-1: answered "B"'])
    expect(s.server.requests.find((r) => r.method === 'DELETE')?.body).toMatchObject({
      poll_timestamp: '333',
    })
    await s.deliver(voteFrame(333, 0), 0)
    expect(s.calls).toEqual([['answerQuestion', 'XXX-1', 'B', 'signal']])
  })

  test('votes are attributed by sourceUuid, never by the poll author fields', async () => {
    const s = await setup()
    s.store.remember(444, {
      kind: 'question',
      issue: 'XXX-1',
      comment: 'c1',
      options: ['A', 'B'],
      poll: true,
    })
    await s.deliver(voteFrame(444, 0, OTHER_UUID), 0)
    await s.deliver(voteFrame(555, 0), 0)
    expect(s.calls).toEqual([])
  })
})

describe('pairing', () => {
  test('the first message carrying the pairing code pairs its sender; a wrong code does not', async () => {
    const s = await setup({})
    const { code } = startPairing(s.dir)
    await s.deliver(textFrame('ns pair 000000', { from: OTHER_UUID }), 0)
    expect(s.store.pairedUser()).toBeUndefined()
    const [reply] = await s.deliver(textFrame(`ns pair ${code}`))
    expect(reply).toContain(USER_UUID)
    expect(s.store.pairedUser()).toBe(USER_UUID)
    await s.deliver(textFrame(`ns pair ${code}`, { from: OTHER_UUID }), 0)
    expect(s.store.pairedUser()).toBe(USER_UUID)
    expect(await s.deliver(textFrame('ns pause'))).toEqual(['✓ dispatch paused'])
  })
})

describe('reconnect', () => {
  test('startup and reconnect post nothing to Signal; the restored notice goes to the log', async () => {
    const s = await setup()
    expect(s.server.connects).toBe(1)
    s.server.drop()
    await until(() => s.server.connects === 2 && s.out.some((l) => l.includes(BACK_MESSAGE)))
    expect(s.sentBefore).toBe(0)
    expect(s.server.messages.filter((m) => m === BACK_MESSAGE)).toHaveLength(0)
    expect(s.store.state()?.state).toBe('ok')
    expect(s.out.some((l) => l.includes('receive stream down'))).toBe(true)
    expect(await s.deliver(textFrame('ns resume'))).toEqual(['✓ dispatch resumed'])
  })
})
