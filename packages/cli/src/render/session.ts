import type { Paint } from '../cli'

type Raw = { type?: string; created?: number; data?: Record<string, unknown> }

const MAX_ARG = 80
const MAX_RESULT = 100

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

const ARG_KEYS = ['command', 'filePath', 'path', 'pattern', 'url', 'query', 'description']

export function shortArgs(input: unknown): string {
  if (input === null || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  const key =
    ARG_KEYS.find((k) => typeof o[k] === 'string') ?? Object.keys(o).find((k) => typeof o[k] === 'string')
  return key ? oneLine(String(o[key]), MAX_ARG) : ''
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : ''
  return content
    .map((c) =>
      c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string'
        ? (c as { text: string }).text
        : '',
    )
    .join('\n')
}

export function shortResult(text: string): string {
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  if (lines.length === 0) return '(no output)'
  const more = lines.length > 1 ? ` (+${lines.length - 1} lines)` : ''
  return `${oneLine(lines[0] as string, MAX_RESULT)}${more}`
}

function seconds(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

export function wrap(text: string, width: number): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    let rest = line
    while (rest.length > width) {
      const cut = rest.lastIndexOf(' ', width)
      const at = cut > width / 2 ? cut : width
      out.push(rest.slice(0, at))
      rest = rest.slice(at).replace(/^ /, '')
    }
    out.push(rest)
  }
  return out
}

export class SessionRenderer {
  private readonly tools = new Map<string, { name: string; started: number }>()
  private text = ''
  private reasoning = false

  constructor(
    private readonly session: string,
    private readonly p: Paint,
    private readonly width = 100,
  ) {}

  feed(raw: unknown): string[] {
    const { type, created = 0, data } = raw as Raw
    if (!type || !data || data.sessionID !== this.session) return []
    switch (type) {
      case 'session.text.delta':
        return this.delta(typeof data.delta === 'string' ? data.delta : '', false)
      case 'session.reasoning.delta':
        return this.delta(typeof data.delta === 'string' ? data.delta : '', true)
      case 'session.text.ended':
      case 'session.reasoning.ended':
        return this.flush()
      case 'session.tool.input.started':
        this.tools.set(String(data.id), { name: String(data.name), started: created })
        return []
      case 'session.tool.called': {
        const tool = this.tools.get(String(data.id)) ?? { name: 'tool', started: created }
        this.tools.set(String(data.id), { ...tool, started: created })
        const args = shortArgs(data.input)
        return [
          ...this.flush(),
          `${this.p('cyan', '▸')} ${this.p('bold', tool.name)}${args ? ` ${args}` : ''}`,
        ]
      }
      case 'session.tool.success':
      case 'session.tool.failed': {
        const tool = this.tools.get(String(data.id))
        this.tools.delete(String(data.id))
        const took = tool ? ` (${seconds(Math.max(0, created - tool.started))})` : ''
        if (type === 'session.tool.success') {
          return [`  ${this.p('green', '✓')} ${shortResult(contentText(data.content))}${took}`]
        }
        const err = data.error as { message?: unknown } | undefined
        const message = typeof err?.message === 'string' ? err.message : 'failed'
        return [`  ${this.p('red', '✗')} ${shortResult(message)}${took}`]
      }
      case 'session.inbox.enqueued': {
        const item = data.item as { type?: string; payload?: { text?: unknown } } | undefined
        if (item?.type !== 'user' || typeof item.payload?.text !== 'string') return []
        return [...this.flush(), `${this.p('magenta', '›')} ${oneLine(item.payload.text, MAX_RESULT)}`]
      }
      case 'session.step.failed':
      case 'session.execution.failed': {
        const err = data.error as { message?: unknown } | undefined
        const message = typeof err?.message === 'string' ? err.message : 'error'
        return [
          ...this.flush(),
          `${this.p('red', '✗')} ${type === 'session.step.failed' ? 'step' : 'session'} failed: ${oneLine(message, MAX_RESULT)}`,
        ]
      }
      case 'session.execution.succeeded':
        return [...this.flush(), this.p('dim', '· idle')]
      default:
        return []
    }
  }

  private delta(chunk: string, reasoning: boolean): string[] {
    const switched = reasoning !== this.reasoning ? this.flush() : []
    this.reasoning = reasoning
    this.text += chunk
    const end = this.text.lastIndexOf('\n')
    if (end < 0) return switched
    const complete = this.text.slice(0, end)
    this.text = this.text.slice(end + 1)
    return [...switched, ...this.paintText(wrap(complete, this.width))]
  }

  flush(): string[] {
    if (this.text === '') return []
    const rest = this.text
    this.text = ''
    return this.paintText(wrap(rest, this.width))
  }

  private paintText(lines: string[]): string[] {
    return this.reasoning ? lines.map((l) => this.p('dim', l)) : lines
  }
}
