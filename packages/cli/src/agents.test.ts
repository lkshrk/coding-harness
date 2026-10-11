import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { NIGHTSHIFT_ROOT, splitFrontmatter } from '@nightshift/core'
import { type CliDeps, run } from './run'

const FIXTURES = join(NIGHTSHIFT_ROOT, 'packages/core/src/agents/fixtures')
const noUser: CliDeps = {
  load: () => ({
    ok: false,
    errors: [{ path: 'paths', message: 'user config not found at ~/.config/nightshift' }],
  }),
}

async function capture(args: string[], deps: CliDeps = {}) {
  const out: string[] = []
  const err: string[] = []
  const code = await run(args, { out: (s) => out.push(s), err: (s) => err.push(s) }, { ...noUser, ...deps })
  return { code, out, err }
}

describe('ns agents lint', () => {
  test('passes the valid fixture without a user config', async () => {
    const r = await capture(['agents', 'lint'], { agentsRoot: join(FIXTURES, 'valid') })
    expect(r).toEqual({ code: 0, out: ['3 agents ok'], err: [] })
  })

  test('fails the invalid fixture with one file: path: message line per error', async () => {
    const r = await capture(['agents', 'lint'], { agentsRoot: join(FIXTURES, 'invalid') })
    expect(r.code).toBe(1)
    expect(r.out).toEqual(
      expect.arrayContaining([
        'agents/worker-no-steps.md: steps: required for kind worker',
        "agents/body-rules.md: body: '## Output' must be the last section",
        expect.stringMatching(/^agents\/body-rules\.md: body: body has \d+ words, budget 50$/),
      ]),
    )
    for (const line of r.out) expect(line).toMatch(/^agents\/[^:]+\.md: /)
  })

  test('passes the repository agents', async () => {
    const r = await capture(['agents', 'lint'])
    expect(r.out.filter((l) => !l.endsWith('agents ok'))).toEqual([])
    expect(r.code).toBe(0)
  })
})

describe('ns agents render', () => {
  test('prints the OpenCode agent for a profile', async () => {
    const r = await capture(['agents', 'render', 'implementer', '--profile', 'cloud'])
    expect(r.code).toBe(0)
    const split = splitFrontmatter(r.out.join('\n'))
    const frontmatter = Bun.YAML.parse(split?.frontmatter ?? '') as {
      model: string
      permission: { bash: Record<string, string> }
    }
    expect(frontmatter.model).toBe('litellm/claude-opus')
    expect(frontmatter).not.toHaveProperty('nightshift')
    expect(frontmatter.permission.bash['git push --force *']).toBe('deny')
  })

  test('needs --profile without a user config', async () => {
    const r = await capture(['agents', 'render', 'implementer'])
    expect(r.code).toBe(2)
  })

  test('reports a broken user config instead of falling back', async () => {
    const r = await capture(['agents', 'lint'], {
      load: () => ({ ok: false, errors: [{ path: 'gateway', message: 'required' }] }),
    })
    expect(r).toEqual({ code: 1, out: [], err: ['config: gateway: required'] })
  })

  test('reports an unknown agent', async () => {
    const r = await capture(['agents', 'render', 'nobody', '--profile', 'cloud'])
    expect(r).toEqual({ code: 4, out: [], err: ['no agent nobody'] })
  })

  test('rejects a single-call agent', async () => {
    const r = await capture(['agents', 'render', 'reviewer', '--profile', 'cloud'])
    expect(r.code).toBe(1)
  })
})
