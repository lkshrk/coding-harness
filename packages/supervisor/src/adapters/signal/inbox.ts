import type { InboxSupervisor } from '../../ports/control'
import type { SupervisorStatus } from '../../state/status'
import type { SignalLink, SignalTarget } from './api'
import { type Envelope, type Frame, frameKind, groupOf, textOf } from './envelope'
import type { SentMessage, SignalStore } from './store'

export type SignalActions = InboxSupervisor

export type Receiver = { start(): void; stop(): Promise<void> }

export type ReceiverHooks = {
  onFrame: (frame: Frame) => void
  onOpen: () => void
  onDown: (detail: string) => void
}

export type SignalInboxOptions = {
  link: SignalLink
  store: SignalStore
  actions: () => SignalActions
  user: () => string | undefined
  takePairing: (code: string) => boolean
  receiver: (hooks: ReceiverHooks) => Receiver
  out: (line: string) => void
  now?: () => number
  backQuietMs?: number
}

export const BACK_MESSAGE = 'signal connection restored; replies sent while it was down were lost'

export const HELP = [
  'nightshift commands:',
  'ns status',
  'ns pause [<issue>] / ns resume [<issue>]',
  'ns implement <issue>',
  'ns stop <issue>',
  'ns retry <issue>',
  'Quote a question to answer it; quote another nightshift message to message its worker.',
].join('\n')

const ISSUE = /^[A-Z][A-Z0-9]{1,6}-[1-9][0-9]*$/
const PAIR = /^ns\s+pair\s+(\d{6})$/i
const BACK_QUIET_MS = 60_000

export function statusText(s: SupervisorStatus, signal?: string): string {
  const lines = [`dispatch: ${s.dispatch}${s.restartRequired ? ' (restart required)' : ''}`]
  lines.push(
    s.active.length
      ? `workers: ${s.active.map((r) => `${r.issue} ${r.agent} ${r.state}`).join('; ')}`
      : 'workers: none',
  )
  if (s.questions.length)
    lines.push(`questions: ${s.questions.map((q) => `${q.issue} (${q.askedTo})`).join(', ')}`)
  if (s.waiting.length)
    lines.push(`waiting: ${s.waiting.map((w) => `${w.identifier} ${w.reason}`).join('; ')}`)
  if (s.held.length) lines.push(`held: ${s.held.join(', ')}`)
  if (signal) lines.push(`signal: ${signal}`)
  return lines.join('\n')
}

export class SignalInbox {
  private readonly receiver: Receiver
  private chain: Promise<void> = Promise.resolve()
  private lastBack: number | undefined

  constructor(private readonly o: SignalInboxOptions) {
    this.receiver = o.receiver({
      onFrame: (frame) => {
        this.chain = this.chain.then(() => this.handle(frame)).catch((e) => o.out(`signal: ${e.message}`))
      },
      onOpen: () => this.opened(),
      onDown: (detail) => {
        if (o.store.setState('unavailable', detail)) o.out(`signal: receive stream down: ${detail}`)
      },
    })
  }

  start(): void {
    this.receiver.start()
  }

  async stop(): Promise<void> {
    await this.receiver.stop()
    await this.chain
  }

  idle(): Promise<void> {
    return this.chain
  }

  private user(): string | undefined {
    return this.o.user() ?? this.o.store.pairedUser()
  }

  private opened(): void {
    const paired = this.user() !== undefined
    if (this.o.store.setState(paired ? 'ok' : 'unpaired'))
      this.o.out(`signal: receive stream ${paired ? 'up' : 'up, unpaired'}`)
    const now = (this.o.now ?? Date.now)()
    if (this.lastBack === undefined) {
      this.lastBack = now
      return
    }
    if (now - this.lastBack < (this.o.backQuietMs ?? BACK_QUIET_MS)) return
    this.lastBack = now
    this.o.out(`signal: ${BACK_MESSAGE}`)
  }

  async handle(frame: Frame): Promise<void> {
    const e = frame.envelope
    const kind = frameKind(e)
    if (kind !== 'data' && kind !== 'pollVote') return
    const target = await this.o.link.target()
    if (groupOf(e) !== target.groupId) return
    const sender = e.sourceUuid
    if (!sender) return
    const user = this.user()
    if (kind === 'data') {
      const text = textOf(e).trim()
      if (!text) return
      if (sender !== user) return this.maybePair(sender, text)
      const quoted = e.dataMessage?.quote?.id
      const mapped = quoted === undefined ? undefined : this.o.store.lookup(quoted)
      if (mapped?.issue) return this.quoteReply(mapped, text)
      if (/^ns(\s|$)/i.test(text)) return this.command(text)
      return
    }
    if (sender === user) await this.vote(e, target)
  }

  private async maybePair(sender: string, text: string): Promise<void> {
    const code = PAIR.exec(text)?.[1]
    if (!code || this.o.user() !== undefined || !this.o.takePairing(code)) return
    this.o.store.pair(sender)
    this.o.store.setState('ok')
    this.o.out(`signal: paired with ${sender}`)
    await this.send(`paired: nightshift now takes replies from this account (${sender})`)
  }

  private async quoteReply(m: SentMessage, text: string): Promise<void> {
    const issue = m.issue as string
    const actions = this.o.actions()
    try {
      if (m.kind === 'question') {
        await actions.answerQuestion(issue, text, 'signal')
        await this.send(`✓ ${issue}: answered`)
      } else {
        await actions.sendMessage(issue, text, 'signal')
        await this.send(`✓ ${issue}: sent to the worker`)
      }
    } catch (err) {
      await this.send(`✗ ${issue}: ${(err as Error).message}`)
    }
  }

  private async vote(e: Envelope, t: SignalTarget): Promise<void> {
    const v = e.dataMessage?.pollVote
    if (!v || v.optionIndexes.length === 0) return
    const mapped = this.o.store.lookup(v.targetSentTimestamp)
    if (!mapped?.poll || !mapped.issue || !mapped.options) return
    if (v.authorNumber && v.authorNumber !== t.number) return
    const answer = mapped.options[v.optionIndexes[0] as number]
    if (answer === undefined) return
    this.o.store.forget(v.targetSentTimestamp)
    try {
      await this.o.link.api.closePoll(t.number, t.recipient, v.targetSentTimestamp)
    } catch (err) {
      this.o.out(`signal: closing poll ${v.targetSentTimestamp}: ${(err as Error).message}`)
    }
    try {
      await this.o.actions().answerQuestion(mapped.issue, answer, 'signal')
      await this.send(`✓ ${mapped.issue}: answered "${answer}"`)
    } catch (err) {
      await this.send(`✗ ${mapped.issue}: ${(err as Error).message}`)
    }
  }

  private async command(text: string): Promise<void> {
    const [, verb = '', ...args] = text.trim().split(/\s+/)
    const arg = args[0]?.toUpperCase()
    const a = this.o.actions()
    const issueOr = (usage: string): string => {
      if (!arg || !ISSUE.test(arg)) throw new Error(`usage: ${usage}`)
      return arg
    }
    try {
      switch (verb.toLowerCase()) {
        case 'status': {
          const s = this.o.store.state()
          return await this.send(
            statusText(a.status(), s ? `${s.state}${s.detail ? ` (${s.detail})` : ''}` : undefined),
          )
        }
        case 'pause':
          if (arg) a.hold(issueOr('ns pause [<issue>]'), 'signal')
          else a.pause('paused from Signal', 'signal')
          return await this.send(`✓ ${arg ?? 'dispatch'} paused`)
        case 'resume':
          if (arg) a.unhold(issueOr('ns resume [<issue>]'), 'signal')
          else a.resume('resumed from Signal', 'signal')
          return await this.send(`✓ ${arg ?? 'dispatch'} resumed`)
        case 'implement': {
          const issue = issueOr('ns implement <issue>')
          a.cover(issue, 'signal')
          return await this.send(`✓ ${issue} is covered; the supervisor picks it up on its next tick`)
        }
        case 'stop': {
          const run = await a.stopForUser(issueOr('ns stop <issue>'), 'stopped from Signal', 'signal')
          return await this.send(`✓ stopped run ${run.id}; ${run.issue} is blocked awaiting you`)
        }
        case 'retry': {
          const run = await a.retryRun(issueOr('ns retry <issue>'), {}, 'signal')
          return await this.send(`✓ dispatched run ${run.id} for ${run.issue}`)
        }
        case 'pair':
          return await this.send('already paired')
        default:
          return await this.send(HELP)
      }
    } catch (err) {
      await this.send(`✗ ${(err as Error).message}`)
    }
  }

  private async send(text: string): Promise<void> {
    try {
      await this.o.link.send(text)
    } catch (err) {
      this.o.out(`signal: reply failed: ${(err as Error).message}`)
    }
  }
}
