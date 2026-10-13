import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Event } from '@nightshift/supervisor'
import { paint } from '../cli'
import { eventLine } from './events'
import { SessionRenderer, shortArgs, stripEscapes, wrap } from './session'
import {
  branchParts,
  clipParts,
  compactCount,
  fitLine,
  footerFrame,
  type Part,
  plainText,
  renderLine,
  renderParts,
  scrollRegion,
  stateTone,
  statusParts,
} from './status'

const load = (name: string) =>
  readFileSync(join(import.meta.dir, 'fixtures', name), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as unknown)

const SESSION = 'ses_ef925c079ffe2Fw8WrE5w1is7D'
const recorded = load('opencode-session.jsonl')
const RICH = 'ses_ecea1c3a3ffeviBjwPtiWE7Jn6'
const rich = load('opencode-rich-session.jsonl')

const plain = paint(false)
const color = paint(true)
const ESC = '\x1b'

describe('SessionRenderer (recorded OpenCode 2.0.22 events)', () => {
  test('renders the prompt, tool calls with results and durations, shell output, text, and idle', () => {
    const r = new SessionRenderer(SESSION, plain)
    const lines = recorded.flatMap((e) => r.feed(e))
    expect(lines).toEqual([
      '› say hi via bash',
      '▸ read /work/repo/hello.txt',
      '  ✗ Invalid arguments for tool "read": (+4 lines) (4ms)',
      '▸ shell echo hi',
      '  │ hi',
      '  ✓ exit 0 (28ms)',
      'done',
      '· idle',
    ])
  })

  test('a real worker run renders writes as diffs, shell head and tail, and the Markdown answer', () => {
    const r = new SessionRenderer(RICH, plain, () => 80)
    const lines = rich.flatMap((e) => r.feed(e))
    expect(lines.slice(0, 2)).toEqual([
      '› "Work in this repository. 1) Create a file NOTES.md with a heading, a bullet',
      '  list of three items an…',
    ])
    expect(lines.slice(6)).toEqual([
      '▸ write /tmp/tmp.unsuKoNlS5/NOTES.md',
      '▸ write /tmp/tmp.unsuKoNlS5/greet.py',
      "▸ shell seq 1 40 | sed 's/^/line /'",
      '  ✓ Created file successfully: NOTES.md (22ms)',
      '    @@ -1,0 +1,11 @@',
      '    +# Notes',
      '    +',
      '    +- `greet.py` defines a single `greet` function.',
      '    +- `greet` now builds its message with an f-string.',
      '    +- `greet` has a docstring.',
      '    +',
      '    +```python',
      '    +from greet import greet',
      '    +',
      '    +print(greet("world"))  # hello world',
      '    +```',
      '  ✓ Wrote file successfully: greet.py (22ms)',
      '    @@ -1,2 +1,3 @@',
      '     def greet(name):',
      '    -    return "hello " + name',
      '    +    """Return a greeting for the given name."""',
      '    +    return f"hello {name}"',
      '  │ line 1',
      '  │ line 2',
      '  │ line 3',
      '  │ … +34 lines',
      '  │ line 38',
      '  │ line 39',
      '  │ line 40',
      '  ✓ exit 0 (37ms)',
      'Summary',
      '',
      '1. I created NOTES.md. It has a heading, three bullet points about greet.py',
      '  and a fenced Python example that calls greet.',
      '2. In greet.py, greet now builds its message with an f-string instead of joining',
      "  strings with +, and it has a docstring. I didn't run it.",
      "3. I ran seq 1 40 | sed 's/^/line /'. It printed 40 lines, from line 1 to line",
      '  40.',
      '',
      'Final greet.py:',
      '',
      '┌ [python]────────────────────────────────────────┐',
      '│ def greet(name):                                │',
      '│     """Return a greeting for the given name.""" │',
      '│     return f"hello {name}"                      │',
      '└─────────────────────────────────────────────────┘',
      '· idle',
    ])
    expect(lines.join('\n')).not.toContain(ESC)
  })

  test('with colour the diff is red and green, the heading styled and code highlighted', () => {
    const r = new SessionRenderer(RICH, color, () => 80)
    const lines = rich.flatMap((e) => r.feed(e))
    expect(lines).toContain(`    ${color('red', '-    return "hello " + name')}`)
    expect(lines).toContain(`    ${color('green', '+    return f"hello {name}"')}`)
    expect(lines).toContain(`    ${color('cyan', '@@ -1,2 +1,3 @@')}`)
    expect(lines).toContain('\x1b[33m\x1b[1mSummary\x1b[22m\x1b[39m')
    expect(lines.some((l) => l.includes('\x1b[38;2;187;154;247mdef\x1b[39m'))).toBe(true)
  })

  test('an edit tool diffs oldString against newString and caps long diffs', () => {
    const r = new SessionRenderer('s1', plain)
    const ev = (type: string, data: Record<string, unknown>) => ({
      type,
      data: { sessionID: 's1', id: 'c', ...data },
    })
    r.feed(ev('session.tool.input.started', { name: 'edit' }))
    r.feed(
      ev('session.tool.called', { input: { filePath: 'a.ts', oldString: 'a\nb\n', newString: 'a\nc\n' } }),
    )
    expect(r.feed(ev('session.tool.success', { content: [{ type: 'text', text: 'Edited a.ts' }] }))).toEqual([
      '  ✓ Edited a.ts (0ms)',
      '    @@ -1,2 +1,2 @@',
      '     a',
      '    -b',
      '    +c',
    ])
    r.feed(ev('session.tool.input.started', { name: 'write' }))
    const content = Array.from({ length: 50 }, (_, i) => `l${i}`).join('\n')
    r.feed(ev('session.tool.called', { input: { path: 'b.ts', content } }))
    const lines = r.feed(ev('session.tool.success', { content: 'ok' }))
    expect(lines).toHaveLength(42)
    expect(lines.at(-2)).toBe('    +l38')
    expect(lines.at(-1)).toBe('    … +11 lines')
  })

  test('a failing shell call shows its exit code', () => {
    const r = new SessionRenderer('s1', plain)
    const ev = (type: string, data: Record<string, unknown>) => ({
      type,
      data: { sessionID: 's1', id: 'c', ...data },
    })
    r.feed(ev('session.tool.input.started', { name: 'shell' }))
    r.feed(ev('session.tool.called', { input: { command: 'false' } }))
    expect(r.feed(ev('session.tool.success', { content: '', metadata: { exit: 1 } }))).toEqual([
      '  ✗ exit 1 (0ms)',
    ])
  })

  test('without colour, escape codes in shell output are stripped', () => {
    const r = new SessionRenderer('s1', plain)
    const ev = (type: string, data: Record<string, unknown>) => ({
      type,
      data: { sessionID: 's1', id: 'c', ...data },
    })
    r.feed(ev('session.tool.input.started', { name: 'shell' }))
    r.feed(ev('session.tool.called', { input: { command: 'bun test' } }))
    const content = '\x1b[32m✓ pass\x1b[0m\n\x1b]8;;http://x\x07link\x1b]8;;\x07\n\x1b[2K\x1b[1Gdone\r\n'
    const lines = r.feed(ev('session.tool.success', { content, metadata: { exit: 0 } }))
    expect(lines).toEqual(['  │ ✓ pass', '  │ link', '  │ done', '  ✓ exit 0 (0ms)'])
    expect(lines.join('\n')).not.toContain('\x1b')
  })

  test('ignores other sessions and streams text deltas line by line', () => {
    const r = new SessionRenderer('s1', plain)
    const delta = (d: string) => ({ type: 'session.text.delta', data: { sessionID: 's1', delta: d } })
    expect(r.feed({ type: 'session.text.delta', data: { sessionID: 'other', delta: 'x\n' } })).toEqual([])
    expect(r.feed(delta('Looking at '))).toEqual([])
    expect(r.feed(delta('the **tests**.\nNext'))).toEqual(['Looking at the tests.'])
    expect(r.feed({ type: 'session.text.ended', data: { sessionID: 's1', text: '' } })).toEqual(['Next'])
  })

  test('holds a fenced code block until it closes', () => {
    const r = new SessionRenderer('s1', plain)
    const delta = (d: string) => ({ type: 'session.text.delta', data: { sessionID: 's1', delta: d } })
    expect(r.feed(delta('```ts\nconst a = 1\n'))).toEqual([])
    expect(r.feed(delta('```\n'))).toEqual(['const a = 1'])
  })

  const reasoningEvents = [
    { type: 'session.reasoning.delta', data: { sessionID: 's1', delta: 'Checking the picker first. It\n' } },
    { type: 'session.reasoning.delta', data: { sessionID: 's1', delta: 'reads the config.' } },
    { type: 'session.reasoning.ended', data: { sessionID: 's1' } },
    { type: 'session.text.delta', data: { sessionID: 's1', delta: 'Done.\n' } },
  ]

  test('collapses each reasoning block to a dimmed first sentence', () => {
    const r = new SessionRenderer('s1', color)
    expect(reasoningEvents.flatMap((e) => r.feed(e))).toEqual([
      color('dim', 'Checking the picker first. …'),
      'Done.',
    ])
  })

  test('--reasoning streams reasoning in full, dimmed and apart from answer text', () => {
    const r = new SessionRenderer('s1', color, () => 100, { reasoning: true })
    expect(reasoningEvents.flatMap((e) => r.feed(e))).toEqual([
      color('dim', 'Checking the picker first. It'),
      color('dim', 'reads the config.'),
      'Done.',
    ])
    const p = new SessionRenderer('s1', plain, () => 100, { reasoning: true })
    expect(reasoningEvents.flatMap((e) => p.feed(e))).toEqual([
      'Checking the picker first. It',
      'reads the config.',
      'Done.',
    ])
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
    expect(wrap('- aaa bbb ccc', 9, 2)).toEqual(['- aaa bbb', '  ccc'])
    expect(wrap(`${color('red', 'aaa bbb')} ccc`, 4)).toEqual([
      '\x1b[31maaa\x1b[0m',
      '\x1b[31mbbb\x1b[0m',
      'ccc',
    ])
  })
})

describe('wrapping to the live width', () => {
  const visible = (l: string) => Bun.stringWidth(stripEscapes(l))
  const ev = (type: string, data: Record<string, unknown>) => ({
    type,
    data: { sessionID: 's1', id: 'c', ...data },
  })
  const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ')
  const delta = (d: string) => ev('session.text.delta', { delta: d })
  const ended = ev('session.text.ended', {})

  test('at 60 columns a reply, shell output and tool result wrap with hanging indents', () => {
    for (const p of [plain, color]) {
      const r = new SessionRenderer('s1', p, () => 60)
      const reply = [
        ...r.feed(delta(`${words(20)}\n\n- ${words(15)}\n\n${'x'.repeat(70)}\n`)),
        ...r.feed(ended),
      ].map(stripEscapes)
      expect(reply[0]).toStartWith('word0 word1')
      expect(reply.find((l) => l.startsWith('- '))).toBeDefined()
      const bullet = reply.findIndex((l) => l.startsWith('- '))
      expect(reply[bullet + 1]).toMatch(/^ {2}word/)
      expect(reply.slice(-2)).toEqual(['x'.repeat(60), 'x'.repeat(10)])

      r.feed(ev('session.tool.input.started', { name: 'shell' }))
      const call = r.feed(ev('session.tool.called', { input: { command: `echo ${words(12)}` } }))
      expect(call.map(stripEscapes)).toEqual([
        '▸ shell echo word0 word1 word2 word3 word4 word5 word6 word7',
        '  word8 word9 word10 word11',
      ])
      const shell = r
        .feed(
          ev('session.tool.success', { content: `${color('green', words(14))}\n`, metadata: { exit: 0 } }),
        )
        .map(stripEscapes)
      expect(shell).toEqual([
        '  │ word0 word1 word2 word3 word4 word5 word6 word7 word8',
        '  │ word9 word10 word11 word12 word13',
        '  ✓ exit 0 (0ms)',
      ])

      r.feed(ev('session.tool.input.started', { name: 'grep' }))
      r.feed(ev('session.tool.called', { input: { pattern: 'x' } }))
      const result = r.feed(ev('session.tool.success', { content: words(14) })).map(stripEscapes)
      expect(result).toEqual([
        '  ✓ word0 word1 word2 word3 word4 word5 word6 word7 word8',
        '    word9 word10 word11 word12 word13 (0ms)',
      ])
      for (const l of [...reply, ...call, ...shell, ...result]) expect(visible(l)).toBeLessThanOrEqual(60)
      if (p === plain) expect([...reply, ...shell].join('\n')).not.toContain(ESC)
    }
  })

  test('tabs in shell output and text are expanded to spaces before measuring', () => {
    for (const p of [plain, color]) {
      const r = new SessionRenderer('s1', p, () => 60)
      r.feed(ev('session.tool.input.started', { name: 'shell' }))
      r.feed(ev('session.tool.called', { input: { command: 'ls' } }))
      const content = `${'a\t'.repeat(10)}\n${p('green', 'ab\tc')}\n`
      const shell = r.feed(ev('session.tool.success', { content, metadata: { exit: 0 } }))
      const text = [...r.feed(delta(`${'x\t'.repeat(10)}\n`)), ...r.feed(ended)]
      const all = [...shell, ...text]
      expect(all.join('')).not.toContain('\t')
      for (const l of all) expect(visible(l)).toBeLessThanOrEqual(60)
      expect(shell.slice(0, 3).map(stripEscapes)).toEqual([
        `  │ ${'a       '.repeat(6)}a`,
        `  │ ${'a       '.repeat(2)}a`,
        '  │ ab      c',
      ])
    }
  })

  test('a collapsed reasoning summary wraps instead of being clipped', () => {
    const r = new SessionRenderer('s1', plain, () => 30)
    r.feed(ev('session.reasoning.delta', { delta: `${words(8)}.` }))
    expect(r.feed(ev('session.reasoning.ended', {}))).toEqual([
      'word0 word1 word2 word3 word4',
      'word5 word6 word7.',
    ])
  })

  test('each render uses the current width of the provider', () => {
    let width = 100
    const r = new SessionRenderer('s1', plain, () => width)
    expect(r.feed(delta(`${words(12)}\n`))).toHaveLength(1)
    width = 40
    const narrow = r.feed(delta(`${words(12)}\n`))
    expect(narrow.length).toBeGreaterThan(1)
    for (const l of narrow) expect(visible(l)).toBeLessThanOrEqual(40)
  })

  test('a width reduced by a prefix keeps prefixed lines within the terminal', () => {
    const prefix = 'XXX-123 │ '
    const r = new SessionRenderer('s1', plain, () => 60 - prefix.length)
    const lines = [...r.feed(delta(`${words(30)}\n`)), ...r.feed(ended)]
    expect(lines.length).toBeGreaterThan(1)
    for (const l of lines) expect(visible(`${prefix}${l}`)).toBeLessThanOrEqual(60)
  })

  test('double-width characters never push a line past its width', () => {
    for (const [text, width, indent] of [
      ['界界界界界', 4, 3],
      ['aaaa 界界 bb', 3, 2],
      ['界界界', 1, 0],
      [`${color('red', '界界界')} 界`, 3, 1],
    ] as const) {
      const lines = wrap(text, width, indent)
      for (const l of lines) expect(visible(l)).toBeLessThanOrEqual(Math.max(width, 2))
    }
    expect(wrap('界界界界界', 4, 3)).toEqual(['界界', '界界', '界'])
    expect(wrap('aaaa 界界 bb', 3, 2)).toEqual(['aaa', '  a', '界', '界', '  b', '  b'])
  })

  test('an indent at or above the width still leaves room for content', () => {
    expect(wrap('aaa bbb ccc', 4, 4)).toEqual(['aaa', '   b', '   b', '   b', '   c', '   c', '   c'])
    for (const l of wrap('aaa bbb ccc', 3, 9)) expect(visible(l)).toBeLessThanOrEqual(3)
  })

  test('styles carry across breaks, each SGR parameter tracked on its own', () => {
    expect(wrap('\x1b[1;31maaa\x1b[22m bbb', 4)).toEqual(['\x1b[1;31maaa\x1b[22m\x1b[0m', '\x1b[31mbbb'])
    expect(wrap('\x1b[0;31maaa bbb', 4)).toEqual(['\x1b[0;31maaa\x1b[0m', '\x1b[31mbbb'])
    expect(wrap('\x1b[01;34maaa bbb\x1b[0m', 4)).toEqual([
      '\x1b[01;34maaa\x1b[0m',
      '\x1b[01m\x1b[34mbbb\x1b[0m',
    ])
    expect(wrap('\x1b[1;38;5;196maaa bbb', 4)).toEqual([
      '\x1b[1;38;5;196maaa\x1b[0m',
      '\x1b[1m\x1b[38;5;196mbbb',
    ])
    expect(wrap('\x1b[31maaa\x1b[0;1m bbb', 4)).toEqual(['\x1b[31maaa\x1b[0;1m\x1b[0m', '\x1b[1mbbb'])
  })

  test('diff lines with wide characters are clipped to the width', () => {
    const r = new SessionRenderer('s1', plain, () => 30)
    r.feed(ev('session.tool.input.started', { name: 'edit' }))
    r.feed(
      ev('session.tool.called', {
        input: { filePath: 'a.md', oldString: 'a\n', newString: `${'界'.repeat(40)}\n` },
      }),
    )
    const lines = r.feed(ev('session.tool.success', { content: 'Edited a.md' }))
    expect(lines[3]).toBe(`    +${'界'.repeat(12)}…`)
    for (const l of lines) expect(visible(l)).toBeLessThanOrEqual(30)
  })

  test('a diff line clipped to one column or less keeps within the limit', () => {
    for (const [width, expected] of [
      [6, '    +…'],
      [5, '    …'],
      [4, '    '],
    ] as const) {
      const r = new SessionRenderer('s1', plain, () => width)
      r.feed(ev('session.tool.input.started', { name: 'edit' }))
      r.feed(
        ev('session.tool.called', { input: { filePath: 'a.md', oldString: 'a\n', newString: '界界\n' } }),
      )
      const lines = r.feed(ev('session.tool.success', { content: 'Edited a.md' }))
      expect(lines.at(-1)).toBe(expected)
    }
  })

  test('diff lines are clipped, not wrapped', () => {
    const r = new SessionRenderer('s1', plain, () => 60)
    r.feed(ev('session.tool.input.started', { name: 'edit' }))
    r.feed(
      ev('session.tool.called', {
        input: { filePath: 'a.ts', oldString: 'a\n', newString: `${words(20)}\n` },
      }),
    )
    const lines = r.feed(ev('session.tool.success', { content: 'Edited a.ts' }))
    expect(lines).toHaveLength(4)
    expect(lines[3]).toBe(`    ${`+${words(20)}`.slice(0, 55)}…`)
    for (const l of lines) expect(visible(l)).toBeLessThanOrEqual(60)

    r.feed(ev('session.tool.input.started', { name: 'edit' }))
    r.feed(
      ev('session.tool.called', {
        input: { filePath: 'b.go', oldString: 'a\n', newString: `${'\t'.repeat(9)}x\n` },
      }),
    )
    const tabbed = r.feed(ev('session.tool.success', { content: 'Edited b.go' }))
    expect(tabbed[3]).toBe(`    +${' '.repeat(54)}…`)
    for (const l of tabbed) expect(visible(l)).toBeLessThanOrEqual(60)
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

  test('a fitted line that cannot hold the branch still ends with an ellipsis', () => {
    const left: Part[] = [['issue', 'ROU-594']]
    const right = branchParts(w)
    const width = plainText(left).length + 4
    const cut = fitLine(left, right, width)
    const text = plainText(cut.left) + plainText(cut.right)
    expect(text.length).toBeLessThanOrEqual(width)
    expect(text.endsWith('…')).toBe(true)
    expect(fitLine(left, right, 200)).toEqual({ left, right })
    expect(fitLine(left, [], 7)).toEqual({ left, right: [] })
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
