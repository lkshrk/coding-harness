import { randomInt } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NotificationKind } from '../../ports/ports'
import type { Db } from '../../state/db'

export type SentMessage = {
  kind: NotificationKind | 'back'
  issue?: string
  comment?: string
  options?: string[]
  poll?: boolean
  at: string
}

export type SignalState = { state: 'ok' | 'unavailable' | 'unpaired'; detail?: string; since: string }

const MESSAGES = 'signal_messages'
const USER = 'signal_user'
const STATE = 'signal'
const KEEP = 500
const PAIRING_FILE = 'signal-pair.json'
export const PAIRING_TTL_MS = 10 * 60_000

function meta(db: Db, key: string): string | undefined {
  return db.query<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?').get(key)?.value
}

function setMeta(db: Db, key: string, value: string): void {
  db.query(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value)
}

export function readSignalState(db: Db): SignalState | null {
  const raw = meta(db, STATE)
  return raw ? (JSON.parse(raw) as SignalState) : null
}

export class SignalStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private messages(): Record<string, SentMessage> {
    const raw = meta(this.db, MESSAGES)
    return raw ? (JSON.parse(raw) as Record<string, SentMessage>) : {}
  }

  private save(map: Record<string, SentMessage>): void {
    const keys = Object.keys(map).sort((a, b) => Number(a) - Number(b))
    for (const k of keys.slice(0, Math.max(0, keys.length - KEEP))) delete map[k]
    setMeta(this.db, MESSAGES, JSON.stringify(map))
  }

  remember(timestamp: number, m: Omit<SentMessage, 'at'>): void {
    const map = this.messages()
    map[String(timestamp)] = { ...m, at: this.now().toISOString() }
    this.save(map)
  }

  lookup(timestamp: number): SentMessage | undefined {
    return this.messages()[String(timestamp)]
  }

  forget(timestamp: number): void {
    const map = this.messages()
    delete map[String(timestamp)]
    this.save(map)
  }

  pairedUser(): string | undefined {
    return meta(this.db, USER) || undefined
  }

  pair(uuid: string): void {
    setMeta(this.db, USER, uuid)
  }

  state(): SignalState | null {
    return readSignalState(this.db)
  }

  setState(state: SignalState['state'], detail?: string): boolean {
    const cur = this.state()
    if (cur?.state === state && cur.detail === detail) return false
    const since = cur?.state === state ? cur.since : this.now().toISOString()
    setMeta(this.db, STATE, JSON.stringify({ state, ...(detail ? { detail } : {}), since }))
    return true
  }
}

export function startPairing(stateDir: string, now: Date = new Date()): { code: string; expires: Date } {
  const code = String(randomInt(100_000, 1_000_000))
  const expires = new Date(now.getTime() + PAIRING_TTL_MS)
  writeFileSync(join(stateDir, PAIRING_FILE), JSON.stringify({ code, expires: expires.toISOString() }), {
    mode: 0o600,
  })
  return { code, expires }
}

export function takePairing(stateDir: string, code: string, now: Date = new Date()): boolean {
  const path = join(stateDir, PAIRING_FILE)
  let pending: { code?: string; expires?: string }
  try {
    pending = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return false
  }
  if (pending.code !== code) return false
  rmSync(path, { force: true })
  return Date.parse(pending.expires ?? '') > now.getTime()
}
