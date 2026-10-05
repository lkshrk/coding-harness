import { type Frame, parseFrame } from './envelope'

export type ReceiverOptions = {
  url: () => Promise<string>
  headers: () => Promise<Record<string, string>>
  tls?: { ca: string }
  onFrame: (frame: Frame) => void
  onOpen: () => void
  onDown: (detail: string) => void
  backoff?: { minMs: number; maxMs: number }
  pingMs?: number
  idleMs?: number
  stableMs?: number
  random?: () => number
}

type Socket = {
  addEventListener(type: string, fn: (ev: { data?: unknown; reason?: string; code?: number }) => void): void
  ping?: () => void
  close(): void
}

const DEFAULTS = { minMs: 250, maxMs: 30_000, pingMs: 30_000, idleMs: 70_000, stableMs: 140_000 }

export class SignalReceiver {
  private stopped = false
  private socket: Socket | undefined
  private wake: (() => void) | undefined
  private loop: Promise<void> | undefined

  constructor(private readonly o: ReceiverOptions) {}

  start(): void {
    this.stopped = false
    this.loop ??= this.run().finally(() => {
      this.loop = undefined
    })
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.socket?.close()
    this.wake?.()
    await this.loop
  }

  backoff(consecutive: number): number {
    const min = this.o.backoff?.minMs ?? DEFAULTS.minMs
    const max = this.o.backoff?.maxMs ?? DEFAULTS.maxMs
    const d = Math.min(max, min * 2 ** Math.min(consecutive - 1, 16))
    return d / 2 + Math.floor((this.o.random ?? Math.random)() * (d / 2 + 1))
  }

  private async run(): Promise<void> {
    let consecutive = 0
    while (!this.stopped) {
      let result: { connectedMs: number; active: boolean; detail: string }
      try {
        result = await this.connect(await this.o.url(), await this.o.headers())
      } catch (e) {
        result = { connectedMs: 0, active: false, detail: (e as Error).message }
      }
      if (this.stopped) return
      const stable = result.active || result.connectedMs >= (this.o.stableMs ?? DEFAULTS.stableMs)
      consecutive = stable ? 1 : consecutive + 1
      this.o.onDown(result.detail)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.backoff(consecutive))
        this.wake = () => {
          clearTimeout(timer)
          resolve()
        }
      })
      this.wake = undefined
    }
  }

  private connect(
    url: string,
    headers: Record<string, string>,
  ): Promise<{ connectedMs: number; active: boolean; detail: string }> {
    return new Promise((resolve) => {
      const ws = new WebSocket(url, {
        headers,
        ...(this.o.tls ? { tls: this.o.tls } : {}),
      } as never) as Socket
      this.socket = ws
      let openedAt = 0
      let active = false
      let lastSeen = Date.now()
      let detail = 'connection closed'
      const timers: ReturnType<typeof setInterval>[] = []
      const seen = () => {
        lastSeen = Date.now()
      }
      ws.addEventListener('open', () => {
        openedAt = Date.now()
        seen()
        timers.push(
          setInterval(() => {
            if (Date.now() - lastSeen > (this.o.idleMs ?? DEFAULTS.idleMs)) {
              detail = 'no traffic or pong within the idle timeout'
              ws.close()
              return
            }
            ws.ping?.()
          }, this.o.pingMs ?? DEFAULTS.pingMs),
        )
        this.o.onOpen()
      })
      ws.addEventListener('pong', seen)
      ws.addEventListener('message', (ev) => {
        seen()
        active = true
        const frame = typeof ev.data === 'string' ? parseFrame(ev.data) : null
        if (!frame) return
        try {
          this.o.onFrame(frame)
        } catch (e) {
          console.error(`signal: frame handler: ${(e as Error).message}`)
        }
      })
      ws.addEventListener('error', () => {
        detail = openedAt ? 'websocket error' : `cannot connect to ${url.replace(/\/v1\/receive\/.*$/, '')}`
      })
      ws.addEventListener('close', (ev) => {
        for (const t of timers) clearInterval(t)
        if (this.socket === ws) this.socket = undefined
        if (openedAt && ev.code && ev.code !== 1000)
          detail = `closed (${ev.code}${ev.reason ? ` ${ev.reason}` : ''})`
        resolve({ connectedMs: openedAt ? Date.now() - openedAt : 0, active, detail })
      })
    })
  }
}
