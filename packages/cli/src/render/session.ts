import { structuredPatch } from 'diff'
import { createMarkdownStreamer, render } from 'markdansi'
import type { Paint } from '../cli'
import { highlight } from './highlight'

type Raw = { type?: string; created?: number; data?: Record<string, unknown> }

type Tool = { name: string; started: number; input?: Record<string, unknown> }

export type RendererOptions = { reasoning?: boolean }

const MAX_ARG = 80
const MAX_RESULT = 100
const MAX_DIFF = 40
const SHELL_EDGE = 3
const SHELL_TOOLS = new Set(['shell', 'bash'])
const EDIT_TOOLS = new Set(['edit', 'write', 'patch', 'apply_patch', 'multiedit'])

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

const ESCAPES =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape sequences is the point
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]|[\x00-\x08\x0b-\x1f\x7f]/g

export function stripEscapes(text: string): string {
  return text.replace(ESCAPES, '')
}

const visibleWidth = (text: string) => Bun.stringWidth(stripEscapes(text))

type Token = { text: string; width: number }

function tokens(line: string): Token[] {
  const out: Token[] = []
  let at = 0
  for (const m of line.matchAll(ESCAPES)) {
    for (const ch of line.slice(at, m.index)) out.push({ text: ch, width: Bun.stringWidth(ch) })
    out.push({ text: m[0], width: 0 })
    at = m.index + m[0].length
  }
  for (const ch of line.slice(at)) out.push({ text: ch, width: Bun.stringWidth(ch) })
  return out
}

// SGR reset codes and the opening codes each one ends.
const CLOSES: Record<string, (code: number) => boolean> = {
  '0': () => true,
  '22': (c) => c === 1 || c === 2,
  '23': (c) => c === 3,
  '24': (c) => c === 4,
  '27': (c) => c === 7,
  '29': (c) => c === 9,
  '39': (c) => (c >= 30 && c <= 38) || (c >= 90 && c <= 97),
  '49': (c) => (c >= 40 && c <= 48) || (c >= 100 && c <= 107),
}

// Breaks at spaces, hard-breaks words wider than the line, and carries open SGR styles across breaks.
function wrapLine(line: string, width: number, indent: number): string[] {
  if (visibleWidth(line) <= width) return [line]
  const pad = ' '.repeat(Math.min(indent, width - 1))
  const lines: string[] = []
  let styles: { code: number; text: string }[] = []
  let current = ''
  let used = 0
  let gap: Token[] = []
  let word: Token[] = []
  const room = () => (lines.length === 0 ? width : width - pad.length)
  const track = (t: Token) => {
    const body = t.text.slice(2, -1)
    if (!t.text.startsWith('\x1b[') || !t.text.endsWith('m') || !/^[\d;]*$/.test(body)) return
    const params = body.split(';').map((n) => (n === '' ? '0' : n))
    if (!CLOSES[params[0] as string]) styles = [...styles, { code: Number(params[0]), text: t.text }]
    else
      for (const n of params) {
        const ends = CLOSES[n]
        if (ends) styles = styles.filter((s) => !ends(s.code))
      }
  }
  const breakLine = () => {
    lines.push(styles.length ? `${current}\x1b[0m` : current)
    current = `${pad}${styles.map((s) => s.text).join('')}`
    used = 0
  }
  const put = (t: Token) => {
    if (t.width && used + t.width > room() && used > 0) breakLine()
    current += t.text
    used += t.width
    track(t)
  }
  const flushWord = () => {
    const w = word.reduce((n, t) => n + t.width, 0)
    const g = gap.reduce((n, t) => n + t.width, 0)
    if (used > 0 && used + g + w > room() && w > 0) {
      for (const t of gap) if (!t.width) put(t)
      breakLine()
    } else for (const t of gap) put(t)
    if (w > room() - used && used > 0) breakLine()
    for (const t of word) put(t)
    gap = []
    word = []
  }
  for (const t of tokens(line)) {
    if (t.text === ' ') {
      if (word.length) flushWord()
      gap.push(t)
    } else if (!t.width && !word.length) gap.push(t)
    else word.push(t)
  }
  if (word.length) flushWord()
  for (const t of gap) if (!t.width) put(t)
  lines.push(current)
  return lines
}

// Where a line's content starts: after its indent and a list marker, if any.
function hangOf(line: string): number {
  return visibleWidth(/^\s*(?:(?:[-*+•]|\d+[.)]) )?/.exec(stripEscapes(line))?.[0] ?? '')
}

// Continuation lines start `indent` columns in, under the first line's content.
export function wrap(text: string, width: number, indent = 0): string[] {
  return text.split('\n').flatMap((line) => wrapLine(line, Math.max(1, width), indent))
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text
}

export function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const end = flat.search(/[.!?:](\s|$)/)
  const sentence = end < 0 ? flat : flat.slice(0, end + 1)
  return sentence.length < flat.length ? `${sentence} …` : sentence
}

function filePath(input: Record<string, unknown> | undefined): string | undefined {
  const path = input?.filePath ?? input?.path
  return typeof path === 'string' ? path : undefined
}

function readContent(text: string): string | undefined {
  const lines = text.split('\n').slice(1)
  if (lines.length === 0 || !lines[0]?.startsWith('1: ')) return undefined
  const body: string[] = []
  for (const [i, line] of lines.entries()) {
    const prefix = `${i + 1}: `
    if (!line.startsWith(prefix)) return undefined
    body.push(line.slice(prefix.length))
  }
  return body.join('\n')
}

export function diffLines(before: string, after: string): string[] {
  const old = after.endsWith('\n') && before !== '' && !before.endsWith('\n') ? `${before}\n` : before
  const patch = structuredPatch('', '', old, after, '', '', { context: 3 })
  return patch.hunks.flatMap((h) => [
    `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`,
    ...h.lines.filter((l) => !l.startsWith('\\')),
  ])
}

export class SessionRenderer {
  private readonly tools = new Map<string, Tool>()
  private readonly files = new Map<string, string>()
  private readonly color: boolean
  private readonly showReasoning: boolean
  private stream: ReturnType<typeof createMarkdownStreamer> | null = null
  private reasoning = false
  private thought = ''

  constructor(
    private readonly session: string,
    private readonly p: Paint,
    private readonly width: () => number = () => 100,
    options: RendererOptions = {},
  ) {
    this.color = p('bold', 'x') !== 'x'
    this.showReasoning = options.reasoning ?? false
  }

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
        const input =
          data.input && typeof data.input === 'object' ? (data.input as Record<string, unknown>) : undefined
        this.tools.set(String(data.id), { ...tool, started: created, ...(input ? { input } : {}) })
        const args = shortArgs(data.input)
        return [
          ...this.flush(),
          ...this.fit(`${this.p('cyan', '▸')} ${this.p('bold', tool.name)}${args ? ` ${args}` : ''}`, 2),
        ]
      }
      case 'session.tool.success':
      case 'session.tool.failed': {
        const tool = this.tools.get(String(data.id))
        this.tools.delete(String(data.id))
        const took = tool ? ` (${seconds(Math.max(0, created - tool.started))})` : ''
        if (type === 'session.tool.success') return [...this.flush(), ...this.success(tool, data, took)]
        const err = data.error as { message?: unknown } | undefined
        const message = typeof err?.message === 'string' ? err.message : 'failed'
        return [...this.flush(), ...this.fit(`  ${this.p('red', '✗')} ${shortResult(message)}${took}`, 4)]
      }
      case 'session.inbox.enqueued': {
        const item = data.item as { type?: string; payload?: { text?: unknown } } | undefined
        if (item?.type !== 'user' || typeof item.payload?.text !== 'string') return []
        return [
          ...this.flush(),
          ...this.fit(`${this.p('magenta', '›')} ${oneLine(item.payload.text, MAX_RESULT)}`, 2),
        ]
      }
      case 'session.step.failed':
      case 'session.execution.failed': {
        const err = data.error as { message?: unknown } | undefined
        const message = typeof err?.message === 'string' ? err.message : 'error'
        return [
          ...this.flush(),
          ...this.fit(
            `${this.p('red', '✗')} ${type === 'session.step.failed' ? 'step' : 'session'} failed: ${oneLine(message, MAX_RESULT)}`,
            2,
          ),
        ]
      }
      case 'session.execution.succeeded':
        return [...this.flush(), this.p('dim', '· idle')]
      default:
        return []
    }
  }

  flush(): string[] {
    if (this.reasoning && !this.showReasoning) {
      const summary = firstSentence(this.thought)
      this.thought = ''
      return summary ? wrap(summary, this.width()).map((l) => this.p('dim', l)) : []
    }
    if (!this.stream) return []
    const rest = this.stream.finish()
    this.stream = null
    return this.paintText(rest)
  }

  private delta(chunk: string, reasoning: boolean): string[] {
    const switched = reasoning !== this.reasoning ? this.flush() : []
    this.reasoning = reasoning
    if (reasoning && !this.showReasoning) {
      this.thought += chunk
      return switched
    }
    this.stream ??= createMarkdownStreamer({
      render: (md) =>
        render(md, {
          width: this.width(),
          color: this.color && !reasoning,
          hyperlinks: false,
          ...(this.color && !reasoning ? { highlighter: highlight } : {}),
        }),
      spacing: 'single',
    })
    return [...switched, ...this.paintText(this.stream.push(chunk))]
  }

  private paintText(text: string): string[] {
    if (text === '') return []
    const lines = text
      .replace(/\n$/, '')
      .split('\n')
      .flatMap((l) => this.fit(l, hangOf(l)))
    return this.reasoning ? lines.map((l) => (l === '' ? l : this.p('dim', l))) : lines
  }

  private fit(line: string, indent: number): string[] {
    return wrap(line, this.width(), indent)
  }

  private success(tool: Tool | undefined, data: Record<string, unknown>, took: string): string[] {
    const text = contentText(data.content)
    const metadata = (data.metadata ?? {}) as Record<string, unknown>
    const name = tool?.name ?? ''
    const path = filePath(tool?.input)
    if (name === 'read' && path) {
      const content = readContent(text)
      if (content !== undefined) this.files.set(path, content)
    }
    if (SHELL_TOOLS.has(name)) return this.shell(text, metadata, took)
    const head = this.fit(`  ${this.p('green', '✓')} ${shortResult(text)}${took}`, 4)
    if (!EDIT_TOOLS.has(name)) return head
    return [...head, ...this.diff(tool?.input, metadata, path)]
  }

  private shell(text: string, metadata: Record<string, unknown>, took: string): string[] {
    const body = (this.color ? text : stripEscapes(text)).replace(/\n+$/, '')
    const lines = body === '' ? [] : body.split('\n')
    const shown =
      lines.length > SHELL_EDGE * 2 + 1
        ? [
            ...lines.slice(0, SHELL_EDGE),
            this.p('dim', `… +${lines.length - SHELL_EDGE * 2} lines`),
            ...lines.slice(-SHELL_EDGE),
          ]
        : lines
    const exit = typeof metadata.exit === 'number' ? metadata.exit : undefined
    const mark = exit === undefined || exit === 0 ? this.p('green', '✓') : this.p('red', '✗')
    const status = exit === undefined ? 'done' : `exit ${exit}`
    return [
      ...shown.flatMap((l) => wrap(l, this.width() - 4).map((w) => `  ${this.p('dim', '│')} ${w}`)),
      `  ${mark} ${status}${took}`,
    ]
  }

  private diff(
    input: Record<string, unknown> | undefined,
    metadata: Record<string, unknown>,
    path: string | undefined,
  ): string[] {
    let lines: string[] = []
    if (typeof metadata.diff === 'string') lines = metadata.diff.split('\n')
    else if (typeof input?.patchText === 'string') lines = input.patchText.split('\n')
    else if (typeof input?.oldString === 'string' && typeof input.newString === 'string')
      lines = diffLines(input.oldString, input.newString)
    else if (typeof input?.content === 'string') {
      lines = diffLines(path ? (this.files.get(path) ?? '') : '', input.content)
      if (path) this.files.set(path, input.content)
    }
    lines = lines.filter((l) => !/^(---|\+\+\+|Index:|=+$)/.test(l) && l !== '')
    const shown = lines.slice(0, MAX_DIFF).map((l) => `    ${this.diffLine(clip(l, this.width() - 4))}`)
    if (lines.length > MAX_DIFF) shown.push(`    ${this.p('dim', `… +${lines.length - MAX_DIFF} lines`)}`)
    return shown
  }

  private diffLine(line: string): string {
    if (line.startsWith('@@')) return this.p('cyan', line)
    if (line.startsWith('+')) return this.p('green', line)
    if (line.startsWith('-')) return this.p('red', line)
    return this.p('dim', line)
  }
}
