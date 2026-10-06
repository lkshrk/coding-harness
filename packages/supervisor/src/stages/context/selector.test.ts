import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type AgentDef, inputBlocks, parseAgent, type SingleCallResult } from '@nightshift/core'
import type { ContextInput } from '../../ports'
import { testConfig } from '../../testing/testing'
import type { SingleCall } from '../gates'
import type { RankRequest } from './builder'
import { contextSelector, SELECTOR, selectorInput } from './selector'

const ROOT = join(import.meta.dir, '..', '..', '..', '..', '..')
const { def } = parseAgent(`${SELECTOR}.md`, readFileSync(join(ROOT, 'agents', `${SELECTOR}.md`), 'utf8'))
const AGENTS = new Map([[SELECTOR, def as AgentDef]])

function request(attempt = 1, base = 'abc123'): RankRequest {
  const input: ContextInput = {
    issue: {
      identifier: 'FOR-1',
      title: 'Retry queue',
      goal: 'Add retries.',
      why: '',
      interfacesIn: '',
      interfacesOut: '',
      files: ['src/a.ts'],
      constraints: '',
      outOfScope: '',
      acceptance: ['retries 503'],
      testsExpected: '',
      verify: ['bun test'],
    },
    repository: { name: 'omni', checkoutPath: '/repo', base, indexPath: '/idx' },
    blockers: [],
    attempts: [],
    vaultPages: [],
    answers: [],
    run: { id: `run-${attempt}`, attempt, profile: 'default' },
  }
  return {
    input,
    files: ['src/a.ts'],
    outlines: [{ path: 'src/caller.ts', outline: 'L1 function c()' }],
  }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ns-selector-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function selector(output: unknown, calls: string[]) {
  const call = (async (_def: AgentDef, input: string) => {
    calls.push(input)
    return { ok: true, output, trace: { sessionId: 's', calls: [] } } as SingleCallResult<unknown>
  }) as SingleCall
  return contextSelector({
    config: testConfig,
    agents: AGENTS,
    gateway: async () => ({ baseUrl: 'http://gw', apiKey: 'k' }),
    cacheDir: dir,
    call,
  })
}

describe('contextSelector', () => {
  test('input carries exactly the blocks the agent declares', () => {
    const msg = selectorInput(request())
    const fences = [...msg.matchAll(/^--- BEGIN ([A-Z_]+) ---$/gm)].map((m) => m[1])
    expect(fences).toEqual(inputBlocks((def as AgentDef).body))
    expect(msg).toContain('- src/a.ts')
    expect(msg).toContain('## src/caller.ts\nL1 function c()')
  })

  test('drops unlisted and repeated paths', async () => {
    const calls: string[] = []
    const ranking = await selector(
      {
        files: [
          { path: 'src/caller.ts', reason: 'x' },
          { path: 'src/invented.ts', reason: 'y' },
          { path: 'src/caller.ts', reason: 'z' },
          { path: 'src/a.ts', reason: 'w' },
        ],
        pages: [],
      },
      calls,
    )(request())
    expect(ranking?.files.map((f) => f.path)).toEqual(['src/caller.ts', 'src/a.ts'])
  })

  test('caches per issue, base commit and attempt', async () => {
    const calls: string[] = []
    const rank = selector({ files: [{ path: 'src/a.ts', reason: 'r' }], pages: [] }, calls)
    const first = await rank(request(1))
    expect(await rank(request(1))).toEqual(first)
    expect(calls.length).toBe(1)
    await rank(request(2))
    await rank(request(2, 'def456'))
    expect(calls.length).toBe(3)
    const other = selector({ files: [{ path: 'src/caller.ts', reason: 'other' }], pages: [] }, calls)
    expect(await other(request(1))).toEqual(first)
  })

  test('a failed call yields no ranking and is not cached', async () => {
    const calls: string[] = []
    const call = (async (_d: AgentDef, input: string) => {
      calls.push(input)
      return { ok: false, reason: 'invalid_output', detail: 'bad' }
    }) as SingleCall
    const lines: string[] = []
    const rank = contextSelector({
      config: testConfig,
      agents: AGENTS,
      gateway: async () => ({ baseUrl: 'http://gw', apiKey: 'k' }),
      cacheDir: dir,
      call,
      out: (l) => lines.push(l),
    })
    expect(await rank(request())).toBeUndefined()
    expect(await rank(request())).toBeUndefined()
    expect(calls.length).toBe(2)
    expect(lines[0]).toContain('invalid_output: bad')
  })
})
