import { describe, expect, test } from 'bun:test'
import type { ImplementResponse } from '@nightshift/supervisor'
import { ControlFailure, type ControlFn } from '../client'
import { type CliDeps, run } from '../run'

const USAGE =
  'ns implement <issue> [--with-dependents] | ns implement <project> --merge manual|auto [--profile P]'
const PROJECT = 'Omni · offline sync'
const PLAN: ImplementResponse = {
  ready: ['FOR-1', 'FOR-2'],
  waiting: ['FOR-3'],
  warnings: ['FOR-4 has no estimate'],
}

function setup(result: unknown | Error = PLAN, answer = true) {
  const calls: unknown[][] = []
  const prompts: string[] = []
  const control = (async (_path: string, method: string, route: string, body?: unknown) => {
    calls.push([method, route, body])
    if (result instanceof Error) throw result
    return route === '/cover' ? { ok: true } : result
  }) as ControlFn
  const deps: CliDeps = {
    socketPath: () => '/nonexistent/nightshift.sock',
    control,
    confirm: async (q) => {
      prompts.push(q)
      return answer
    },
    stdoutIsTTY: false,
    env: {},
  }
  return { calls, prompts, deps }
}

async function cli(args: string[], deps: CliDeps) {
  const out: string[] = []
  const err: string[] = []
  const code = await run(args, { out: (l) => out.push(l), err: (l) => err.push(l) }, deps)
  return { code, out, err }
}

describe('ns implement <project>', () => {
  test('posts the project and merge mode and prints ready, waiting and warnings', async () => {
    const s = setup()
    const r = await cli(['implement', PROJECT, '--merge', 'auto'], s.deps)
    expect(r).toEqual({
      code: 0,
      out: ['ready now: FOR-1, FOR-2\nwaiting on blockers: FOR-3\nwarning: FOR-4 has no estimate'],
      err: [],
    })
    expect(s.prompts).toEqual([
      `Let nightshift implement project ${PROJECT} with merge mode auto? This changes Linear state of its issues.`,
    ])
    expect(s.calls).toEqual([['POST', '/implement', { project: PROJECT, merge_mode: 'auto' }]])
  })

  test('--yes skips the confirmation; empty waiting is omitted', async () => {
    const s = setup({ ready: ['FOR-1'], waiting: [], warnings: [] })
    const r = await cli(['implement', PROJECT, '--merge', 'auto', '--yes'], s.deps)
    expect(r).toEqual({ code: 0, out: ['ready now: FOR-1'], err: [] })
    expect(s.prompts).toEqual([])
    expect(s.calls).toEqual([['POST', '/implement', { project: PROJECT, merge_mode: 'auto' }]])
  })

  test('--json prints the response', async () => {
    const s = setup()
    const r = await cli(['implement', PROJECT, '--merge', 'manual', '--json'], s.deps)
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out.join('\n'))).toEqual(PLAN)
  })

  test('--profile is forwarded and named in the question', async () => {
    const s = setup()
    const r = await cli(['implement', PROJECT, '--merge=manual', '--profile', 'quality'], s.deps)
    expect(r.code).toBe(0)
    expect(s.prompts).toEqual([
      `Let nightshift implement project ${PROJECT} with merge mode manual and profile quality? This changes Linear state of its issues.`,
    ])
    expect(s.calls).toEqual([
      ['POST', '/implement', { project: PROJECT, merge_mode: 'manual', profile: 'quality' }],
    ])
  })

  test('a refusal exits 5 with the plan errors and posts nothing else', async () => {
    const errors = 'FOR-2 has no acceptance criteria\nFOR-3 blocks itself'
    const s = setup(new ControlFailure(5, errors, 'refused'))
    const r = await cli(['implement', PROJECT, '--merge', 'auto', '--yes'], s.deps)
    expect(r).toEqual({ code: 5, out: [], err: [errors] })
    expect(s.calls).toEqual([['POST', '/implement', { project: PROJECT, merge_mode: 'auto' }]])
  })

  test('missing or invalid --merge exits 2 with the usage and posts nothing', async () => {
    for (const args of [
      ['implement', PROJECT],
      ['implement', PROJECT, '--merge', 'feature-branch'],
    ]) {
      const s = setup()
      const r = await cli([...args, '--yes'], s.deps)
      expect(r.code).toBe(2)
      expect(r.err.join('\n')).toContain(USAGE)
      expect(s.calls).toEqual([])
    }
  })

  test('--merge and --profile with an issue identifier exit 2; --with-dependents with a project exits 2', async () => {
    for (const args of [
      ['implement', 'FOR-1', '--merge', 'auto'],
      ['implement', 'FOR-1', '--profile', 'quality'],
      ['implement', PROJECT, '--merge', 'auto', '--with-dependents'],
    ]) {
      const s = setup()
      const r = await cli([...args, '--yes'], s.deps)
      expect(r.code).toBe(2)
      expect(s.calls).toEqual([])
    }
  })

  test('a declined confirmation exits 1 without a post', async () => {
    const s = setup(PLAN, false)
    const r = await cli(['implement', PROJECT, '--merge', 'auto'], s.deps)
    expect(r).toEqual({ code: 1, out: [], err: ['aborted'] })
    expect(s.calls).toEqual([])
  })

  test('an identifier still covers the issue', async () => {
    const s = setup()
    const r = await cli(['implement', 'FOR-1', '--yes'], s.deps)
    expect(r).toEqual({
      code: 0,
      out: ['FOR-1 is covered; the supervisor picks it up on its next tick'],
      err: [],
    })
    expect(s.calls).toEqual([['POST', '/cover', { issue: 'FOR-1', covered: true }]])
  })
})
