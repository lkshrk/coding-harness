import { describe, expect, test } from 'bun:test'
import { formatError } from './errors'
import { githubAccount } from './schema'
import { minimalCatalog, readFixture, setPath, testCatalog, unsetPath } from './testing'
import { parseConfigSection, type ValidateContext, validateConfig } from './validate'

const ctx: ValidateContext = { catalog: testCatalog(), isGitRepo: () => true, home: '/home/me' }

function base(): Record<string, unknown> {
  return readFixture('valid/full.yaml')
}

function errorsOf(data: unknown, context: ValidateContext = ctx): string[] {
  const res = validateConfig(data, context)
  return res.ok ? [] : res.errors.map(formatError)
}

describe('validateConfig', () => {
  test('closeout ingest defaults true and accepts false only on closeout', () => {
    expect(parseConfigSection('stages', { closeout: { automatic: true } }).closeout).toEqual({
      automatic: true,
      human_checkpoint: 'none',
      ingest: true,
    })
    expect(
      parseConfigSection('stages', { closeout: { automatic: true, ingest: false } }).closeout,
    ).toMatchObject({ ingest: false })
    expect(() => parseConfigSection('stages', { closeout: { automatic: true, ingest: 'false' } })).toThrow()
    expect(() =>
      parseConfigSection('stages', { implementation: { automatic: true, ingest: true } }),
    ).toThrow()
  })

  test('intake duplicate settings default under stages and accept overrides', () => {
    expect(parseConfigSection('stages', { intake: { automatic: true } }).intake).toEqual({
      automatic: true,
      human_checkpoint: 'none',
      duplicate: { judge: 'typed', threshold: 0.9, max_candidates: 10, closed_within_days: 90 },
    })
    const duplicate = { judge: 'llm' as const, threshold: 1, max_candidates: 3, closed_within_days: 7 }
    expect(
      parseConfigSection('stages', { intake: { automatic: true, duplicate } }).intake?.duplicate,
    ).toEqual(duplicate)
  })

  test.each([
    { judge: 'invalid' },
    { threshold: -0.1 },
    { threshold: 1.1 },
    { max_candidates: 0 },
    { max_candidates: 1.5 },
    { max_candidates: 11 },
    { closed_within_days: 0 },
    { closed_within_days: 366 },
    { extra: true },
  ])('rejects invalid intake duplicate settings %j', (duplicate) => {
    expect(() => parseConfigSection('stages', { intake: { automatic: true, duplicate } })).toThrow()
  })

  test('duplicate configuration belongs only to the intake stage', () => {
    expect(() =>
      parseConfigSection('stages', { implementation: { automatic: true, duplicate: {} } }),
    ).toThrow()
    const data = base()
    setPath(data, 'limits.intake', { duplicate: {} })
    expect(errorsOf(data).some((e) => e.startsWith('limits.intake:'))).toBe(true)
  })

  test('a valid config passes and gets defaults', () => {
    const res = validateConfig(readFixture('valid/minimal.yaml'), { ...ctx, catalog: minimalCatalog() })
    if (!res.ok) throw new Error(res.errors.map(formatError).join('\n'))
    expect(res.config.repositories.omni?.base).toBe('main')
    expect(res.config.repositories.omni?.remote).toBe('origin')
    expect(res.config.repositories.omni?.stacks).toBe('auto')
    expect(res.config.repositories.omni?.checks[0]?.timeout).toBe('15m')
    expect(res.config.linear.exclude_labels).toEqual([])
    expect(res.config.sandbox.resources).toEqual({ cpus: 4, memory: '8g' })
    expect(res.config.notifications).toEqual({ macos: true, ntfy: null })
    expect(res.config.secrets).toEqual({ rbw_profile: 'nightshift' })
  })

  test('the full fixture passes the semantic rules', () => {
    expect(errorsOf(base())).toEqual([])
  })

  test('several invalid fields are all reported at once with dotted paths', () => {
    const data = base()
    setPath(data, 'gateway.api_key', 'sk-123')
    setPath(data, 'projects.0.pipeline', 'feat')
    setPath(data, 'pipelines.feature', ['intake', 'design', 'implementation', 'desing'])
    setPath(data, 'limits.concurrency', 0)
    const errors = errorsOf(data)
    expect(errors).toContain('gateway.api_key: secrets must be references (env:NAME)')
    expect(errors).toContain("projects[0].pipeline: no pipeline 'feat'")
    expect(errors).toContain("pipelines.feature[3]: no stage 'desing'")
    expect(errors.some((e) => e.startsWith('limits.concurrency: '))).toBe(true)
  })

  test('a raw secret is rejected', () => {
    const data = base()
    setPath(data, 'gateway.api_key', 'sk-123')
    expect(errorsOf(data)).toEqual(['gateway.api_key: secrets must be references (env:NAME)'])
  })

  test('an unknown key names the nearest known key', () => {
    const data = base()
    setPath(data, 'repositoris', {})
    setPath(data, 'repositories.omni.chekcs', [])
    const res = validateConfig(data, ctx)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.errors).toContainEqual({
      path: 'repositoris',
      message: 'unknown key',
      hint: 'did you mean repositories?',
    })
    expect(res.errors).toContainEqual({
      path: 'repositories.omni.chekcs',
      message: 'unknown key',
      hint: 'did you mean checks?',
    })
  })

  test('an unknown key without a near match has no hint', () => {
    const data = base()
    setPath(data, 'sandbox.zzzzzzzz', 1)
    const res = validateConfig(data, ctx)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors).toEqual([{ path: 'sandbox.zzzzzzzz', message: 'unknown key' }])
  })

  test('a selection rule naming a missing agent file', () => {
    const data = base()
    setPath(data, 'selection.1.agent', 'fixr')
    expect(errorsOf(data)).toEqual(['selection[1].agent: no agents/fixr.md'])
  })

  test('an automatic stage without a stage-only rule', () => {
    const data = base()
    setPath(data, 'stages.acceptance', { automatic: true })
    expect(errorsOf(data)).toEqual(['selection: no rule handles stage acceptance'])
  })

  test('stages run by the supervisor need no stage-only rule', () => {
    const data = base()
    setPath(data, 'stages.integration', { automatic: true })
    setPath(data, 'stages.release', { automatic: true })
    expect(errorsOf(data)).toEqual([])
  })

  test('a rule with more than the stage does not count as stage-only', () => {
    const data = base()
    setPath(data, 'stages.acceptance', { automatic: true })
    setPath(data, 'selection.6', { when: { stage: 'acceptance', issue_type: 'feature' }, agent: 'reviewer' })
    expect(errorsOf(data)).toEqual(['selection: no rule handles stage acceptance'])
    setPath(data, 'selection.7', { when: { stage: ['verification', 'acceptance'] }, agent: 'reviewer' })
    expect(errorsOf(data)).toEqual([])
  })

  test('a profile whose implementation-phase models exceed the memory budget', () => {
    const data = base()
    setPath(data, 'profiles.quality', {
      roles: { worker: 'ns/worker', reviewer: 'ns/reviewer', lead: 'ns/worker' },
      models: {
        'ns/worker': { model: 'big', family: 'qwen', size_gb: 200, phases: ['implementation'] },
        'ns/reviewer': { model: 'mid', family: 'glm', size_gb: 60, phases: ['implementation', 'planning'] },
      },
    })
    expect(errorsOf(data)).toEqual([
      'profiles.quality.models: implementation phase needs 260 GB, memory_budget_gb is 220',
    ])
  })

  test('aliases of the same concrete model count once', () => {
    const data = base()
    setPath(data, 'profiles.quality', {
      roles: { worker: 'ns/worker', reviewer: 'ns/reviewer', lead: 'ns/lead' },
      models: {
        'ns/worker': { model: 'big', family: 'qwen', size_gb: 150, phases: ['implementation'] },
        'ns/lead': { model: 'big', family: 'qwen', size_gb: 150, phases: ['implementation', 'planning'] },
        'ns/reviewer': { model: 'mid', family: 'glm', size_gb: 60, phases: ['implementation'] },
      },
    })
    expect(errorsOf(data)).toEqual([])
  })

  test('reviewer and worker of the same family', () => {
    const data = base()
    setPath(data, 'profiles.default.models.ns/reviewer.family', 'qwen')
    expect(errorsOf(data)).toEqual(['profiles.default: reviewer family qwen equals worker family'])
  })

  test('project references to repositories and profiles', () => {
    const data = base()
    setPath(data, 'projects.1.repositories', ['wow-addon', 'omnii'])
    setPath(data, 'projects.1.profile', 'fast')
    expect(errorsOf(data)).toEqual([
      "projects[1].repositories[1]: no repository 'omnii'",
      "projects[1].profile: no profile 'fast'",
    ])
  })

  test('several accounts need a default; default and repository accounts must exist', () => {
    const data = base()
    delete (data.github as Record<string, unknown>).default
    setPath(data, 'repositories.omni.github', 'bot')
    expect(errorsOf(data)).toEqual([
      'github.default: required with several accounts',
      "repositories.omni.github: no account 'bot'",
    ])
    setPath(data, 'github.default', 'bot')
    setPath(data, 'repositories.omni.github', 'personal')
    expect(errorsOf(data)).toEqual(["github.default: no account 'bot'"])
  })

  test('a repository uses its own account, else the default, else the only account', () => {
    const valid = (data: unknown, context = ctx) => {
      const res = validateConfig(data, context)
      if (!res.ok) throw new Error(res.errors.map(formatError).join('\n'))
      return res.config
    }
    expect(githubAccount(valid(base()), 'omni')).toEqual({ name: 'work', token: 'env:GH_WORK_TOKEN' })
    const data = base()
    setPath(data, 'repositories.omni.github', 'personal')
    expect(githubAccount(valid(data), 'omni')).toEqual({ name: 'personal', token: 'rbw:github#token' })
    const minimal = valid(readFixture('valid/minimal.yaml'), { ...ctx, catalog: minimalCatalog() })
    expect(githubAccount(minimal, 'omni')).toEqual({ name: 'personal', token: 'env:GH_TOKEN' })
    setPath(data, 'repositories.omni.github', 'agent')
    expect(githubAccount(valid(data), 'omni')).toEqual({
      name: 'agent',
      octo_sts: {
        url: 'https://sts.example.com',
        token_url: 'https://auth.example.com/application/o/token/',
        client_id: 'octo-sts',
        identity: 'nightshift-host',
        password: 'rbw:octo-sts#nightshift-host',
      },
    })
  })

  test('an account is exactly one of token or octo_sts', () => {
    const data = base()
    const agent = (data.github as { accounts: { agent: { octo_sts: unknown } } }).accounts.agent
    setPath(data, 'github.accounts.work', {})
    setPath(data, 'github.accounts.personal.octo_sts', agent.octo_sts)
    expect(errorsOf(data)).toEqual([
      'github.accounts.work: needs exactly one of token, octo_sts',
      'github.accounts.personal: needs exactly one of token, octo_sts',
    ])
  })

  test('an unknown octo_sts key is reported with its dotted path', () => {
    const data = base()
    setPath(data, 'github.accounts.agent.octo_sts.scope', 'acme')
    setPath(data, 'github.accounts.agent.octo_sts.password', 'hunter2')
    expect(errorsOf(data)).toEqual([
      'github.accounts.agent.octo_sts.password: secrets must be references (env:NAME)',
      'github.accounts.agent.octo_sts.scope: unknown key',
    ])
  })

  test('the active profile must exist', () => {
    const data = base()
    setPath(data, 'profiles.active', 'fast')
    expect(errorsOf(data)).toEqual(["profiles.active: no profile 'fast'"])
  })

  test('every role alias is listed in the models', () => {
    const data = base()
    setPath(data, 'profiles.default.roles.reviewer', 'ns/critic')
    expect(errorsOf(data)).toEqual(['profiles.default.models: alias ns/critic missing'])
  })

  test('every role used by an agent file is present in each profile', () => {
    const catalog = testCatalog({ classifier: 'classifier' })
    const data = base()
    setPath(data, 'profiles.default.roles.classifier', 'ns/worker')
    expect(errorsOf(data, { ...ctx, catalog })).toEqual([
      'profiles.cloud.roles: role classifier missing (used by agents/classifier.md)',
    ])
  })

  test('repository paths must be git repositories, with ~ expanded', () => {
    const seen: string[] = []
    const isGitRepo = (path: string) => {
      seen.push(path)
      return path !== '/home/me/Dev/omni'
    }
    expect(errorsOf(base(), { ...ctx, isGitRepo })).toEqual(['repositories.omni.path: not a git repository'])
    expect(seen).toContain('/Users/me/Dev/wow-addon')
  })

  test('explicit stacks must be known', () => {
    const data = base()
    setPath(data, 'repositories.omni.stacks', ['golang', 'node'])
    expect(errorsOf(data)).toEqual(["repositories.omni.stacks[0]: unknown stack 'golang'"])
  })

  test('check names are unique per repository', () => {
    const data = base()
    setPath(data, 'repositories.omni.checks.2', { name: 'test', run: 'bun test --again' })
    expect(errorsOf(data)).toEqual(["repositories.omni.checks[2].name: duplicate 'test'"])
  })

  test('semantic rules still run for sections that are valid when another section is not', () => {
    const data = base()
    setPath(data, 'sandbox.driver', 'podman')
    setPath(data, 'profiles.active', 'fast')
    const errors = errorsOf(data)
    expect(errors).toContain("profiles.active: no profile 'fast'")
    expect(errors.some((e) => e.startsWith('sandbox.driver: '))).toBe(true)
  })
})

describe('schema errors', () => {
  test.each([
    [
      'required',
      (d: Record<string, unknown>) => unsetPath(d, 'gateway.api_key'),
      'gateway.api_key: required',
    ],
    ['enum', (d) => setPath(d, 'sandbox.driver', 'podman'), 'sandbox.driver: must be one of docker, sbx'],
    [
      'pattern',
      (d) => setPath(d, 'repositories.omni.checks.0.timeout', '15'),
      'repositories.omni.checks[0].timeout: must be a duration like 30s, 15m, 2h',
    ],
    [
      'additionalProperties',
      (d) => setPath(d, 'projects.0.pipline', 'feature'),
      'projects[0].pipline: unknown key (did you mean pipeline?)',
    ],
    [
      'property names',
      (d) => setPath(d, 'profiles.Fast', { roles: { worker: 'ns/worker' }, models: {} }),
      'profiles.Fast: profile names must be lowercase kebab-case',
    ],
    [
      'auth mode',
      (d) => setPath(d, 'linear.auth.mode', 'oauth'),
      'linear.auth.mode: must be one of app, api_key',
    ],
    [
      'anyOf',
      (d) => setPath(d, 'projects.0.match', { team: 'FRG' }),
      'projects[0].match: needs team and exactly one of initiative, project, label',
    ],
    [
      'token and octo_sts',
      (d) =>
        setPath(
          d,
          'github.accounts.work.octo_sts',
          (d.github as { accounts: { agent: { octo_sts: unknown } } }).accounts.agent.octo_sts,
        ),
      'github.accounts.work: needs exactly one of token, octo_sts',
    ],
    ['minProperties', (d) => setPath(d, 'selection.0.when', {}), 'selection[0].when: must not be empty'],
  ] as [string, (d: Record<string, unknown>) => void, string][])('%s', (_, edit, expected) => {
    const data = base()
    edit(data)
    expect(errorsOf(data)).toEqual([expected])
  })
})
