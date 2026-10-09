import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HarnessEvent, WorkerStart } from '../../ports'
import { DSH_EVENTS, DSH_FINISH_FILE, DshDriver, dshPatch } from './dsh'
import { DshEventMapper } from './dsh-events'
import { FakeSandboxDriver } from './testing'

const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, 'fixtures/dsh', name), 'utf8')
    .trim()
    .split('\n')

const mapAll = (lines: string[]) => {
  const mapper = new DshEventMapper()
  return lines.flatMap((l) => mapper.map(JSON.parse(l)))
}

test('maps a recorded headless run to steps, tool calls, results, text and a final idle', () => {
  const events = mapAll(fixture('fix-bug.ndjson'))
  expect(events.map((e) => e.kind)).toEqual([
    'tool_call',
    'tool_result',
    'step',
    'tool_call',
    'tool_result',
    'step',
    'tool_call',
    'tool_result',
    'step',
    'text',
    'step',
    'idle',
  ])
  expect(events.filter((e) => e.kind === 'tool_call').map((e) => (e as { tool: string }).tool)).toEqual([
    'read',
    'edit',
    'bash',
  ])
  expect(events.find((e) => e.kind === 'step')).toMatchObject({ step: 1 })
  expect((events.find((e) => e.kind === 'step') as { tokensIn: number }).tokensIn).toBeGreaterThan(0)
})

test('the MCP finish call is reported as a successful finish tool result', () => {
  const events = mapAll(fixture('finish.ndjson'))
  expect(events).toContainEqual({ kind: 'tool_result', tool: 'mcp__nightshift__finish', ok: true })
})

test('tool errors and abnormal turn ends are reported', () => {
  const mapper = new DshEventMapper()
  mapper.map({ type: 'tool_call', callId: 'c1', tool: 'read', input: { file_path: '/x' } })
  expect(mapper.map({ type: 'tool_result', callId: 'c1', status: 'error', result: 'not found' })).toEqual([
    { kind: 'tool_result', tool: 'read', ok: false },
  ])
  expect(
    mapper.map({ type: 'status', phase: 'turn_end', reason: { kind: 'error', message: 'boom' } }),
  ).toEqual([{ kind: 'error', message: 'turn ended: boom', fatal: false }])
})

test('the profile patch routes through the gateway, mounts the finish MCP server and carries the agent prompt', () => {
  const patch = dshPatch(
    {
      model: 'litellm/claude-opus',
      gateway: { baseUrl: 'https://gw/v1', apiKey: 'k', sessionId: 'run-1' },
      workdir: '/work/omni',
    },
    { prompt: 'Be "careful".' },
  )
  expect(patch).toContain('baseURL: "https://gw/v1"')
  expect(patch).toContain('model: "claude-opus"')
  expect(patch).toContain('x-litellm-session-id: "run-1"')
  expect(patch).toContain('- insert:\n    - id: mcp-nightshift')
  expect(patch).toContain(`NIGHTSHIFT_FINISH_PATH: "${DSH_FINISH_FILE}"`)
  expect(patch).toContain('personaSuffix: "Be \\"careful\\"."')
  expect(patch).not.toContain('apiKey: ')
})

const start = (sb: FakeSandboxDriver): WorkerStart => ({
  sandbox: { driver: 'docker', id: 'ctr', name: 'run-1' },
  agent: {
    name: 'implementer',
    files: [{ path: 'agent/implementer.md', content: '---\nmode: primary\n---\nImplement the issue.\n' }],
  },
  model: 'claude-opus',
  taskMessage: 'Fix FOR-1',
  gateway: { baseUrl: 'https://gw/v1', apiKey: 'secret-key', sessionId: 'run-1' },
  limits: { steps: 50, wallClockMs: 60_000, tokens: 1_000_000, graceTurns: 1 },
  workdir: '/work/omni',
})

test('start writes the patch, finish server and task, spawns headless with the key in env only, and reads the session', async () => {
  const sb = new FakeSandboxDriver()
  const lines = fixture('finish.ndjson')
  sb.onExec = (cmd) => (cmd[2]?.startsWith('head -n 1') ? { stdoutTail: lines[0] ?? '' } : undefined)
  const driver = new DshDriver({ sandbox: sb, finishMcp: '// bundle' })
  const session = await driver.start(start(sb))
  expect(session.id).toMatch(/^session-/)
  expect(sb.files.get('/tmp/nightshift-dsh/message.md')).toBe('Fix FOR-1')
  expect(sb.files.get('/tmp/nightshift-dsh/finish-mcp.mjs')).toBe('// bundle')
  expect(sb.files.get('/tmp/nightshift-dsh/patch.yml')).toContain('personaSuffix: "Implement the issue."')
  expect(JSON.stringify([...sb.files.values()])).not.toContain('secret-key')
  const spawn = sb.spawns[0]
  expect(spawn?.cmd[2]).toContain('dsh-worker --profile headless --patch "$p" --json "$@" -')
  expect(spawn?.opts.env?.NIGHTSHIFT_GATEWAY_KEY).toBe('secret-key')
  expect(spawn?.cmd.slice(4)).toEqual([
    '/tmp/nightshift-dsh/patch.yml',
    '/tmp/nightshift-dsh/message.md',
    DSH_EVENTS,
  ])
})

test('events stream the file in order and end with the finish payload; send resumes the session', async () => {
  const sb = new FakeSandboxDriver()
  const lines = fixture('finish.ndjson')
  const payload = { status: 'DONE', summary: 'ok', evidence: [] }
  sb.onExec = (cmd) => {
    if (cmd[2]?.startsWith('head -n 1')) return { stdoutTail: lines[0] ?? '' }
    if (cmd[2]?.startsWith('tail -n +')) {
      const from = Number(cmd[4]) - 1
      return { stdoutTail: lines.slice(from, from + Number(cmd[6])).join('\n') }
    }
    if (cmd[0] === 'cat' && cmd[1] === DSH_FINISH_FILE) return { stdoutTail: JSON.stringify(payload) }
    return undefined
  }
  const driver = new DshDriver({ sandbox: sb, finishMcp: '', pollMs: 1 })
  const session = await driver.start(start(sb))
  const events: HarnessEvent[] = []
  for await (const e of driver.events(session)) events.push(e)
  expect(events.at(-1)).toEqual({ kind: 'finish', payload })
  expect(events.filter((e) => e.kind === 'tool_call').length).toBeGreaterThan(1)

  await driver.send(session, 'continue')
  expect(sb.files.get('/tmp/nightshift-dsh/message.md')).toBe('continue')
  expect(sb.spawns[1]?.cmd.slice(-2)).toEqual(['--session-id', session.id])
})

test('stop kills the recorded dsh pid', async () => {
  const sb = new FakeSandboxDriver()
  sb.onExec = (cmd) =>
    cmd[2]?.startsWith('head -n 1') ? { stdoutTail: fixture('finish.ndjson')[0] ?? '' } : undefined
  const driver = new DshDriver({ sandbox: sb, finishMcp: '' })
  const session = await driver.start(start(sb))
  await driver.stop(session, 'user')
  expect(sb.execs.at(-1)?.cmd[2]).toContain('kill -TERM')
  expect(sb.execs.find((e) => e.cmd[2]?.startsWith('printf %s'))?.cmd.slice(4)).toEqual([
    '42',
    '/tmp/nightshift-dsh/pid',
  ])
})
