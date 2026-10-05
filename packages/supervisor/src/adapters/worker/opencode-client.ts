import { parseSse } from './sse'

export class OpenCodeError extends Error {
  override name = 'OpenCodeError'

  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export type OpenCodeSession = { id: string; outcome?: string; time: { idle?: number } }

export class OpenCodeClient {
  private readonly auth: string

  constructor(
    readonly url: string,
    password: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.auth = `Basic ${btoa(`opencode:${password}`)}`
  }

  async ready(): Promise<boolean> {
    try {
      return (await this.fetchFn(`${this.url}/api/info`, { headers: { authorization: this.auth } })).ok
    } catch {
      return false
    }
  }

  async createSession(o: { agent: string; model: { providerID: string; id: string }; directory: string }) {
    const res = await this.call<{ data: OpenCodeSession }>('POST', '/api/session', {
      agent: o.agent,
      model: o.model,
      location: { directory: o.directory },
    })
    return res.data
  }

  async session(id: string): Promise<OpenCodeSession> {
    return (await this.call<{ data: OpenCodeSession }>('GET', `/api/session/${id}`)).data
  }

  async prompt(id: string, text: string): Promise<void> {
    await this.call('POST', `/api/session/${id}/prompt`, { text })
  }

  async interrupt(id: string): Promise<void> {
    await this.call('POST', `/api/session/${id}/interrupt`)
  }

  async *events(signal: AbortSignal): AsyncGenerator<unknown> {
    const res = await this.fetchFn(`${this.url}/api/event`, {
      headers: { authorization: this.auth, accept: 'text/event-stream' },
      signal,
    })
    if (!res.ok || !res.body) throw new OpenCodeError(`GET /api/event: HTTP ${res.status}`, res.status)
    for await (const message of parseSse(res.body)) {
      try {
        yield JSON.parse(message.data)
      } catch {}
    }
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchFn(`${this.url}${path}`, {
      method,
      headers: {
        authorization: this.auth,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await res.text()
    if (!res.ok)
      throw new OpenCodeError(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 300)}`, res.status)
    return (text ? JSON.parse(text) : undefined) as T
  }
}
