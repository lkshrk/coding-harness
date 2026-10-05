import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUlid, EventLog, openState, RunStore } from '@nightshift/supervisor'
import { createCtx } from './cli'
import { syncPanes } from './commands/watch'
import { type CliDeps, run } from './run'
import { Tmux, type TmuxRunner } from './tmux'

type Call = string[]

function fakeTmux(panes: string[] = []) {
  const calls: Call[] = []
  let next = 10
  const listed = [...panes]
  const runner: TmuxRunner = (argv) => {
    calls.push(argv)
    const args = argv.slice(3)
    if (args[0] === 'has-session') return { exitCode: 1, stdout: '', stderr: 'no session' }
    if (args[0] === 'list-panes') return { exitCode: 0, stdout: listed.join('\n'), stderr: '' }
    if (args[0] === 'split-window' || args[0] === 'new-window') {
      next += 1
      return { exitCode: 0, stdout: `%${next}\n`, stderr: '' }
    }
    if (args[0] === 'show-options') return { exitCode: 0, stdout: 'XXX-42\n', stderr: '' }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  return { calls, runner, listed }
}

describe('tmux command builder', () => {
  test('uses a private tmux server so options and the key binding stay out of the user sessions', () => {
    const t = fakeTmux()
    new Tmux(t.runner).createSession(['ns', 'watch', '--manage'], ['ns', 'watch', '--swap'])
    expect(t.calls.every((c) => c[0] === 'tmux' && c[1] === '-L' && c[2] === 'nightshift')).toBe(true)
    expect(t.calls[0]).toEqual([
      'tmux',
      '-L',
      'nightshift',
      'new-session',
      '-d',
      '-s',
      'ns-watch',
      '-n',
      'manager',
      'ns watch --manage',
    ])
    expect(t.calls).toContainEqual(['tmux', '-L', 'nightshift', 'set-option', '-wg', 'remain-on-exit', 'on'])
    expect(t.calls.at(-1)).toEqual([
      'tmux',
      '-L',
      'nightshift',
      'bind-key',
      'a',
      'run-shell',
      "ns watch --swap '#{pane_id}'",
    ])
  })

  test('adds a tiled pane per worker and opens a new window past the pane limit', () => {
    const t = fakeTmux(['%1\t@1\tRUN1\tXXX-1\tXXX-1\t0', '%2\t@1\tRUN2\tXXX-2\tXXX-2\t0'])
    const tmux = new Tmux(t.runner)
    tmux.addPane({ run: 'RUN3', issue: 'XXX-3', command: ['ns', 'tail', 'XXX-3'], maxPanes: 3 })
    expect(t.calls.map((c) => c.slice(3))).toEqual([
      ['list-panes', '-s', '-t', 'ns-watch', '-F', expect.any(String)],
      ['split-window', '-d', '-t', '@1', '-P', '-F', '#{pane_id}', 'ns tail XXX-3'],
      ['set-option', '-p', '-t', '%11', '@ns-run', 'RUN3'],
      ['set-option', '-p', '-t', '%11', '@ns-issue', 'XXX-3'],
      ['select-pane', '-t', '%11', '-T', 'XXX-3'],
      ['select-layout', '-t', '%11', 'tiled'],
    ])
    t.calls.length = 0
    tmux.addPane({ run: 'RUN3', issue: 'XXX-3', command: ['ns', 'tail', 'XXX-3'], maxPanes: 2 })
    expect(t.calls[1]?.slice(3, 9)).toEqual(['new-window', '-d', '-t', 'ns-watch', '-n', 'workers'])
  })
})

describe('ns watch', () => {
  const seeded = () => {
    const dir = mkdtempSync(join(tmpdir(), 'ns-watch-'))
    const dbPath = join(dir, 'state.db')
    const db = openState(dbPath)
    const now = () => new Date('2026-10-04T10:00:00.000Z')
    const runs = new RunStore(db, { now, ulid: createUlid() })
    const log = new EventLog(db, { now, ulid: createUlid() })
    const add = (issue: string) => {
      const r = runs.create({
        issue,
        agent: 'implementer',
        profile: 'default',
        model: 'm',
        repository: 'omni',
        baseSha: '',
        attempt: 1,
      })
      const cause = log.append({ type: 'DISPATCH_PAUSED', data: {} })
      runs.transition(r.id, 'starting', cause)
      return { run: r, finish: () => runs.transition(r.id, 'failed', cause) }
    }
    return { dir, dbPath, add, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
  }

  test('a pane per new worker; finished workers are marked and not reused', () => {
    const s = seeded()
    try {
      const a = s.add('XXX-1')
      const t = fakeTmux()
      const ctx = createCtx(
        { out: () => {}, err: () => {} },
        { json: false, noColor: false, yes: false },
        { statePath: () => s.dbPath, self: ['ns'] },
      )
      const tmux = new Tmux(t.runner)
      expect(syncPanes(ctx, tmux, { issues: [], maxPanes: 6 })).toEqual(['XXX-1'])
      expect(t.calls.find((c) => c[3] === 'new-window')?.at(-1)).toBe('ns --host local tail XXX-1')
      t.listed.push(`%11\t@2\t${a.run.id}\tXXX-1\tXXX-1\t0`)
      const b = s.add('XXX-2')
      a.finish()
      t.calls.length = 0
      expect(syncPanes(ctx, tmux, { issues: [], maxPanes: 6 })).toEqual(['XXX-2'])
      expect(t.calls).toContainEqual([
        'tmux',
        '-L',
        'nightshift',
        'select-pane',
        '-t',
        '%11',
        '-T',
        'XXX-1 [failed]',
      ])
      t.listed.splice(
        0,
        1,
        `%11\t@2\t${a.run.id}\tXXX-1\tXXX-1 [failed]\t1`,
        `%12\t@2\t${b.run.id}\tXXX-2\tXXX-2\t0`,
      )
      t.calls.length = 0
      expect(syncPanes(ctx, tmux, { issues: ['XXX-9'], maxPanes: 6 })).toEqual([])
      expect(t.calls.filter((c) => c[3] !== 'list-panes')).toEqual([])
    } finally {
      s.cleanup()
    }
  })

  test('missing tmux exits 1 with an install hint; an existing session is attached', async () => {
    const s = seeded()
    try {
      const out: string[] = []
      const deps: CliDeps = { statePath: () => s.dbPath, which: () => null }
      const io = { out: (l: string) => out.push(l), err: (l: string) => out.push(l) }
      expect(await run(['watch', '--all'], io, deps)).toBe(1)
      expect(out[0]).toContain('tmux is not installed')
      const execs: string[][] = []
      const calls: string[][] = []
      const code = await run(['watch'], io, {
        ...deps,
        which: () => '/usr/bin/tmux',
        capture: (argv) => {
          calls.push(argv)
          return { exitCode: 0, stdout: '', stderr: '' }
        },
        exec: async (cmd) => {
          execs.push(cmd)
          return 0
        },
      })
      expect(code).toBe(0)
      expect(calls).toEqual([['tmux', '-L', 'nightshift', 'has-session', '-t', 'ns-watch']])
      expect(execs).toEqual([['tmux', '-L', 'nightshift', 'attach-session', '-t', 'ns-watch']])
    } finally {
      s.cleanup()
    }
  })

  test('the attach key swaps the pane to ns attach and back to ns tail', async () => {
    const t = fakeTmux()
    const code = await run(
      ['watch', '--swap', '%11'],
      { out: () => {}, err: () => {} },
      {
        which: () => '/usr/bin/tmux',
        capture: t.runner,
        self: ['ns'],
      },
    )
    expect(code).toBe(0)
    expect(t.calls.at(-1)).toEqual([
      'tmux',
      '-L',
      'nightshift',
      'respawn-pane',
      '-k',
      '-t',
      '%11',
      "sh -c 'ns --host local attach XXX-42; exec ns --host local tail XXX-42'",
    ])
  })
})
