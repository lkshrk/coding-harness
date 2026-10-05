import { afterEach, describe, expect, test } from 'bun:test'
import { resolveTarget, SignalApi, SignalApiError } from './api'
import { groupRecipient } from './envelope'
import { API_KEY, BOT, FakeSignalServer, GROUP_RAW } from './testing'

let server: FakeSignalServer
afterEach(() => server?.stop())

function api(key = API_KEY): SignalApi {
  server ??= new FakeSignalServer()
  return new SignalApi({ url: `${server.url}/`, apiKey: async () => key })
}

function fresh(): SignalApi {
  server = new FakeSignalServer()
  return api()
}

describe('send', () => {
  test('accepts the 0.100 object response and the later array response', async () => {
    const a = fresh()
    const first = await a.send(BOT, groupRecipient(GROUP_RAW), 'one')
    server.sendShape = 'array'
    const second = await a.send(BOT, groupRecipient(GROUP_RAW), 'two')
    expect(second).toBeGreaterThan(first)
    expect(server.sent[0]?.body).toEqual({
      number: BOT,
      recipients: [groupRecipient(GROUP_RAW)],
      message: 'one',
    })
  })

  test('a per-recipient failure is an HTTP 400 error', async () => {
    const a = fresh()
    server.failSend = true
    const err = await a.send(BOT, groupRecipient(GROUP_RAW), 'x').catch((e) => e)
    expect(err).toBeInstanceOf(SignalApiError)
    expect((err as SignalApiError).status).toBe(400)
    expect((err as SignalApiError).unauthorized).toBe(false)
  })

  test('a wrong API key is reported as unauthorized without echoing the key', async () => {
    fresh()
    const err = await api('wrong')
      .accounts()
      .catch((e) => e)
    expect((err as SignalApiError).unauthorized).toBe(true)
    expect((err as Error).message).not.toContain('wrong')
  })
})

describe('polls', () => {
  test('create sends answers without multiple selection; close expects 204', async () => {
    const a = fresh()
    const ts = await a.createPoll(BOT, groupRecipient(GROUP_RAW), 'A or B?', ['A', 'B'])
    await a.closePoll(BOT, groupRecipient(GROUP_RAW), ts)
    expect(server.requests.at(-2)?.body).toEqual({
      recipient: groupRecipient(GROUP_RAW),
      question: 'A or B?',
      answers: ['A', 'B'],
      allow_multiple_selections: false,
    })
    expect(server.requests.at(-1)).toMatchObject({ method: 'DELETE', body: { poll_timestamp: String(ts) } })
  })

  test('option count and length are validated before sending', async () => {
    const a = fresh()
    await expect(a.createPoll(BOT, 'group.x', 'q', ['only'])).rejects.toThrow('2-10 options')
    await expect(a.createPoll(BOT, 'group.x', 'q', ['a', 'x'.repeat(101)])).rejects.toThrow('2-10 options')
    expect(server.requests).toHaveLength(0)
  })
})

describe('target', () => {
  test('resolves the single account and the group by name, send id or raw id', async () => {
    const a = fresh()
    for (const group of ['h-cloud admin', groupRecipient(GROUP_RAW), GROUP_RAW]) {
      expect(await resolveTarget(a, group)).toEqual({
        number: BOT,
        recipient: groupRecipient(GROUP_RAW),
        groupId: GROUP_RAW,
        groupName: 'h-cloud admin',
      })
    }
    await expect(resolveTarget(a, 'missing')).rejects.toThrow("no group 'missing'")
  })

  test('the receive URL switches to the websocket scheme', () => {
    expect(new SignalApi({ url: 'https://signal.h-cloud.lan', apiKey: async () => '' }).receiveUrl(BOT)).toBe(
      `wss://signal.h-cloud.lan/v1/receive/${BOT}`,
    )
  })
})
