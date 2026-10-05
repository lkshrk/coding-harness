import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SandboxHandle } from '../../ports'

export type SessionConnection = { sandbox: SandboxHandle; url: string; password: string; workdir: string }

export interface SessionStore {
  save(id: string, c: SessionConnection): void
  load(id: string): SessionConnection | undefined
  remove(id: string): void
}

export function memorySessionStore(): SessionStore {
  const m = new Map<string, SessionConnection>()
  return { save: (id, c) => m.set(id, c), load: (id) => m.get(id), remove: (id) => m.delete(id) }
}

export function fileSessionStore(dir: string): SessionStore {
  const file = (id: string) => join(dir, `${id}.json`)
  return {
    save(id, c) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeFileSync(file(id), JSON.stringify(c), { mode: 0o600 })
    },
    load(id) {
      try {
        return JSON.parse(readFileSync(file(id), 'utf8')) as SessionConnection
      } catch {
        return undefined
      }
    },
    remove(id) {
      rmSync(file(id), { force: true })
    },
  }
}
