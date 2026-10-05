import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildGuardPlugin } from '../agents/opencode-plugin/build'
import { runClaudeHook } from './claude-hook'
import plugin, { guardToolCall, type ToolCall } from './opencode-plugin'

const NO_VERIFY = '## Goal\nx\n'
const hookJson = (command: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, ...extra })

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linear-guard-'))
  writeFileSync(join(dir, 'bad.md'), NO_VERIFY)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('OpenCode plugin', () => {
  async function hooked(options?: unknown) {
    const hooks: ((call: ToolCall) => void | Promise<void>)[] = []
    await plugin.setup({ options, tool: { hook: (_event, fn) => hooks.push(fn) } })
    return async (call: ToolCall) => {
      for (const h of hooks) await h(call)
    }
  }

  test('throws the guard message for a blocked shell command', async () => {
    const run = await hooked()
    await expect(
      run({ tool: 'shell', input: { command: 'linear issue update XXX-1 --state Done' } }),
    ).rejects.toThrow('linear-guard: status is set by the supervisor')
  })

  test('reads the description file relative to the shell workdir', () => {
    expect(() =>
      guardToolCall({
        tool: 'bash',
        input: { command: 'linear issue update XXX-1 --description-file bad.md', workdir: dir },
      }),
    ).toThrow('linear-guard: XXX-1: missing section ## Why')
  })

  test('passes reads and other tools', async () => {
    const run = await hooked()
    await expect(run({ tool: 'shell', input: { command: 'linear issue list --json | jq .' } })).resolves.toBe(
      undefined,
    )
    await expect(run({ tool: 'read', input: { filePath: 'linear issue delete' } })).resolves.toBe(undefined)
  })

  test('forwards allowNoDesign from the plugin options', async () => {
    const file = join(dir, 'nodesign.md')
    writeFileSync(
      file,
      [
        '## Goal\nx',
        '## Why\nx',
        '## Design excerpt\nnone',
        '## Interfaces in\nnone',
        '## Interfaces out\nnone',
        '## Files\n- a.ts',
        '## Constraints\nnone',
        '## Out of scope\nnone',
        '## Acceptance criteria\n- x',
        '## Tests expected\n- x',
        '## Verify\n- `bun test`',
      ].join('\n\n'),
    )
    const call = { tool: 'shell', input: { command: `linear issue update XXX-1 --description-file ${file}` } }
    await expect((await hooked())(call)).rejects.toThrow("'none' is not allowed")
    await expect((await hooked({ allowNoDesign: true }))(call)).resolves.toBe(undefined)
  })

  test('bundles to a self-contained module', async () => {
    const code = await buildGuardPlugin()
    expect(code).not.toMatch(/from ["'](yaml|\.\.?\/)/)
    const file = join(dir, 'index.js')
    writeFileSync(file, code)
    const mod = await import(file)
    expect(mod.default.id).toBe('linear-guard')
  })
})

describe('Claude Code hook', () => {
  const deps = { readFile: () => NO_VERIFY, cwd: '/' }

  test('exits 2 with the message on stderr for a blocked command', () => {
    expect(runClaudeHook(hookJson('linear issue delete XXX-1'), deps)).toEqual({
      code: 2,
      stderr: 'linear-guard: deleting is not allowed',
    })
  })

  test('exits 0 for reads and non-Bash tools', () => {
    expect(runClaudeHook(hookJson('linear issue view XXX-1 --json | jq .title'), deps)).toEqual({
      code: 0,
      stderr: '',
    })
    expect(
      runClaudeHook(JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/x' } }), deps),
    ).toEqual({ code: 0, stderr: '' })
  })

  test('resolves description files against the hook cwd', () => {
    const r = runClaudeHook(hookJson('linear issue update XXX-1 --description-file bad.md', { cwd: dir }), {
      readFile: (p) => (p === join(dir, 'bad.md') ? NO_VERIFY : ''),
      cwd: '/',
    })
    expect(r.code).toBe(2)
    expect(r.stderr).toStartWith('linear-guard: XXX-1: missing section ## Why')
  })

  test('fails closed on input that is not JSON', () => {
    expect(runClaudeHook('nope', deps).code).toBe(2)
  })

  test('bin/linear-guard exits 2 with the message on stderr', () => {
    const bin = join(import.meta.dir, '..', '..', '..', '..', 'bin', 'linear-guard')
    const proc = Bun.spawnSync([bin], { stdin: Buffer.from(hookJson('linear issue delete XXX-1')) })
    expect(proc.exitCode).toBe(2)
    expect(proc.stderr.toString().trim()).toBe('linear-guard: deleting is not allowed')
  })
})
