import { describe, expect, test } from 'bun:test'
import type { Config } from '@nightshift/core'
import { remoteHost, shellQuote, sshCommand } from './remote'
import { run } from './run'

const flags = { json: false, noColor: false, yes: false }

describe('ssh command builder', () => {
  test('quotes every argument and drops --host', () => {
    expect(shellQuote("it's fine")).toBe(`'it'\\''s fine'`)
    expect(
      sshCommand('towerr-dev', ['--host', 'towerr-dev', 'send', 'XXX-42', "it's fine"], {
        tty: true,
        env: {},
      }),
    ).toEqual(['ssh', '-t', 'towerr-dev', '--', `ns --host local send XXX-42 'it'\\''s fine'`])
  })

  test('forwards --json and NO_COLOR, and skips the TTY when output is piped', () => {
    expect(sshCommand('h', ['workers', '--json', '--host=h'], { tty: false, env: { NO_COLOR: '' } })).toEqual(
      ['ssh', '-T', 'h', '--', 'env NO_COLOR=1 ns --host local workers --json'],
    )
  })

  test('the default host comes from cli.host for remote-capable commands; --host local overrides it', () => {
    const load = () => ({ ok: true as const, config: { cli: { host: 'towerr-dev' } } as Config, sources: [] })
    expect(remoteHost(flags, { load }, 'watch')).toBe('towerr-dev')
    expect(remoteHost(flags, { load }, 'supervise')).toBeNull()
    expect(remoteHost({ ...flags, host: 'local' }, { load }, 'watch')).toBeNull()
    expect(remoteHost({ ...flags, host: 'other' }, { load }, 'doctor')).toBe('other')
  })
})

test('ns --host re-executes over ssh and returns the remote exit code', async () => {
  const execs: string[][] = []
  const code = await run(
    ['--host', 'towerr-dev', 'workers'],
    { out: () => {}, err: () => {} },
    {
      exec: async (cmd) => {
        execs.push(cmd)
        return 4
      },
      stdoutIsTTY: true,
      env: {},
    },
  )
  expect(code).toBe(4)
  expect(execs).toEqual([['ssh', '-t', 'towerr-dev', '--', 'ns --host local workers']])
})

test('ns --host attach keeps ssh -t and turns the local tmux extended keys off around it', async () => {
  const order: string[][] = []
  const code = await run(
    ['--host', 'towerr-dev', 'attach', 'XXX-360'],
    { out: () => {}, err: () => {} },
    {
      exec: async (cmd) => {
        order.push(cmd)
        return 0
      },
      capture: (argv) => {
        order.push(argv)
        return { exitCode: 0, stdout: argv[1] === 'show-options' ? 'on\n' : '', stderr: '' }
      },
      stdoutIsTTY: true,
      env: { TMUX: '/tmp/tmux-501/default,1,0' },
    },
  )
  expect(code).toBe(0)
  expect(order).toEqual([
    ['tmux', 'show-options', '-sv', 'extended-keys'],
    ['tmux', 'set-option', '-s', 'extended-keys', 'off'],
    ['ssh', '-t', 'towerr-dev', '--', 'ns --host local attach XXX-360'],
    ['tmux', 'set-option', '-s', 'extended-keys', 'on'],
  ])
})
