import { describe, expect, test } from 'bun:test'
import type { ApplyOp, Config, LinearCustomView, LinearLabel, LinearWorkspace } from '@nightshift/core'
import type { DoctorDeps, DoctorLinear } from './doctor'
import { run } from './run'

const statuses = {
  triage: 'Triage',
  backlog: 'Backlog',
  ready: 'Todo',
  running: 'In Progress',
  review: 'In Review',
  blocked: 'Blocked',
  done: 'Done',
  canceled: 'Canceled',
}

const config = {
  gateway: { api_key: 'env:NS_GATEWAY_KEY' },
  linear: {
    auth: { mode: 'api_key', api_key: 'env:NS_LINEAR_KEY' },
    act_on: { delegated: true, labels: ['autopilot'] },
    statuses,
    teams: [],
  },
  github: { accounts: { me: { token: 'rbw:github' } } },
  secrets: { rbw_profile: 'nightshift' },
  stages: { implementation: { automatic: true } },
  projects: [{ repositories: ['omni'] }],
} as unknown as Config

const SECRET_VALUE = 'lin_api_supersecret'

function group(id: string, name: string, labels: string[]): LinearLabel[] {
  return [
    { id, name, isGroup: true, parentId: null, teamId: null },
    ...labels.map((l) => ({ id: `${id}-${l}`, name: l, isGroup: false, parentId: id, teamId: null })),
  ]
}

function workspace(without: string[] = []): LinearWorkspace {
  const types: [string, string][] = [
    ['Triage', 'triage'],
    ['Backlog', 'backlog'],
    ['Todo', 'unstarted'],
    ['In Progress', 'started'],
    ['In Review', 'started'],
    ['Blocked', 'started'],
    ['Done', 'completed'],
    ['Canceled', 'canceled'],
  ]
  return {
    organization: { id: 'o', name: 'h-cloud', urlKey: 'h-cloud', plan: 'basic' },
    teams: [
      {
        id: 't-FRG',
        key: 'FRG',
        name: 'Forge',
        statuses: types
          .filter(([name]) => !without.includes(name))
          .map(([name, type]) => ({ id: `FRG-${name}`, name, type })),
      },
    ],
    labels: [
      { id: 'autopilot', name: 'autopilot', isGroup: false, parentId: null, teamId: null },
      ...group('stage', 'ai-stage', ['implementation']),
    ],
    projectLabels: group('merge', 'ai-merge', ['manual', 'auto', 'feature-branch']),
    projects: [],
    initiatives: [],
    templates: [{ id: 'agent', name: 'Agent task', type: 'issue', teamId: null }],
  }
}

const views: LinearCustomView[] = ['Needs me', 'Running', 'Ready', 'In Review'].map((name) => ({
  id: name,
  name,
}))

function fakeLinear(ws: LinearWorkspace, fail?: (op: ApplyOp) => string | undefined) {
  const calls: { ops: ApplyOp[]; opts: { confirm: boolean } }[] = []
  const linear: DoctorLinear = {
    workspace: async () => structuredClone(ws),
    customViews: async () => views,
    apply: async (ops, opts) => {
      calls.push({ ops, opts })
      const created = []
      for (const [i, op] of ops.entries()) {
        const error = fail?.(op)
        if (error) return { applied: true, created, failed: { op, error }, pending: ops.slice(i + 1) }
        if (op.kind !== 'status') throw new Error(`fake cannot create ${op.kind}`)
        ws.teams
          .find((t) => t.key === op.team)
          ?.statuses.push({ id: `new-${op.name}`, name: op.name, type: op.type })
        created.push({ op, id: `new-${op.name}` })
      }
      return { applied: true, created, failed: null, pending: [] }
    },
  }
  return { linear, calls }
}

function deps(linear: DoctorLinear, over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    load: () => ({ ok: true, config, sources: ['config.yaml'] }),
    secret: () => async () => SECRET_VALUE,
    linear: () => linear,
    interactive: () => true,
    which: (bin) => `/usr/bin/${bin}`,
    host: async () => [{ name: 'docker', ok: true, detail: 'server 29' }],
    confirm: async () => {
      throw new Error('confirm not expected')
    },
    ...over,
  }
}

async function capture(args: string[], d: DoctorDeps) {
  const out: string[] = []
  const err: string[] = []
  const code = await run(['doctor', ...args], { out: (s) => out.push(s), err: (s) => err.push(s) }, d)
  return { code, out, err }
}

describe('ns doctor', () => {
  test('a workspace without Blocked is an error with a fix line, sorted by severity', async () => {
    const { linear } = fakeLinear(workspace(['Blocked']))
    const r = await capture([], deps(linear))
    expect(r.code).toBe(1)
    expect(r.out[0]).toBe('error: team FRG: status Blocked missing')
    expect(r.out[1]).toBe('  fix: nightshift doctor --apply creates it')
    const severities = r.out.filter((l) => !l.startsWith(' ')).map((l) => l.split(':')[0])
    expect(severities.indexOf('info')).toBeGreaterThan(severities.lastIndexOf('error'))
    expect(r.out.at(-1)).toBe('1 changes planned: run nightshift doctor --apply')
  })

  test('failed host checks are errors with their fix and exit 1; warnings do not fail', async () => {
    const { linear } = fakeLinear(workspace())
    const host = async () => [
      {
        name: 'docker',
        ok: false,
        detail: 'not running',
        fix: 'start the Docker daemon: sudo systemctl start docker',
      },
      {
        name: 'rbw',
        ok: false,
        detail: 'profile nightshift is locked',
        fix: 'run RBW_PROFILE=nightshift rbw unlock',
      },
      { name: 'disk cache', ok: false, warning: true, detail: '3 GB free under /x' },
      { name: 'opencode', ok: true, detail: '2.0.22' },
    ]
    const r = await capture([], deps(linear, { host }))
    expect(r.code).toBe(1)
    expect(r.out.slice(0, 4)).toEqual([
      'error: docker: not running',
      '  fix: start the Docker daemon: sudo systemctl start docker',
      'error: rbw: profile nightshift is locked',
      '  fix: run RBW_PROFILE=nightshift rbw unlock',
    ])
    expect(r.out).toContain('warning: disk cache: 3 GB free under /x')
    expect(r.out).toContain('info: opencode: 2.0.22')
    const warnOnly = await capture([], deps(linear, { host: async () => [(await host())[2]] as never }))
    expect(warnOnly.code).toBe(0)
  })

  test('a missing host tool is a warning', async () => {
    const { linear } = fakeLinear(workspace())
    const r = await capture([], deps(linear, { which: (bin) => (bin === 'node' ? null : `/usr/bin/${bin}`) }))
    expect(r.code).toBe(0)
    expect(r.out).toContain('warning: node not found on PATH: ns env build runs @devcontainers/cli on Node')
  })

  test('a complete workspace exits 0 and plans nothing', async () => {
    const { linear } = fakeLinear(workspace())
    const r = await capture([], deps(linear))
    expect(r.code).toBe(0)
    expect(r.out.filter((l) => l.startsWith('error'))).toEqual([])
    expect(r.out.some((l) => l.includes('changes planned'))).toBe(false)
  })

  test('unresolvable secrets are named without values and Linear is not read', async () => {
    const r = await capture(
      [],
      deps(
        {
          ...fakeLinear(workspace()).linear,
          workspace: () => {
            throw new Error('linear read without auth')
          },
        },
        {
          secret: () => async (ref) => {
            if (ref.startsWith('rbw:')) throw new Error('rbw profile nightshift is locked')
            if (ref === 'env:NS_LINEAR_KEY') throw new Error('environment variable NS_LINEAR_KEY is not set')
            return SECRET_VALUE
          },
        },
      ),
    )
    expect(r.code).toBe(1)
    expect(r.out).toContain('error: linear.auth.api_key: environment variable NS_LINEAR_KEY is not set')
    expect(r.out).toContain('error: github.accounts.me.token: rbw profile nightshift is locked')
    expect(r.out.join('\n')).not.toContain(SECRET_VALUE)
  })

  test('a Linear read failure is an error finding', async () => {
    const { linear } = fakeLinear(workspace())
    const r = await capture(
      [],
      deps({
        ...linear,
        workspace: async () => {
          throw new Error('linear.auth: Linear rejected the credentials')
        },
      }),
    )
    expect(r.code).toBe(1)
    expect(r.out[0]).toBe('error: linear: linear.auth: Linear rejected the credentials')
  })

  test('config errors are reported as findings', async () => {
    const { linear } = fakeLinear(workspace())
    const r = await capture(
      [],
      deps(linear, { load: () => ({ ok: false, errors: [{ path: 'linear.auth', message: 'missing' }] }) }),
    )
    expect(r).toMatchObject({ code: 1, out: ['error: linear.auth: missing'] })
  })
})

describe('ns doctor --apply', () => {
  test('shows every planned op before asking and writes nothing when declined', async () => {
    const { linear, calls } = fakeLinear(workspace(['Blocked', 'Todo']))
    const out: string[] = []
    const asked: { question: string; shown: string[] }[] = []
    const ask = async (question: string) => {
      asked.push({ question, shown: [...out] })
      return false
    }
    const code = await run(
      ['doctor', '--apply'],
      { out: (s) => out.push(s), err: () => {} },
      deps(linear, { confirm: ask }),
    )
    expect(asked.map((a) => a.question)).toEqual(['apply 2 changes to workspace h-cloud? [y/N] '])
    expect(asked[0]?.shown.filter((l) => l.startsWith('plan: '))).toEqual([
      'plan: create status Todo (unstarted) in team FRG',
      'plan: create status Blocked (started) in team FRG after In Review',
    ])
    expect(calls).toEqual([])
    expect(out.at(-1)).toBe('nothing applied')
    expect(code).toBe(1)
  })

  test('--yes applies with confirm: true, prints created objects, and a second run has nothing to apply', async () => {
    const ws = workspace(['Blocked'])
    const { linear, calls } = fakeLinear(ws)
    const r = await capture(['--apply', '--yes'], deps(linear, { interactive: () => false }))
    expect(r.code).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.opts).toEqual({ confirm: true })
    expect(calls[0]?.ops.map((o) => o.kind === 'status' && o.name)).toEqual(['Blocked'])
    expect(r.out.at(-1)).toBe('created status Blocked (started) in team FRG after In Review (new-Blocked)')

    const again = await capture(['--apply', '--yes'], deps(linear))
    expect(again.code).toBe(0)
    expect(again.out.at(-1)).toBe('nothing to apply')
    expect(calls).toHaveLength(1)
  })

  test('a non-TTY stdin without --yes refuses', async () => {
    const { linear, calls } = fakeLinear(workspace(['Blocked']))
    const r = await capture(['--apply'], deps(linear, { interactive: () => false }))
    expect(r.code).toBe(1)
    expect(r.err).toEqual(['refusing to apply without confirmation (use --yes)'])
    expect(calls).toEqual([])
  })

  test('a failure mid-apply prints the failed op with the error and the remaining ops', async () => {
    const { linear } = fakeLinear(workspace(['Todo', 'Blocked', 'Canceled']), (op) =>
      op.kind === 'status' && op.name === 'Blocked' ? 'Entity not found: team' : undefined,
    )
    const r = await capture(['--apply'], deps(linear, { confirm: async () => true }))
    expect(r.code).toBe(1)
    expect(r.out.slice(-3)).toEqual([
      'created status Todo (unstarted) in team FRG (new-Todo)',
      'failed: create status Blocked (started) in team FRG after In Review: Entity not found: team',
      'not applied: create status Canceled (canceled) in team FRG',
    ])
  })

  test('--json prints one JSON object without colour codes', async () => {
    const { linear } = fakeLinear(workspace(['Blocked']))
    const r = await capture(['--apply', '--yes', '--json'], deps(linear))
    expect(r.code).toBe(0)
    expect(r.out).toHaveLength(1)
    const line = r.out[0] ?? ''
    expect(line).not.toContain('\u001b[')
    const parsed = JSON.parse(line)
    expect(Object.keys(parsed)).toEqual(['findings', 'host', 'ops', 'result'])
    expect(parsed.ops).toHaveLength(1)
    expect(parsed.result.created).toHaveLength(1)
  })
})
