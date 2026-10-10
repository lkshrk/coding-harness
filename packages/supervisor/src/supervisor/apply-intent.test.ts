import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { API } from 'typescript/unstable/async'
import type { Intent } from '../policy/transition'
import type { Awaiting, IssueUpdate } from '../ports'
import { PullRequestStore } from '../stages/integration/records'
import { EventLog } from '../state/events'
import { RunStore } from '../state/runs'
import { createUlid } from '../state/ulid'
import { snapshot } from '../testing/testing'
import { LinearSync } from './linear-sync'
import { type SupervisorDeps, SupervisorRuntime } from './runtime'
import { harness } from './testing'

const root = join(import.meta.dir, '..')

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'testing' ? [] : sources(path)
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : []
  })
}

const repo = join(root, '..', '..', '..')
const LINEAR_SYNC = join(root, 'supervisor', 'linear-sync.ts')
const ADAPTER = join(root, 'adapters', 'linear', 'linear-adapter.ts')

type Writer = { file: string; pos: number; via: 'LinearPort' | 'LinearWriter' }

// Resolves every identifier and string token of the supervisor sources with the TypeScript checker
// and reports each one whose symbol or type is LinearPort.update, or core's LinearWriter.update
// that the port wraps. Receivers are matched by type, so aliases, destructuring, Pick<> parameters,
// bracket access and `.call` are all caught whatever the variable is named. `overrides` replaces
// file contents, so a test can inject a bypass into a real module.
async function linearWriters(overrides: Record<string, string> = {}): Promise<{
  inside: Writer[]
  outside: Writer[]
}> {
  const api = new API({ cwd: repo, fs: { readFile: (file) => overrides[file] } })
  try {
    const snap = await api.updateSnapshot({ openProjects: [join(repo, 'packages/supervisor/tsconfig.json')] })
    const project = snap.getProjects()[0]
    if (!project) throw new Error('supervisor project not loaded')
    const { checker, program } = project
    const text = async (file: string) => {
      const source = await program.getSourceFile(file)
      if (!source) throw new Error(`${file} is not in the supervisor program`)
      return source.text
    }
    const member = async (file: string, pattern: RegExp) => {
      const pos = (await text(file)).search(pattern)
      const symbol = pos >= 0 ? await checker.getSymbolAtPosition(file, pos) : undefined
      if (!symbol) throw new Error(`no symbol for ${pattern} in ${file}`)
      const type = await checker.getTypeOfSymbol(symbol)
      return { file, pos, symbol: symbol.id, type: type?.id, node: symbol.valueDeclaration }
    }
    const targets = {
      LinearPort: await member(join(root, 'ports', 'linear.ts'), /\bupdate(?=\(identifier)/),
      LinearWriter: await member(
        join(repo, 'packages/core/src/linear/writes.ts'),
        /\bupdate(?=\(identifier)/,
      ),
    }
    const apply = await member(LINEAR_SYNC, /\bapplyIntent(?=\(identifier)/)
    const body = await apply.node?.resolve()
    if (!body) throw new Error('applyIntent has no declaration')
    const inside: Writer[] = []
    const outside: Writer[] = []
    for (const file of sources(root)) {
      const positions = [...(await text(file)).matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m.index ?? 0)
      if (!positions.length) continue
      const symbols = await checker.getSymbolAtPosition(file, positions)
      const types = await checker.getTypeAtPosition(file, positions)
      positions.forEach((pos, i) => {
        for (const via of ['LinearPort', 'LinearWriter'] as const) {
          const t = targets[via]
          if (file === t.file && pos === t.pos) continue
          const hit = symbols[i]?.id === t.symbol || (t.type !== undefined && types[i]?.id === t.type)
          if (!hit) continue
          const writer = { file: relative(root, file), pos, via }
          if (via === 'LinearPort' && file === LINEAR_SYNC && pos > body.pos && pos < body.end)
            inside.push(writer)
          // The Linear adapter implements the port on top of LinearWriter.
          else if (!(via === 'LinearWriter' && file === ADAPTER)) outside.push(writer)
        }
      })
    }
    return { inside, outside }
  } finally {
    await api.close()
  }
}

const HOLDS = join(root, 'supervisor', 'holds.ts')
const inject = (code: string) => ({ [HOLDS]: `${readFileSync(HOLDS, 'utf8')}\n${code}\n` })

describe('applyIntent is the only Linear writer', () => {
  test('no module calls linear.update, writeStatus or relabel outside applyIntent', async () => {
    const offenders: string[] = []
    for (const file of sources(root)) {
      if (/\b(writeStatus|relabel)\b/.test(readFileSync(file, 'utf8')))
        offenders.push(`${relative(root, file)}: writeStatus/relabel`)
    }
    const found = await linearWriters()
    for (const w of found.outside) offenders.push(`${w.file}@${w.pos}: ${w.via}.update outside applyIntent`)
    expect(offenders, offenders.join('\n')).toEqual([])
    expect(found.inside.length).toBe(1)
  }, 60_000)

  test('the boundary catches the port however it is reached, not by receiver name', async () => {
    const bypasses = [
      'export async function zz(rt: SupervisorRuntime) { const port = rt.deps.linear; await port.update("x", {}) }',
      'export async function zz(rt: SupervisorRuntime) { const { update } = rt.deps.linear; await update("x", {}) }',
      'export async function zz(rt: SupervisorRuntime) { const { update: write } = rt.deps.linear; await write("x", {}) }',
      'export async function zz(rt: SupervisorRuntime) { const write = rt.deps.linear.update; await write("x", {}) }',
      'export async function zz(rt: SupervisorRuntime) { const d = rt.deps; await d.linear["update"]("x", {}) }',
      'export async function zz(rt: SupervisorRuntime) { const l = rt.deps.linear; await l.update.call(l, "x", {}) }',
      'export async function zz(p: Pick<SupervisorRuntime["deps"]["linear"], "update">) { await p.update("x", {}) }',
      'export async function zz(rt: SupervisorRuntime) { const x = rt.deps.linear; await x . update ("x", {}) }',
    ]
    for (const code of bypasses) {
      const found = await linearWriters(inject(code))
      expect(
        found.outside.map((w) => `${w.file}:${w.via}`),
        code,
      ).toContain('supervisor/holds.ts:LinearPort')
    }
  }, 120_000)

  test('other update methods and mentions in comments are not Linear writes', async () => {
    const code = [
      '// rt.deps.linear.update("x", {})',
      'export function zz(rt: SupervisorRuntime) { const runs = rt.runs; return runs.update("r", {}) }',
    ].join('\n')
    const found = await linearWriters(inject(code))
    expect(found.outside).toEqual([])
  }, 60_000)
})

describe('applyIntent', () => {
  function setup(status = 'Todo', labels = ['ai-stage:implementation'], awaiting: Awaiting | null = null) {
    const h = harness()
    const ulid = createUlid(() => Date.now())
    const now = () => new Date('2026-10-04T10:00:00.000Z')
    const rt = new SupervisorRuntime(
      { config: h.config, db: h.db, linear: h.linear } as unknown as SupervisorDeps,
      () => h.config,
      new EventLog(h.db, { now, ulid }),
      new RunStore(h.db, { now, ulid }),
      new PullRequestStore(h.db),
      new Map(),
      now,
    )
    const map: Record<string, Awaiting> = awaiting ? { 'FOR-1': awaiting } : {}
    const sync = new LinearSync(rt, {
      coveredSet: () => new Set(),
      uncover: () => {},
      viewOptions: (issue) => ({ awaiting: map[issue] ?? null }),
      setAwaiting: (issue, value) => {
        if (value) map[issue] = value
        else delete map[issue]
      },
      stopRun: async () => {},
    })
    h.linear.put(snapshot({ identifier: 'FOR-1', status, labels }))
    return { h, rt, sync, map }
  }

  const cases: [string, string, string[], Awaiting | null, Intent, IssueUpdate][] = [
    ['dispatched', 'Todo', ['ai-stage:implementation'], null, { kind: 'dispatched' }, { status: 'running' }],
    ['prOpened', 'In Progress', ['ai-stage:integration'], null, { kind: 'prOpened' }, { status: 'review' }],
    ['merged', 'In Review', ['ai-stage:integration'], null, { kind: 'merged' }, { status: 'done' }],
    ['prClosed', 'In Review', ['ai-stage:integration'], null, { kind: 'prClosed' }, { status: 'blocked' }],
    [
      'heldForUser',
      'In Progress',
      ['ai-stage:implementation'],
      null,
      { kind: 'heldForUser', awaiting: { kind: 'escalated', stage: 'implementation' } },
      { status: 'blocked' },
    ],
    ['released', 'Blocked', ['ai-stage:implementation'], null, { kind: 'released' }, { status: 'ready' }],
    [
      'retryRequested',
      'In Progress',
      ['ai-stage:verification'],
      null,
      { kind: 'retryRequested' },
      { status: 'ready', stage: 'implementation' },
    ],
    [
      'stageEntered',
      'In Progress',
      ['ai-stage:implementation'],
      null,
      { kind: 'stageEntered', stage: 'verification', from: 'implementation' },
      { stage: 'verification' },
    ],
    ['unblocked', 'Backlog', ['ai-stage:implementation'], null, { kind: 'unblocked' }, { status: 'ready' }],
    ['lost', 'In Progress', ['ai-stage:implementation'], null, { kind: 'lost' }, { status: 'ready' }],
  ]

  for (const [name, status, labels, awaiting, intent, change] of cases) {
    test(`${name} produces the expected linear.update`, async () => {
      const { h, sync } = setup(status, labels, awaiting)
      await sync.refresh('FOR-1')
      await sync.applyIntent('FOR-1', intent)
      expect(h.linear.updates).toEqual([{ identifier: 'FOR-1', change }])
    })
  }

  test('merged while awaiting your check writes nothing', async () => {
    const { h, sync } = setup('In Review', ['ai-stage:acceptance'], { kind: 'after', stage: 'acceptance' })
    await sync.refresh('FOR-1')
    await sync.applyIntent('FOR-1', { kind: 'merged' })
    expect(h.linear.updates).toEqual([])
  })

  test('an ignored intent writes nothing', async () => {
    const { h, sync } = setup('Done')
    await sync.refresh('FOR-1')
    await sync.applyIntent('FOR-1', { kind: 'dispatched' })
    expect(h.linear.updates).toEqual([])
  })

  test('the awaiting of the transition is stored and the cache follows the write', async () => {
    const { rt, sync, map } = setup('In Progress', ['ai-stage:integration'])
    await sync.refresh('FOR-1')
    await sync.applyIntent('FOR-1', { kind: 'prClosed' })
    expect(map['FOR-1']).toEqual({ kind: 'escalated', stage: 'integration' })
    expect(rt.cache.get('FOR-1')?.status).toBe('Blocked')
  })
})
