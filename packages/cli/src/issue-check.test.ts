import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from '@nightshift/core'
import type { IssueReader } from './issue-check'
import { type CliDeps, run } from './run'

const fixtures = join(import.meta.dir, '../../core/src/issues/fixtures')
const feature = readFileSync(join(fixtures, 'valid/feature.md'), 'utf8')

const broken = feature
  .replace(/## Goal\n\n[^\n]+\n/, '## Goal\n\n')
  .replace(/## Files[\s\S]*?(?=## Constraints)/, '')
  .replace(/## Verify[\s\S]*$/, '')

function fakeReader(issues: Record<string, string>) {
  const reads: string[] = []
  const reader: IssueReader = {
    issue: async (identifier) => {
      reads.push(identifier)
      const description = issues[identifier]
      return description === undefined ? null : { description }
    },
  }
  return { reads, issueReader: () => reader }
}

const config = { linear: {} } as unknown as Config
const load = () => ({ ok: true as const, config, sources: [] })

async function capture(args: string[], deps: CliDeps = {}) {
  const out: string[] = []
  const err: string[] = []
  const code = await run(args, { out: (s) => out.push(s), err: (s) => err.push(s) }, deps)
  return { code, out, err }
}

describe('ns issue check', () => {
  test('a valid fixture file prints ok and exits 0', async () => {
    expect(await capture(['issue', 'check', join(fixtures, 'valid/feature.md')])).toEqual({
      code: 0,
      out: ['ok'],
      err: [],
    })
  })

  test('an invalid fixture file prints every validator message unprefixed and exits 1', async () => {
    const r = await capture(['issue', 'check', join(fixtures, 'invalid/malformed.md')])
    expect(r.code).toBe(1)
    expect(r.out).toContain('missing section ## Constraints')
    expect(r.out).toContain("## Goal: 'none' is not allowed")
    expect(r.out.filter((l) => /^[A-Z]+-\d+: /.test(l))).toEqual([])
  })

  test('--allow-no-design accepts a design section of none', async () => {
    const file = join(fixtures, 'valid/bugfix-no-design.md')
    expect((await capture(['issue', 'check', file])).code).toBe(1)
    expect((await capture(['issue', 'check', file, '--allow-no-design'])).out).toEqual(['ok'])
  })

  test('an identifier is read through the issue reader and errors carry its prefix', async () => {
    const fake = fakeReader({ 'XXX-51': broken })
    const r = await capture(['issue', 'check', 'XXX-51'], { load, ...fake })
    expect(fake.reads).toEqual(['XXX-51'])
    expect(r.code).toBe(1)
    expect(r.out).toEqual([
      'XXX-51: missing section ## Files',
      'XXX-51: missing section ## Verify',
      'XXX-51: ## Goal: empty',
    ])
  })

  test('a valid identifier prints ok', async () => {
    const fake = fakeReader({ 'XXX-52': feature })
    const r = await capture(['issue', 'check', 'XXX-52'], { load, ...fake })
    expect(r).toEqual({ code: 0, out: ['ok'], err: [] })
  })

  test('an unknown identifier exits 4', async () => {
    const fake = fakeReader({})
    const r = await capture(['issue', 'check', 'XXX-999'], { load, ...fake })
    expect(r).toEqual({ code: 4, out: [], err: ['no issue XXX-999'] })
  })

  test('--json prints the parsed issue or the errors', async () => {
    const ok = await capture(['issue', 'check', join(fixtures, 'valid/feature.md'), '--json'])
    expect(ok.code).toBe(0)
    expect(JSON.parse(ok.out.join('\n')).files).toEqual([
      'packages/sync/src/retry.ts',
      'packages/sync/src/retry.test.ts',
      'packages/sync/src/client.ts',
    ])
    const fake = fakeReader({ 'XXX-51': broken })
    const bad = await capture(['--json', 'issue', 'check', 'XXX-51'], {
      load,
      ...fake,
    })
    expect(bad.code).toBe(1)
    const parsed = JSON.parse(bad.out.join('\n'))
    expect(parsed.ok).toBe(false)
    expect(parsed.errors).toHaveLength(3)
  })

  test.each([[['issue']], [['issue', 'check']], [['issue', 'lint', 'x.md']], [['issue', 'check', 'a', 'b']]])(
    'usage errors exit 2: %p',
    async (args) => {
      const r = await capture(args)
      expect(r.code).toBe(2)
      expect(r.err.join('\n')).toContain('usage: ns issue check')
    },
  )

  test('a missing file exits 4', async () => {
    const r = await capture(['issue', 'check', join(fixtures, 'nope.md')])
    expect(r.code).toBe(4)
  })
})
