import type { Notification, Notifier } from '../ports'
import { type SignalLink, validPollOptions } from './api'
import type { SignalStore } from './store'

export type SignalNotifierOptions = {
  link: SignalLink
  store: SignalStore
  fallback: Notifier
  issueUrl: (issue: string) => string | null
  out: (line: string) => void
  now?: () => number
  dedupeMs?: number
  healthy?: () => 'ok' | 'unpaired'
}

const DEDUPE_MS = 15 * 60_000
const NEEDS_YOU_DEDUPE_MS = 6 * 60 * 60_000
const ACTIONABLE: readonly NonNullable<Notification['kind']>[] = [
  'question',
  'blocked',
  'failed',
  'pr',
  'paused',
]
const SEND_FAILED = 'send failed: '
const POLL_QUESTION_MAX = 300

const CONTEXT_LINES = 6
const CONTEXT_CHARS = 220

export function messageText(n: Notification, issueUrl: (issue: string) => string | null): string {
  const head = n.issue && n.subject ? `${n.issue} · ${n.subject}` : null
  const line = head ? n.title : n.issue && !n.title.startsWith(n.issue) ? `${n.issue}: ${n.title}` : n.title
  const context = (n.context ?? [])
    .filter(Boolean)
    .slice(0, CONTEXT_LINES)
    .map((c) => `• ${c.length > CONTEXT_CHARS ? `${c.slice(0, CONTEXT_CHARS - 1)}…` : c}`)
  const action = n.action ? `→ ${n.action}` : n.kind === 'question' ? '→ Quote this message to answer.' : null
  const link = n.url ?? (n.issue ? issueUrl(n.issue) : null)
  return [head, line, ...context, action, link].filter(Boolean).join('\n')
}

export class SignalNotifier implements Notifier {
  private readonly recent = new Map<string, number>()

  constructor(private readonly o: SignalNotifierOptions) {}

  async notify(n: Notification): Promise<'signal' | null> {
    await this.o.fallback.notify(n)
    if (!n.kind || !ACTIONABLE.includes(n.kind)) return null
    const now = (this.o.now ?? Date.now)()
    const perIssue = n.kind === 'failed' && n.issue !== undefined
    const key = perIssue ? `failed|${n.issue}` : `${n.kind}|${n.issue ?? ''}|${n.title}`
    const window = perIssue ? NEEDS_YOU_DEDUPE_MS : (this.o.dedupeMs ?? DEDUPE_MS)
    const last = this.recent.get(key)
    if (last !== undefined && now - last < window) return null
    for (const [k, at] of this.recent) if (now - at >= NEEDS_YOU_DEDUPE_MS) this.recent.delete(k)
    try {
      await this.deliver(n)
      this.recent.set(key, now)
      const cur = this.o.store.state()
      if (!cur || (cur.state === 'unavailable' && cur.detail?.startsWith(SEND_FAILED))) {
        if (this.o.store.setState(this.o.healthy?.() ?? 'ok')) this.o.out('signal: reachable')
      }
      return 'signal'
    } catch (e) {
      const detail = `${SEND_FAILED}${(e as Error).message}`
      if (this.o.store.setState('unavailable', detail)) this.o.out(`signal: unavailable: ${detail}`)
      return null
    }
  }

  private async deliver(n: Notification): Promise<void> {
    const base = {
      kind: n.kind ?? ('info' as const),
      ...(n.issue ? { issue: n.issue } : {}),
      ...(n.question ? { comment: n.question.comment } : {}),
    }
    const options = n.question?.options
    if (n.kind === 'question' && n.question && options && validPollOptions(options)) {
      const t = await this.o.link.target()
      const prefix = n.issue ? `${n.issue}: ` : ''
      const question = `${prefix}${n.question.text}`.slice(0, POLL_QUESTION_MAX)
      try {
        const ts = await this.o.link.api.createPoll(t.number, t.recipient, question, options)
        this.o.store.remember(ts, { ...base, options, poll: true })
        return
      } catch (e) {
        this.o.out(`signal: poll failed, sending text instead: ${(e as Error).message}`)
      }
    }
    const extra = options?.length ? `\nOptions: ${options.join(' | ')}` : ''
    const ts = await this.o.link.send(`${messageText(n, this.o.issueUrl)}${extra}`)
    this.o.store.remember(ts, base)
  }
}
