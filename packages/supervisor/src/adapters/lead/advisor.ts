import { readFileSync } from 'node:fs'
import type { LeadAdvisor, LeadQuestion, LeadReply } from '../../ports'
import { OpenCodeClient } from '../worker/opencode-client'

export const ESCALATE = 'ESCALATE:'

export function leadPrompt(q: LeadQuestion): string {
  return [
    `A worker on ${q.issue} asks:`,
    '',
    q.question,
    ...(q.options?.length ? ['', `Options: ${q.options.join(' | ')}`] : []),
    '',
    `Answer from the repository, vault and Linear; your reply is posted to the worker as is. If you cannot, reply \`${ESCALATE} <reason>\`.`,
  ].join('\n')
}

export function parseReply(text: string): LeadReply | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  if (trimmed.startsWith(ESCALATE)) return { escalate: trimmed.slice(ESCALATE.length).trim() }
  return { answer: trimmed }
}

type RawEvent = { type?: string; data?: { sessionID?: unknown; text?: unknown } }

async function converse(
  client: OpenCodeClient,
  q: LeadQuestion,
  signal: AbortSignal,
  started: (id: string) => void,
) {
  const session = await client.createSession()
  started(session.id)
  const stream = client.events(signal)[Symbol.asyncIterator]()
  const first = stream.next()
  first.catch(() => undefined)
  await client.prompt(session.id, leadPrompt(q))
  let last = ''
  for (let next = await first; !next.done; next = await stream.next()) {
    const { type, data } = next.value as RawEvent
    if (!type || data?.sessionID !== session.id) continue
    if (type === 'session.text.ended' && typeof data.text === 'string' && data.text.trim()) last = data.text
    else if (type === 'session.execution.succeeded') return parseReply(last)
    else if (type === 'session.execution.failed' || type === 'session.execution.interrupted') return null
  }
  return null
}

export function leadAdvisor(o: {
  url: string
  passwordFile: string
  timeoutMs?: number
  fetch?: typeof fetch
}): LeadAdvisor {
  return {
    async ask(q) {
      let password: string
      try {
        password = readFileSync(o.passwordFile, 'utf8').trim()
      } catch {
        return null
      }
      const controller = new AbortController()
      const client = new OpenCodeClient(o.url, password, o.fetch ?? fetch)
      let session: string | undefined
      const consult = async () =>
        (await client.ready())
          ? converse(client, q, controller.signal, (id) => {
              session = id
            })
          : null
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), o.timeoutMs ?? 600_000)
      })
      try {
        const reply = await Promise.race([consult(), timeout])
        if (reply === null && session) await client.interrupt(session).catch(() => undefined)
        return reply
      } catch {
        return null
      } finally {
        clearTimeout(timer)
        controller.abort()
      }
    },
  }
}
