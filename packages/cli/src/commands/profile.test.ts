import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '@nightshift/core'
import { openState } from '@nightshift/supervisor'
import { ControlFailure, type ControlFn } from '../client'
import { type CliDeps, run } from '../run'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const profiles = {
  active: 'local',
  memory_budget_gb: 96,
  local: {
    roles: { worker: 'coder', reviewer: 'critic' },
    models: {
      coder: { model: 'qwen-coder', family: 'qwen', size_gb: 40, phases: ['implementation'] },
      critic: { model: 'glm-air', family: 'glm', size_gb: 30, phases: ['planning', 'implementation'] },
    },
  },
  cloud: {
    roles: { worker: 'big', reviewer: 'big2' },
    models: {
      big: { model: 'claude-opus', family: 'claude', size_gb: 0, phases: ['planning', 'implementation'] },
      big2: { model: 'gpt-5', family: 'gpt', size_gb: 0, phases: ['implementation'] },
    },
  },
  fast: {
    roles: { worker: 'coder', reviewer: 'coder2' },
    models: {
      coder: { model: 'qwen-coder', family: 'qwen', size_gb: 20, phases: ['planning', 'implementation'] },
      coder2: { model: 'qwen-coder', family: 'qwen', size_gb: 20, phases: ['implementation'] },
    },
  },
}

function setup(active?: string, control?: ControlFn) {
  const dir = mkdtempSync(join(tmpdir(), 'ns-profile-'))
  dirs.push(dir)
  const dbPath = join(dir, 'state.db')
  if (active) {
    const db = openState(dbPath)
    db.query("INSERT INTO meta (key, value) VALUES ('active_profile', ?)").run(active)
    db.close()
  }
  const config = { paths: { state: dir, cache: dir, vault: dir }, profiles } as unknown as Config
  const deps: CliDeps = {
    statePath: () => dbPath,
    socketPath: () => join(dir, 'nightshift.sock'),
    load: () => ({ ok: true, config, sources: [] }),
    now: () => new Date('2026-10-13T10:00:00.000Z'),
    stdoutIsTTY: false,
    env: {},
    ...(control ? { control } : {}),
  }
  return deps
}

async function cli(args: string[], deps: CliDeps) {
  const out: string[] = []
  const err: string[] = []
  const code = await run(args, { out: (l) => out.push(l), err: (l) => err.push(l) }, deps)
  return { code, out, err }
}

function recording(result: unknown | Error) {
  const calls: unknown[][] = []
  const control = (async (_path: string, method: string, route: string, body?: unknown) => {
    calls.push([method, route, body])
    if (result instanceof Error) throw result
    return result
  }) as ControlFn
  return { calls, control }
}

describe('ns profile list', () => {
  test('marks the active profile from the state database', async () => {
    const r = await cli(['profile', 'list'], setup('cloud'))
    expect(r.code).toBe(0)
    expect(r.out).toEqual([
      '  local  worker=coder,reviewer=critic  qwen,glm',
      '* cloud  worker=big,reviewer=big2      claude,gpt',
      '  fast   worker=coder,reviewer=coder2  qwen',
    ])
  })

  test('falls back to the configured active profile without a state database', async () => {
    const r = await cli(['profile', 'list'], setup())
    expect(r.out[0]?.startsWith('* local')).toBe(true)
  })

  test('--json', async () => {
    const r = await cli(['--json', 'profile', 'list'], setup('cloud'))
    expect(JSON.parse(r.out.join('\n'))).toEqual([
      { name: 'local', active: false, roles: profiles.local.roles },
      { name: 'cloud', active: true, roles: profiles.cloud.roles },
      { name: 'fast', active: false, roles: profiles.fast.roles },
    ])
  })
})

describe('ns profile show', () => {
  test('without a name shows the active profile with memory per phase', async () => {
    const r = await cli(['profile', 'show'], setup('local'))
    expect(r).toEqual({
      code: 0,
      out: [
        'profile: local (active)',
        'worker    coder   qwen-coder  qwen',
        'reviewer  critic  glm-air     glm',
        'memory: planning 30 GB, implementation 70 GB (budget 96 GB)',
      ],
      err: [],
    })
  })

  test('a named profile from config without a running supervisor; one model counts once', async () => {
    const r = await cli(['profile', 'show', 'fast'], setup('local'))
    expect(r.code).toBe(0)
    expect(r.out[0]).toBe('profile: fast')
    expect(r.out.at(-1)).toBe('memory: planning 20 GB, implementation 20 GB (budget 96 GB)')
  })

  test('--json', async () => {
    const r = await cli(['--json', 'profile', 'show', 'cloud'], setup('cloud'))
    expect(JSON.parse(r.out.join('\n'))).toEqual({
      name: 'cloud',
      active: true,
      roles: [
        { role: 'worker', alias: 'big', model: 'claude-opus', family: 'claude' },
        { role: 'reviewer', alias: 'big2', model: 'gpt-5', family: 'gpt' },
      ],
      memory: { planning: 0, implementation: 0, budget: 96 },
    })
  })

  test('an unknown name exits 4', async () => {
    expect(await cli(['profile', 'show', 'nope'], setup('local'))).toEqual({
      code: 4,
      out: [],
      err: ["no profile 'nope'"],
    })
  })
})

describe('ns profile use', () => {
  test('posts the name and prints the new and previous profile', async () => {
    const rec = recording({ active: 'fast', previous: 'local' })
    const r = await cli(['profile', 'use', 'fast'], setup('local', rec.control))
    expect(rec.calls).toEqual([['POST', '/profile', { use: 'fast' }]])
    expect(r).toEqual({
      code: 0,
      out: ['active profile: fast (was local); applies to new dispatches'],
      err: [],
    })
    const json = await cli(['--json', 'profile', 'use', 'fast'], setup('local', rec.control))
    expect(JSON.parse(json.out.join('\n'))).toEqual({ active: 'fast', previous: 'local' })
  })

  test('a refusal exits 5 with its message', async () => {
    const rec = recording(new ControlFailure(5, "no profile 'nope'", 'refused'))
    expect(await cli(['profile', 'use', 'nope'], setup('local', rec.control))).toEqual({
      code: 5,
      out: [],
      err: ["no profile 'nope'"],
    })
  })

  test('exits 3 when the supervisor is down', async () => {
    expect((await cli(['profile', 'use', 'fast'], setup('local'))).code).toBe(3)
  })
})

describe('ns profile usage', () => {
  test('no, unknown or incomplete subcommands exit 2 with the usage', async () => {
    for (const args of [[], ['frob'], ['use'], ['list', 'x'], ['show', 'a', 'b']]) {
      const r = await cli(['profile', ...args], setup('local'))
      expect(r.code).toBe(2)
      expect(r.err.join('\n')).toContain('ns profile list | show [<name>] | use <name>')
    }
  })
})
