import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
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

describe('applyIntent is the only Linear writer', () => {
  test('no module calls linear.update, writeStatus or relabel outside applyIntent', () => {
    const offenders: string[] = []
    let inside = 0
    for (const file of sources(root)) {
      const name = relative(root, file)
      const source = readFileSync(file, 'utf8')
      if (/\b(writeStatus|relabel)\b/.test(source)) offenders.push(`${name}: writeStatus/relabel`)
      const calls = [...source.matchAll(/\blinear\??\.update\(/g)]
      if (!calls.length) continue
      const start = source.indexOf('async applyIntent(')
      const end = start < 0 ? -1 : source.indexOf('\n  }\n', start)
      for (const call of calls) {
        const at = call.index ?? 0
        if (start >= 0 && at > start && at < end) inside += 1
        else offenders.push(`${name}: linear.update outside applyIntent`)
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([])
    expect(inside).toBe(1)
  })
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
