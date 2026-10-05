import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Server, ServerWebSocket } from 'bun'
import { groupRecipient } from './envelope'

export const BOT = '+490000000001'
export const USER_UUID = '00000000-0000-4000-8000-000000000001'
export const OTHER_UUID = '00000000-0000-4000-8000-000000000002'
export const GROUP_RAW = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
export const OTHER_GROUP_RAW = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB='
export const API_KEY = 'test-key'

export function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(import.meta.dir, 'testdata', `${name}.json`), 'utf8'))
}

type Envelope = Record<string, unknown> & { dataMessage?: Record<string, unknown> }

export function frame(name: string, change: (e: Envelope) => void = () => {}): Record<string, unknown> {
  const f = fixture(name) as { envelope: Envelope }
  change(f.envelope)
  return f
}

export function textFrame(text: string, o: { from?: string; group?: string; quote?: number } = {}) {
  return frame('group_data_message', (e) => {
    e.sourceUuid = o.from ?? USER_UUID
    const dm = e.dataMessage as Record<string, unknown>
    dm.message = text
    ;(dm.groupInfo as Record<string, unknown>).groupId = o.group ?? GROUP_RAW
    if (o.quote !== undefined) dm.quote = { id: o.quote, author: BOT, authorNumber: BOT, text: 'q' }
  })
}

export function voteFrame(poll: number, option: number, from = USER_UUID) {
  return frame('poll_vote', (e) => {
    e.sourceUuid = from
    const dm = e.dataMessage as Record<string, Record<string, unknown>>
    ;(dm.pollVote as Record<string, unknown>).targetSentTimestamp = poll
    ;(dm.pollVote as Record<string, unknown>).optionIndexes = [option]
  })
}

export type Recorded = { method: string; path: string; body: Record<string, unknown> | null }

export class FakeSignalServer {
  readonly requests: Recorded[] = []
  sendShape: 'object' | 'array' = 'object'
  failSend = false
  connects = 0
  private ts = 1_786_850_000_000
  private readonly sockets = new Set<ServerWebSocket<unknown>>()
  private readonly server: ReturnType<typeof Bun.serve>

  constructor() {
    this.server = Bun.serve({
      port: 0,
      fetch: (req, srv) => this.route(req, srv),
      websocket: {
        open: (ws) => {
          this.connects += 1
          this.sockets.add(ws)
        },
        close: (ws) => {
          this.sockets.delete(ws)
        },
        message: () => {},
      },
    })
  }

  get url(): string {
    return `http://localhost:${this.server.port}`
  }

  get sent(): Recorded[] {
    return this.requests.filter((r) => r.path === '/v2/send')
  }

  get messages(): string[] {
    return this.sent.map((r) => String(r.body?.message))
  }

  get open(): number {
    return this.sockets.size
  }

  push(f: unknown): void {
    for (const ws of this.sockets) ws.send(JSON.stringify(f))
  }

  drop(): void {
    for (const ws of this.sockets) ws.close(1011, 'restart')
  }

  stop(): void {
    this.server.stop(true)
  }

  private next(): number {
    this.ts += 1000
    return this.ts
  }

  private async route(req: Request, srv: Server<unknown>): Promise<Response | undefined> {
    const url = new URL(req.url)
    if (req.headers.get('x-api-key') !== API_KEY) return new Response('unauthorized', { status: 401 })
    if (url.pathname === `/v1/receive/${BOT}`) {
      return srv.upgrade(req, { data: undefined })
        ? undefined
        : new Response('upgrade failed', { status: 400 })
    }
    const text = await req.text()
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : null
    this.requests.push({ method: req.method, path: url.pathname, body })
    if (req.method === 'GET' && url.pathname === '/v1/accounts') return Response.json([BOT])
    if (req.method === 'GET' && url.pathname === `/v1/groups/${BOT}`) {
      return Response.json([
        { name: 'h-cloud admin', id: groupRecipient(GROUP_RAW), internal_id: GROUP_RAW },
        { name: 'elsewhere', id: groupRecipient(OTHER_GROUP_RAW), internal_id: OTHER_GROUP_RAW },
      ])
    }
    if (req.method === 'POST' && url.pathname === '/v2/send') {
      if (this.failSend) return new Response('{"error":"Failed to send message"}', { status: 400 })
      const timestamp = String(this.next())
      return Response.json(this.sendShape === 'array' ? [{ timestamp }] : { timestamp })
    }
    if (req.method === 'POST' && url.pathname === `/v1/polls/${BOT}`) {
      return Response.json({ timestamp: String(this.next()) })
    }
    if (req.method === 'DELETE' && url.pathname === `/v1/polls/${BOT}`)
      return new Response(null, { status: 204 })
    return new Response('not found', { status: 404 })
  }
}

export async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time')
    await Bun.sleep(5)
  }
}
