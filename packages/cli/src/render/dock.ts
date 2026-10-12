import { footerFrame, type Part } from './status'

export type DockOutput = NodeJS.WritableStream & { isTTY?: boolean; columns?: number; rows?: number }
export type DockInput = NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (on: boolean) => unknown }

export const PROMPT = '› '

const ESC = '\x1b'
const ENTER = new Set(['\r', '\n'])
const BACKSPACE = new Set(['\x7f', '\b'])
const CTRL_C = '\x03'
const CTRL_D = '\x04'
const CTRL_U = '\x15'

// Output scrolls in rows 1..rows-2; the input line (rows-1) and the footer (rows) never move.
export class Dock {
  private line = ''
  private footer: { left: Part[]; right: Part[] } = { left: [], right: [] }
  private active = false

  constructor(
    private readonly output: DockOutput,
    private readonly color = true,
  ) {}

  get rows(): number {
    return this.output.rows ?? 24
  }

  get cols(): number {
    return this.output.columns ?? 80
  }

  start(): void {
    this.active = true
    this.layout()
  }

  stop(): void {
    if (!this.active) return
    this.active = false
    this.output.write(`${ESC}[r${ESC}[${this.rows - 1};1H${ESC}[0J`)
  }

  layout(): void {
    if (!this.active) return
    const rows = this.rows
    this.output.write(`${ESC}[1;${rows - 2}r${ESC}[${rows - 2};1H`)
    this.drawFooter()
    this.drawInput()
  }

  print(text: string): void {
    if (!this.active) {
      this.output.write(text.endsWith('\n') ? text : `${text}\n`)
      return
    }
    const body = text.endsWith('\n') ? text.slice(0, -1) : text
    this.output.write(`${ESC}[${this.rows - 2};1H\n${body.replaceAll('\n', '\r\n')}`)
    this.drawInput()
  }

  setFooter(left: Part[], right: Part[] = []): void {
    this.footer = { left, right }
    if (this.active) {
      this.drawFooter()
      this.drawInput()
    }
  }

  setLine(line: string): void {
    this.line = line
    if (this.active) this.drawInput()
  }

  private drawFooter(): void {
    this.output.write(footerFrame(this.rows, this.footer.left, this.cols, this.color, this.footer.right))
  }

  private drawInput(): void {
    const room = Math.max(1, this.cols - PROMPT.length - 1)
    const shown = this.line.length > room ? this.line.slice(this.line.length - room) : this.line
    this.output.write(`${ESC}[${this.rows - 1};1H${ESC}[2K${PROMPT}${shown}`)
  }
}

// Raw-mode line editing for the dock's input row: printable keys, backspace, ctrl+u, enter, ctrl+c/ctrl+d.
export async function* dockLines(input: DockInput, dock: Dock, signal: AbortSignal): AsyncGenerator<string> {
  let line = ''
  const queue: string[] = []
  let done = false
  let wake: (() => void) | null = null
  const notify = () => {
    const w = wake
    wake = null
    w?.()
  }
  const onData = (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    for (let i = 0; i < text.length; i++) {
      const ch = text[i] as string
      if (ch === CTRL_C || (ch === CTRL_D && line === '')) {
        done = true
        break
      }
      if (ENTER.has(ch)) {
        if (ch === '\r' && text[i + 1] === '\n') i++
        queue.push(line)
        line = ''
      } else if (BACKSPACE.has(ch)) line = [...line].slice(0, -1).join('')
      else if (ch === CTRL_U) line = ''
      else if (ch === ESC) {
        while (i + 1 < text.length && !/[A-Za-z~]/.test(text[i + 1] as string)) i++
        i++
      } else if (ch >= ' ') line += ch
    }
    dock.setLine(line)
    notify()
  }
  const onEnd = () => {
    done = true
    notify()
  }
  const onAbort = () => {
    done = true
    notify()
  }
  input.setRawMode?.(true)
  input.on('data', onData)
  input.on('end', onEnd)
  signal.addEventListener('abort', onAbort, { once: true })
  input.resume?.()
  try {
    while (true) {
      const next = queue.shift()
      if (next !== undefined) {
        yield next
        continue
      }
      if (done) return
      await new Promise<void>((resolve) => {
        wake = resolve
      })
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
    input.off('data', onData)
    input.off('end', onEnd)
    input.setRawMode?.(false)
    input.pause?.()
  }
}
