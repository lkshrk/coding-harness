import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Event } from '@nightshift/supervisor'
import { paint } from '../cli'
import { eventLine } from './events'
import { SessionRenderer, shortArgs, wrap } from './session'
import {
  branchParts,
  clipParts,
  compactCount,
  footerFrame,
  plainText,
  renderLine,
  renderParts,
  scrollRegion,
  stateTone,
  statusParts,
} from './status'

const SESSION = 'ses_ef925c079ffe2Fw8WrE5w1is7D'
const recorded = readFileSync(join(import.meta.dir, 'fixtures/opencode-session.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as unknown)

const plain = paint(false)

describe('SessionRenderer (recorded OpenCode 2.0.22 events)', () => {
  test('renders the prompt, tool calls with one-line results and durations, text, and idle', () => {
    const r = new SessionRenderer(SESSION, plain)
    const lines = recorded.flatMap((e) => r.feed(e))
    expect(lines).toEqual([
      '› say hi via bash',
      '▸ read /work/repo/hello.txt',
      '  ✗ Invalid arguments for tool "read": (+4 lines) (4ms)',
      '▸ shell echo hi',
      '  ✓ hi (28ms)',
      'done',
      '· idle',
    ])
  })

  test('ignores other sessions and streams text deltas line by line', () => {
    const r = new SessionRenderer('s1', plain)
    const delta = (d: string) => ({ type: 'session.text.delta', data: { sessionID: 's1', delta: d } })
    expect(r.feed({ type: 'session.text.delta', data: { sessionID: 'other', delta: 'x\n' } })).toEqual([])
    expect(r.feed(delta('Looking at '))).toEqual([])
    expect(r.feed(delta('the tests.\nNext'))).toEqual(['Looking at the tests.'])
    expect(r.feed({ type: 'session.text.ended', data: { sessionID: 's1', text: '' } })).toEqual(['Next'])
  })

  test('streams reasoning deltas dimmed and keeps them apart from answer text', () => {
    const r = new SessionRenderer('s1', paint(true))
    const ev = (type: string, delta: string) => ({ type, data: { sessionID: 's1', delta } })
    const dim = paint(true)('dim', 'checking the picker')
    expect(r.feed(ev('session.reasoning.delta', 'checking the picker\nand'))).toEqual([dim])
    expect(r.feed(ev('session.text.delta', 'Done.\n'))).toEqual([paint(true)('dim', 'and'), 'Done.'])
    expect(r.feed({ type: 'session.reasoning.ended', data: { sessionID: 's1' } })).toEqual([])
  })

  test('renders a fatal session error', () => {
    const r = new SessionRenderer('s1', plain)
    const lines = r.feed({
      type: 'session.execution.failed',
      data: { sessionID: 's1', error: { message: 'Provider request failed with HTTP 500' } },
    })
    expect(lines).toEqual(['✗ session failed: Provider request failed with HTTP 500'])
  })

  test('short args prefer the command or path and wrap breaks long lines on spaces', () => {
    expect(shortArgs({ description: 'd', command: 'bun test' })).toBe('bun test')
    expect(shortArgs({ filePath: '/work/a.ts', limit: 3 })).toBe('/work/a.ts')
    expect(wrap('aaa bbb ccc', 7)).toEqual(['aaa bbb', 'ccc'])
  })
})

test('eventLine prefixes the issue and summarises lifecycle events', () => {
  const e: Event = {
    id: '01J0000000000000000000000A',
    ts: '2026-10-04T10:00:05.000Z',
    type: 'GATE_FAILED',
    issue: 'XXX-42',
    run: '01J0000000000000000000000B',
    data: { check: 'test', exit_code: 1, duration_ms: 12_000 },
  }
  expect(eventLine(e, plain, 'XXX-42')).toBe('10:00:05 XXX-42    GATE_FAILED test exit 1 (12s)')
  expect(eventLine(e, plain)).toBe('10:00:05 GATE_FAILED test exit 1 (12s)')
  expect(eventLine(e, paint(true))).toContain('\x1b[31mGATE_FAILED')
})

describe('status footer', () => {
  const w = {
    run: 'r1',
    issue: 'ROU-594',
    agent: 'fixer',
    model: 'claude-opus',
    profile: 'cloud',
    state: 'running',
    attempt: 1,
    started_at: '2026-10-04T16:19:37Z',
    elapsed_ms: 1_080_000,
    steps: 41,
    tool_calls: 52,
    tokens: 112_400,
    last_tool: 'shell',
    diff_lines: 310,
  }

  test('plain text carries issue, agent, model, tokens, steps, diff, elapsed and stage', () => {
    expect(plainText(statusParts(w, 'implementation'))).toBe(
      'ROU-594 · fixer · claude-opus │ 112k tok │ 41 steps · 52 tools │ +310 lines │ 18m00s │ implementation running',
    )
    expect(compactCount(1_500_000)).toBe('1.5M')
  })

  test('states map to tones', () => {
    expect(stateTone('running')).toBe('ok')
    expect(stateTone('gating')).toBe('ok')
    expect(stateTone('starting')).toBe('warn')
    expect(stateTone('failed')).toBe('bad')
  })

  test('ansi uses truecolor tokyonight; tmux uses style tags and escapes #', () => {
    expect(renderParts([['issue', 'ROU-594']], 'ansi')).toBe(
      '\x1b[1m\x1b[38;2;122;162;247mROU-594\x1b[22;39m',
    )
    expect(renderParts([['dim', 'a#b']], 'tmux')).toBe('#[fg=#565f89,nobold]a##b#[default]')
  })

  test('the branch is right-aligned: a tmux align tag, or after the status in plain text', () => {
    expect(renderLine([['issue', 'X']], branchParts(w), 'tmux')).toContain(
      '#[default]#[align=right]#[fg=#565f89,nobold]⎇ ',
    )
    expect(renderLine([['issue', 'X']], branchParts(w), 'plain')).toBe('X  ⎇ ns/ROU-594-1')
  })

  test('clipping counts visible characters and ends with an ellipsis', () => {
    expect(plainText(clipParts(statusParts(w), 12))).toBe('ROU-594 · f…')
    expect(plainText(clipParts([['dim', 'abc']], 3))).toBe('abc')
  })

  test('the footer is drawn on the last row on a dark background without moving the cursor', () => {
    const frame = footerFrame(30, [['meta', 'x'.repeat(50)]], 20)
    expect(frame.startsWith('\x1b7\x1b[30;1H\x1b[2K\x1b[48;2;31;35;53m')).toBe(true)
    expect(frame.endsWith('\x1b8')).toBe(true)
    expect(frame).toContain(`${'x'.repeat(17)}…`)
    expect(footerFrame(30, [['meta', 'x']], 20, false)).toContain(`\x1b[7m x${' '.repeat(18)}\x1b[0m`)
    const withBranch = footerFrame(30, [['meta', 'left']], 40, false, branchParts(w))
    expect(withBranch).toContain(` left${' '.repeat(20)}⎇ ns/ROU-594-1 `)
    expect(footerFrame(30, [['meta', 'left']], 20, false, branchParts(w))).not.toContain('ns/ROU-594')
    expect(scrollRegion(30)).toBe('\x1b[1;29r\x1b[29;1H')
  })
})
