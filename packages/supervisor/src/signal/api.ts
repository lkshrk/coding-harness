import { canonicalGroupId, groupRecipient } from './envelope'

export type SignalApiOptions = {
  url: string
  apiKey: () => Promise<string>
  ca?: string
  fetch?: typeof fetch
  timeoutMs?: number
}

export type SignalGroup = { name: string; id: string; internal_id?: string }

export type SignalTarget = { number: string; recipient: string; groupId: string; groupName: string }

export class SignalApiError extends Error {
  override name = 'SignalApiError'

  constructor(
    readonly status: number,
    readonly op: string,
    body: string,
  ) {
    super(`signal ${op}: http ${status}${body ? `: ${body.slice(0, 200)}` : ''}`)
  }

  get unauthorized(): boolean {
    return this.status === 401 || this.status === 403
  }
}

const DEFAULT_TIMEOUT_MS = 10_000
export const POLL_OPTIONS = { min: 2, max: 10, maxLength: 100 } as const

function timestampOf(body: unknown, op: string): number {
  const one = Array.isArray(body) ? body[0] : body
  const raw = (one as { timestamp?: unknown } | undefined)?.timestamp
  const ts = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN
  if (!Number.isSafeInteger(ts) || ts <= 0) throw new Error(`signal ${op}: response has no usable timestamp`)
  return ts
}

export function validPollOptions(options: readonly string[]): boolean {
  return (
    options.length >= POLL_OPTIONS.min &&
    options.length <= POLL_OPTIONS.max &&
    options.every((o) => o.length >= 1 && [...o].length <= POLL_OPTIONS.maxLength)
  )
}

export class SignalApi {
  private readonly base: string
  private readonly http: typeof fetch
  private readonly timeoutMs: number

  constructor(private readonly o: SignalApiOptions) {
    this.base = o.url.replace(/\/+$/, '')
    this.http = o.fetch ?? fetch
    this.timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  get tls(): { ca: string } | undefined {
    return this.o.ca ? { ca: this.o.ca } : undefined
  }

  async headers(): Promise<Record<string, string>> {
    return { 'x-api-key': await this.o.apiKey() }
  }

  receiveUrl(number: string): string {
    return `${this.base.replace(/^http/, 'ws')}/v1/receive/${number}`
  }

  async accounts(): Promise<string[]> {
    return (await this.request('GET', '/v1/accounts')) as string[]
  }

  async groups(number: string): Promise<SignalGroup[]> {
    return (await this.request('GET', `/v1/groups/${number}`)) as SignalGroup[]
  }

  async send(number: string, recipient: string, message: string): Promise<number> {
    const body = await this.request('POST', '/v2/send', { number, recipients: [recipient], message })
    return timestampOf(body, 'send')
  }

  async createPoll(number: string, recipient: string, question: string, options: string[]): Promise<number> {
    if (!validPollOptions(options)) throw new Error('signal poll: needs 2-10 options of 1-100 characters')
    const body = await this.request('POST', `/v1/polls/${number}`, {
      recipient,
      question,
      answers: options,
      allow_multiple_selections: false,
    })
    return timestampOf(body, 'create poll')
  }

  async closePoll(number: string, recipient: string, pollTimestamp: number): Promise<void> {
    await this.request(
      'DELETE',
      `/v1/polls/${number}`,
      { recipient, poll_timestamp: String(pollTimestamp) },
      204,
    )
  }

  private async request(method: string, path: string, payload?: unknown, expect?: number): Promise<unknown> {
    const op = `${method} ${path}`
    const tls = this.tls
    const res = await this.http(`${this.base}${path}`, {
      method,
      headers: {
        ...(await this.headers()),
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(this.timeoutMs),
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      ...(tls ? { tls } : {}),
    } as RequestInit)
    const text = await res.text()
    if (res.status < 200 || res.status > 299) throw new SignalApiError(res.status, op, text.trim())
    if (expect !== undefined && res.status !== expect) {
      throw new SignalApiError(res.status, op, `expected ${expect}; treated as not applied`)
    }
    if (text.trim() === '') return null
    try {
      return JSON.parse(text)
    } catch {
      throw new Error(`signal ${op}: response is not JSON`)
    }
  }
}

export async function resolveTarget(api: SignalApi, group: string): Promise<SignalTarget> {
  const accounts = await api.accounts()
  if (accounts.length !== 1 || !accounts[0]) {
    throw new Error(`signal: expected exactly one registered account, found ${accounts.length}`)
  }
  const number = accounts[0]
  const wanted = canonicalGroupId(group)
  const groups = await api.groups(number)
  const byId = groups.filter((g) => canonicalGroupId(g.id) === wanted || g.internal_id === wanted)
  const matches = byId.length ? byId : groups.filter((g) => g.name === group)
  if (matches.length !== 1 || !matches[0]) {
    throw new Error(
      matches.length
        ? `signal: group name '${group}' is ambiguous; use its id`
        : `signal: no group '${group}'`,
    )
  }
  const g = matches[0]
  return { number, recipient: groupRecipient(g.id), groupId: canonicalGroupId(g.id), groupName: g.name }
}

export class SignalLink {
  private resolved: Promise<SignalTarget> | undefined

  constructor(
    readonly api: SignalApi,
    private readonly group: string,
  ) {}

  target(): Promise<SignalTarget> {
    this.resolved ??= resolveTarget(this.api, this.group).catch((e) => {
      this.resolved = undefined
      throw e
    })
    return this.resolved
  }

  async send(message: string): Promise<number> {
    const t = await this.target()
    return this.api.send(t.number, t.recipient, message)
  }
}
