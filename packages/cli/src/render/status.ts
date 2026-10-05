import { branchOf, type WorkerRecord } from '@nightshift/supervisor'
import { duration } from '../commands/shared'

export type Tone =
  | 'issue'
  | 'agent'
  | 'model'
  | 'count'
  | 'meta'
  | 'diff'
  | 'time'
  | 'ok'
  | 'warn'
  | 'bad'
  | 'dim'
  | 'branch'
export type Part = readonly [Tone, string]
export type StatusStyle = 'plain' | 'ansi' | 'tmux'

const TOKYONIGHT: Record<Tone, string> = {
  issue: '#7aa2f7',
  agent: '#bb9af7',
  model: '#7dcfff',
  count: '#e0af68',
  meta: '#c0caf5',
  diff: '#9ece6a',
  time: '#ff9e64',
  ok: '#9ece6a',
  warn: '#e0af68',
  bad: '#f7768e',
  dim: '#565f89',
  branch: '#73daca',
}
const FOOTER_BG = '#1f2335'
const SEPARATOR: Part = ['dim', ' │ ']
const BOLD: ReadonlySet<Tone> = new Set(['issue', 'ok', 'warn', 'bad'])

export function compactCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

export function stateTone(state: string): Tone {
  if (state === 'failed' || state === 'stopped') return 'bad'
  if (state === 'queued' || state === 'starting' || state === 'finishing') return 'warn'
  if (state === 'done') return 'dim'
  return 'ok'
}

function join(groups: Part[][]): Part[] {
  return groups.flatMap((g, i) => (i ? [SEPARATOR, ...g] : g))
}

export function statusParts(w: WorkerRecord, stage?: string | null): Part[] {
  return join([
    [
      ['issue', w.issue],
      ['dim', ' · '],
      ['agent', w.agent],
      ['dim', ' · '],
      ['model', w.model],
    ],
    [
      ['count', compactCount(w.tokens)],
      ['dim', ' tok'],
    ],
    [
      ['meta', String(w.steps)],
      ['dim', ' steps · '],
      ['meta', String(w.tool_calls)],
      ['dim', ' tools'],
    ],
    [
      ['diff', `+${w.diff_lines}`],
      ['dim', ' lines'],
    ],
    [['time', duration(w.elapsed_ms)]],
    [...(stage ? [['dim', `${stage} `] as Part] : []), [stateTone(w.state), w.state]],
  ])
}

export function branchParts(w: WorkerRecord): Part[] {
  return [
    ['dim', '⎇ '],
    ['branch', branchOf(w)],
  ]
}

export function summaryParts(rows: WorkerRecord[]): Part[] {
  if (!rows.length) return [['dim', 'no active workers']]
  return join(
    rows.map((w) => [
      ['issue', w.issue],
      ['dim', ' '],
      [stateTone(w.state), w.state],
      ['dim', ` ${duration(w.elapsed_ms)}`],
    ]),
  )
}

export function idleParts(issue: string): Part[] {
  return [
    ['issue', issue],
    ['dim', ' · idle'],
  ]
}

function rgb(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16)
  return `${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`
}

function ansi(tone: Tone, text: string): string {
  const bold = BOLD.has(tone) ? '\x1b[1m' : ''
  return `${bold}\x1b[38;2;${rgb(TOKYONIGHT[tone])}m${text}\x1b[22;39m`
}

export function plainText(parts: Part[]): string {
  return parts.map(([, t]) => t).join('')
}

export function renderParts(parts: Part[], style: StatusStyle): string {
  if (style === 'plain') return plainText(parts)
  if (style === 'ansi') return parts.map(([tone, t]) => ansi(tone, t)).join('')
  return `${parts
    .map(
      ([tone, t]) =>
        `#[fg=${TOKYONIGHT[tone]}${BOLD.has(tone) ? ',bold' : ',nobold'}]${t.replaceAll('#', '##')}`,
    )
    .join('')}#[default]`
}

export function renderLine(left: Part[], right: Part[], style: StatusStyle): string {
  if (!right.length) return renderParts(left, style)
  if (style === 'tmux') return `${renderParts(left, style)}#[align=right]${renderParts(right, style)}`
  return `${renderParts(left, style)}  ${renderParts(right, style)}`
}

export function clipParts(parts: Part[], width: number): Part[] {
  const out: Part[] = []
  let left = width
  for (const [tone, text] of parts) {
    if (text.length < left || (text.length === left && out.length + 1 === parts.length)) {
      out.push([tone, text])
      left -= text.length
      continue
    }
    if (left > 0) out.push([tone, `${text.slice(0, left - 1)}…`])
    break
  }
  return out
}

export function footerFrame(
  rows: number,
  left: Part[],
  width: number,
  color = true,
  right: Part[] = [],
): string {
  const inner = Math.max(0, width - 2)
  const rightWidth = plainText(right).length
  const showRight = rightWidth > 0 && rightWidth + 2 + 10 <= inner
  const clipped = clipParts(left, showRight ? inner - rightWidth - 2 : inner)
  const tail = showRight ? right : []
  const gap = ' '.repeat(Math.max(0, inner - plainText(clipped).length - plainText(tail).length))
  const body = color
    ? `\x1b[48;2;${rgb(FOOTER_BG)}m ${renderParts(clipped, 'ansi')}${gap}${renderParts(tail, 'ansi')} \x1b[0m`
    : `\x1b[7m ${plainText(clipped)}${gap}${plainText(tail)} \x1b[0m`
  return `\x1b7\x1b[${rows};1H\x1b[2K${body}\x1b8`
}

export function scrollRegion(rows: number): string {
  return `\x1b[1;${rows - 1}r\x1b[${rows - 1};1H`
}

export const RESET_REGION = '\x1b7\x1b[r\x1b8'
