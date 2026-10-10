import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { loadConfig } from '../config/loader'
import { parseConfigSection } from '../config/validate'
import { validateIssue } from '../issues/template'
import { outputValidator, validateFinish } from './finish'
import { splitFrontmatter } from './frontmatter'
import { formatAgentError, loadAgents } from './load'
import { activeProfile, type RenderContext, renderAgent } from './render'
import { type FetchLike, runSingleCall } from './single-call'
import type { AgentDef, JsonSchema } from './types'

const ROOT = join(import.meta.dir, '../../../..')
const yaml = (path: string) => parse(readFileSync(join(ROOT, path), 'utf8'))

const defaults = yaml('config/defaults.yaml')
const profiles = parseConfigSection('profiles', {
  active: 'cloud',
  memory_budget_gb: 220,
  cloud: yaml('config/profiles/cloud.yaml'),
})
const ctx: RenderContext = {
  profile: activeProfile(profiles),
  policy: parseConfigSection('policies', defaults.policies),
  stepsLimit: parseConfigSection('limits', defaults.limits).worker.steps,
}

// The lead's planning skills are not written yet.
const PENDING_SKILLS = ['status', 'replan', 'intake']
const LEAD_SKILLS = ['discover', 'design', 'decompose']
const CLI_SKILLS = ['linear', 'gh', 'code-graph', 'ctx7', 'search']
const { agents, errors } = loadAgents(join(ROOT, 'agents'), {
  profiles,
  externalSkills: [...PENDING_SKILLS, 'wiki-ingest'],
})
const workers = [...agents.values()].filter((d) => d.kind === 'worker')
const SELECTED = ['implementer', 'explorer', 'fixer', 'repairer', 'refactorer', 'migrator', 'ingester']
const SINGLE_CALLS = [
  'reviewer',
  'classifier',
  'context-selector',
  'duplicate-judge',
  'intake',
  'replanner',
  'acceptor',
]

function sections(body: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const part of body.split(/^(?=## )/m)) {
    const title = /^## +(.+)$/m.exec(part)?.[1]
    if (title) out.set(title, part.trim())
  }
  return out
}

function rendered(def: AgentDef) {
  const split = splitFrontmatter(renderAgent(def, ctx).content)
  if (!split) throw new Error(`${def.name}: rendered without frontmatter`)
  return { frontmatter: parse(split.frontmatter), body: split.body }
}

describe('repository agents', () => {
  test('ingester respects vault ownership and its local prompt budget', () => {
    const def = agents.get('ingester') as AgentDef
    expect(def).toBeDefined()
    expect(def.budget.promptWords).toBeLessThanOrEqual(500)
    expect(def.body).toContain('ingest: <source path>')
    expect(def.body).toContain('bun scripts/lint.ts')
    expect(def.body).toContain('obsidian-wiki lint "$PWD"')
    expect(def.body).toContain('committed `raw/`')
  })

  test('load with the cloud profile without errors', () => {
    expect(errors.map(formatAgentError)).toEqual([])
    for (const name of SELECTED) expect(agents.get(name)?.kind).toBe('worker')
    for (const name of SINGLE_CALLS) expect(agents.get(name)?.kind).toBe('single_call')
  })

  test('selection rules name loaded agents for implementation defaults and context retries', () => {
    const rules: { when: Record<string, unknown>; agent: string }[] = defaults.selection
    expect(rules.map((r) => r.agent).filter((name) => !agents.has(name))).toEqual([])
    expect(rules.at(-1)).toEqual({ when: { stage: 'implementation' }, agent: 'implementer' })
    expect(rules.find((r) => r.when.failure_class === 'insufficient_context')?.agent).toBe('explorer')
  })

  test.each(SELECTED)('%s renders for OpenCode', (name) => {
    const def = agents.get(name) as AgentDef
    const { frontmatter, body } = rendered(def)
    expect(frontmatter.model).toBe(`litellm/${activeProfile(profiles, 'cloud').profile.roles[def.role]}`)
    expect(frontmatter.permission.finish).toBe('allow')
    for (const pattern of defaults.policies.deny.bash)
      expect(frontmatter.permission.bash[pattern]).toBe('deny')
    expect(frontmatter.steps).toBeLessThanOrEqual(200)
    expect(frontmatter).not.toHaveProperty('nightshift')
    expect(body).toBe(def.body)
  })

  test('workers carry no credentials, Linear or GitHub tools', () => {
    for (const def of workers) {
      const { permission } = rendered(def).frontmatter
      expect(permission.webfetch ?? permission['*']).toBe('deny')
      expect(permission.task ?? permission['*']).toBe('deny')
      if (permission.bash['*'] === 'allow') {
        expect(permission.bash['gh *']).toBe('deny')
        expect(permission.bash['linear *']).toBe('deny')
      }
    }
  })

  test('every worker body contains each section of the shared base prompt', () => {
    const base = sections(readFileSync(join(ROOT, 'agents/_base/worker.md'), 'utf8'))
    expect([...base.keys()]).toEqual(['Rules', 'Inputs', 'Escalate', 'Output'])
    for (const def of workers) {
      const own = sections(def.body)
      for (const [title, text] of base) {
        const shared = text.slice(text.indexOf('\n')).trim()
        expect({ agent: def.name, title, contains: own.get(title)?.includes(shared) }).toEqual({
          agent: def.name,
          title,
          contains: true,
        })
      }
    }
  })
})

describe('lead', () => {
  const text = readFileSync(join(ROOT, 'agents/lead.md'), 'utf8')

  test('loads with only the planning skills pending', () => {
    const own = loadAgents(join(ROOT, 'agents'), { profiles, externalSkills: ['wiki-ingest'] })
    const pending = own.errors.filter((e) => e.file === 'agents/lead.md').map(formatAgentError)
    expect(pending).toEqual(
      PENDING_SKILLS.map((s) => expect.stringContaining(`no skill '${s}'`) as unknown as string),
    )
    expect(agents.get('lead')?.skills).toEqual(expect.arrayContaining(CLI_SKILLS))
  })

  test('names no stage: or agent: labels and only verified linear commands', () => {
    expect(text).not.toMatch(/`(stage|agent):/)
    expect(text).toContain('`ai-stage:`')
    const linear = Object.keys(rendered(agents.get('lead') as AgentDef).frontmatter.permission.bash).filter(
      (p) => p.startsWith('linear '),
    )
    for (const p of linear)
      expect(p).toMatch(
        /^linear (issue (view|query|create|update|comment (list|add)|relation (list|add))|project (view|list|create|update)|document (view|list|create|update)|team (list|states)|milestone (list|view)|label list) ?\*$/,
      )
    expect(linear).not.toContain('linear issue comment *')
    expect(linear).not.toContain('linear issue relation *')
  })
})

describe('lead writes', () => {
  test('the lead has no allowed or asked git write', () => {
    const bash = rendered(agents.get('lead') as AgentDef).frontmatter.permission.bash
    const writes = Object.entries(bash).filter(
      ([p, action]) =>
        /^git (commit|push|checkout|switch|worktree|add|reset)|publish\.sh/.test(p) && action !== 'deny',
    )
    expect(writes).toEqual([])
  })
})

describe('CLI skills', () => {
  test.each([...CLI_SKILLS, ...LEAD_SKILLS])(
    '%s has a when/when-not description and stays under 140 lines',
    (name) => {
      const text = readFileSync(join(ROOT, 'skills', name, 'SKILL.md'), 'utf8')
      const split = splitFrontmatter(text)
      expect(split).toBeDefined()
      const fm = parse(split?.frontmatter ?? '')
      expect(fm.name).toBe(name)
      expect(fm.description).toMatch(/Use when/)
      expect(fm.description).toMatch(/Not for|Do not use/)
      expect(text.split('\n').length).toBeLessThan(140)
      expect(text).not.toMatch(/lin_api_|ghp_|gho_|https?:\/\/(?!github\.com|linear\.app)[a-z0-9.-]+:\d+/i)
    },
  )

  test('linear pins the CLI version', () => {
    const fm = parse(
      splitFrontmatter(readFileSync(join(ROOT, 'skills/linear/SKILL.md'), 'utf8'))?.frontmatter ?? '',
    )
    expect(fm.compatibility).toContain('2.6.0')
  })

  test('search reads the searxng URL from the environment', () => {
    const script = readFileSync(join(ROOT, 'skills/search/scripts/search.sh'), 'utf8')
    expect(script).toContain('SEARXNG_URL')
    expect(script).not.toMatch(/https?:\/\//)
  })
})

describe('explorer', () => {
  const explorer = agents.get('explorer') as AgentDef

  test('cannot edit files or run writing commands', () => {
    const { permission } = rendered(explorer).frontmatter
    expect(permission['*']).toBe('deny')
    expect(permission.edit).toBe('deny')
    expect(permission.bash['*']).toBe('deny')
    const allowed = Object.entries(permission.bash).filter(([, action]) => action === 'allow')
    expect(allowed.map(([pattern]) => pattern).sort()).toEqual([
      'cgc *',
      'git diff *',
      'git log *',
      'git show *',
      'rg *',
    ])
  })

  const report = {
    files: [{ path: 'src/a.ts', why: 'parses the config' }],
    symbols: [{ name: 'parseConfig', path: 'src/a.ts', line: 12 }],
    facts: [{ claim: 'defaults load before the user file', source: 'src/a.ts:30', basis: 'observed' }],
    open_questions: ['which layer owns retries?'],
  }
  const finish = (r: unknown) => ({
    status: 'DONE',
    summary: 'Found where the config is parsed.',
    evidence: [{ kind: 'file', ref: 'src/a.ts', result: 'info' }],
    report: r,
  })

  test('report validates against schemas/explorer.json', () => {
    expect(explorer.output).toBeDefined()
    expect(validateFinish(explorer, finish(report))).toMatchObject({ ok: true })
  })

  test('rejects a report outside the schema', () => {
    const bad = { ...report, facts: [{ claim: 'x', source: 'y', basis: 'guessed' }] }
    const res = validateFinish(explorer, finish(bad))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors.join('\n')).toContain('report.facts')
    const { open_questions: _, ...missing } = report
    expect(validateFinish(explorer, finish(missing)).ok).toBe(false)
  })
})

describe('fixer and repairer', () => {
  test.each(['fixer', 'repairer'])(
    '%s reproduces before fixing and reports the check as evidence',
    (name) => {
      const body = (agents.get(name) as AgentDef).body
      const rules = sections(body).get('Rules') ?? ''
      expect(rules).toContain('Reproduce before fixing')
      expect(sections(body).get('Procedure')).toMatch(/`evidence` lists .*reproducing check/)
      expect((agents.get(name) as AgentDef).skills).toEqual(['surgical-patch', 'graph-query'])
    },
  )
})

const FIXTURES = join(import.meta.dir, 'fixtures/repo')
const readFixture = (agent: string, file: string) => readFileSync(join(FIXTURES, agent, file), 'utf8')
const fixtureCases = SINGLE_CALLS.flatMap((agent) =>
  readdirSync(join(FIXTURES, agent))
    .filter((f) => f.endsWith('.input.md'))
    .map((f) => [agent, f.slice(0, -'.input.md'.length)] as const),
)

type Chat = { url: string; body: Record<string, unknown> }

async function replay<T = Record<string, unknown>>(agent: string, name: string) {
  const def = agents.get(agent) as AgentDef
  const calls: Chat[] = []
  const reply = readFixture(agent, `${name}.response.md`)
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse(String(init.body)) })
    if (url.endsWith('/utils/token_counter')) return Response.json({ total_tokens: 900 })
    return Response.json({ id: 'resp-1', choices: [{ message: { role: 'assistant', content: reply } }] })
  }
  const input = readFixture(agent, `${name}.input.md`)
  const r = await runSingleCall<T>(def, input, {
    profile: ctx.profile,
    gateway: { baseUrl: 'https://gw.test/v1', apiKey: 'sk-test', fetch },
  })
  if (!r.ok) throw new Error(`${agent}/${name}: ${r.detail}`)
  return { output: r.output, input, chat: calls[1] as Chat }
}

const events = JSON.parse(readFileSync(join(ROOT, 'packages/supervisor/schema/events.schema.json'), 'utf8'))
const eventData = (name: string) => outputValidator({ $defs: events.$defs, ...events.$defs.data[name] })

function shape(schema: JsonSchema): unknown {
  if (Array.isArray(schema)) return schema.map((s) => shape(s))
  if (typeof schema !== 'object' || schema === null) return schema
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'description' || k === 'minLength' || k === 'maxLength' || k === 'allOf') continue
    out[k] = shape(v as JsonSchema)
  }
  return out
}

describe('single-call agents', () => {
  test.each(SINGLE_CALLS)('%s has fixtures', (agent) => {
    expect(fixtureCases.filter(([a]) => a === agent).length).toBeGreaterThan(0)
  })

  test.each(fixtureCases)('%s/%s returns schema-valid output through runSingleCall', async (agent, name) => {
    const def = agents.get(agent) as AgentDef
    const { output, chat } = await replay(agent, name)
    expect(outputValidator(def.output as JsonSchema)(output)).toEqual([])
    expect(chat.body.model).toBe(ctx.profile.profile.roles[def.role])
    if (def.reasoning === 'json_only') expect(chat.body).toHaveProperty('response_format')
  })
})

describe('reviewer', () => {
  const schema = (agents.get('reviewer') as AgentDef).output as JsonSchema
  const valid = outputValidator(schema)

  test('output schema matches the review event data', async () => {
    const { model: _, ...recorded } = events.$defs.data.review.properties
    expect(shape(schema)).toEqual(shape({ ...events.$defs.data.review, properties: recorded }))
    for (const [, name] of fixtureCases.filter(([a]) => a === 'reviewer'))
      expect(eventData('review')((await replay('reviewer', name)).output)).toEqual([])
  })

  test('a removed assertion yields a BLOCKER with evidence', async () => {
    const { output } = await replay<{ verdict: string; findings: Record<string, string>[] }>(
      'reviewer',
      'removed-assertion',
    )
    expect(output.verdict).toBe('fail')
    expect(output.findings).toContainEqual(
      expect.objectContaining({ severity: 'BLOCKER', file: 'src/upload.test.ts' }),
    )
    const blocker = output.findings.find((f) => f.severity === 'BLOCKER')
    expect(blocker?.evidence).toContain('expect(send.calls).toBe(3)')
  })

  test('verdict follows the BLOCKER findings', () => {
    const finding = (severity: string) => ({
      severity,
      file: 'a.ts',
      message: 'm',
      evidence: 'e',
      confidence: 0.5,
    })
    expect(valid({ verdict: 'fail', findings: [] }).length).toBeGreaterThan(0)
    expect(valid({ verdict: 'fail', findings: [finding('SUGGESTION')] }).length).toBeGreaterThan(0)
    expect(valid({ verdict: 'pass', findings: [finding('BLOCKER')] }).length).toBeGreaterThan(0)
    expect(valid({ verdict: 'fail', findings: [finding('BLOCKER')] })).toEqual([])
    expect(valid({ verdict: 'pass', findings: [finding('SUGGESTION')] })).toEqual([])
    expect(
      valid({ verdict: 'pass', findings: [{ ...finding('SUGGESTION'), lines: '0' }] }).length,
    ).toBeGreaterThan(0)
  })
})

describe('classifier', () => {
  test('output is the classified event data without the supervisor fields', async () => {
    const schema = (agents.get('classifier') as AgentDef).output as JsonSchema
    const classified = events.$defs.data.classified
    expect(Object.keys(schema.properties as object).sort()).toEqual(['class', 'evidence'])
    expect((schema.properties as Record<string, { enum: string[] }>).class?.enum).toEqual(
      events.$defs.failureClass.enum,
    )
    expect(Object.keys(classified.properties)).toEqual(expect.arrayContaining(['class', 'evidence']))
    const expected: Record<string, string> = {
      'registry-down': 'environment',
      'failing-test': 'implementation_defect',
    }
    for (const [name, cls] of Object.entries(expected)) {
      const { output } = await replay<{ class: string }>('classifier', name)
      expect(output.class).toBe(cls)
      expect(eventData('classified')({ ...output, action: 'repair' })).toEqual([])
    }
  })
})

describe('context-selector', () => {
  test('selects only listed paths, most relevant first', async () => {
    const { output, input } = await replay<{ files: { path: string }[]; pages: { path: string }[] }>(
      'context-selector',
      'retry-upload',
    )
    expect(output.files[0]?.path).toBe('src/upload.ts')
    for (const { path } of [...output.files, ...output.pages]) expect(input).toContain(path)
    expect(output.files.map((f) => f.path)).not.toContain('src/ui/progress.tsx')
  })
})

describe('duplicate-judge', () => {
  const def = agents.get('duplicate-judge') as AgentDef
  const valid = outputValidator(def.output as JsonSchema)

  test.each(['duplicate', 'related', 'unrelated'])(
    '%s pair uses the judge role and fenced inputs',
    async (verdict) => {
      const { output, input, chat } = await replay('duplicate-judge', verdict)
      expect(def.role).toBe('judge')
      expect(chat.body.model).toBe(ctx.profile.profile.roles.judge)
      expect(chat.url).toBe('https://gw.test/v1/chat/completions')
      expect(input).toContain('--- BEGIN ISSUE ---')
      expect(input).toContain('--- BEGIN CANDIDATE ---')
      expect(output.verdict).toBe(verdict)
      expect(output.shared_outcome).toEqual(
        verdict === 'duplicate' ? 'Trim surrounding spaces from saved user names.' : null,
      )
    },
  )

  test('confidence includes both boundaries and rejects invalid output', () => {
    const base = { verdict: 'duplicate', confidence: 1, shared_outcome: 'Trim user names.' }
    expect(valid(base)).toEqual([])
    expect(valid({ ...base, confidence: 0 })).toEqual([])
    for (const confidence of [-0.01, 1.01, '0.9', null])
      expect(valid({ ...base, confidence }).length).toBeGreaterThan(0)
    expect(valid({ ...base, verdict: 'maybe' }).length).toBeGreaterThan(0)
    expect(valid({ ...base, shared_outcome: '' }).length).toBeGreaterThan(0)
    expect(valid({ ...base, shared_outcome: 'x'.repeat(301) }).length).toBeGreaterThan(0)
    expect(valid({ ...base, extra: true }).length).toBeGreaterThan(0)
    const { shared_outcome: _, ...missing } = base
    expect(valid(missing).length).toBeGreaterThan(0)
  })
})

describe('intake', () => {
  const valid = outputValidator((agents.get('intake') as AgentDef).output as JsonSchema)
  const base = {
    decision: 'accept',
    type: 'bug',
    project: null,
    priority: 0,
    duplicate_of: null,
    group_with: [],
    missing_info: [],
  }

  test('accepts a reproducible bug and asks for missing facts', async () => {
    expect((await replay('intake', 'failing-test-one-file')).output).toMatchObject({
      decision: 'accept',
      type: 'bug',
      project: 'Omni',
    })
    const vague = (await replay<{ decision: string; missing_info: string[] }>('intake', 'vague')).output
    expect(vague.decision).toBe('needs_info')
    expect(vague.missing_info.length).toBeGreaterThan(0)
  })

  test('duplicate needs duplicate_of and needs_info needs a question', () => {
    expect(valid(base)).toEqual([])
    expect(valid({ ...base, decision: 'duplicate' }).length).toBeGreaterThan(0)
    expect(valid({ ...base, decision: 'duplicate', duplicate_of: 'FRG-12' })).toEqual([])
    expect(valid({ ...base, duplicate_of: 'FRG-12' }).length).toBeGreaterThan(0)
    expect(valid({ ...base, decision: 'needs_info' }).length).toBeGreaterThan(0)
  })
})

describe('replanner', () => {
  const valid = outputValidator((agents.get('replanner') as AgentDef).output as JsonSchema)
  const part = { title: 't', description: 'd' }

  test('split sub-issues pass the issue template validator', async () => {
    const { output } = await replay<{ action: string; sub_issues: { description: string }[] }>(
      'replanner',
      'too-large',
    )
    expect(output.action).toBe('split')
    for (const sub of output.sub_issues) expect(validateIssue(sub.description)).toMatchObject({ ok: true })
    expect((await replay('replanner', 'conflict')).output).toMatchObject({ action: 'escalate_lead' })
  })

  test('sub_issues only with split, blocker only with create_blocker', () => {
    expect(valid({ action: 'split', sub_issues: [part, part], reason: 'r' })).toEqual([])
    expect(valid({ action: 'split', reason: 'r' }).length).toBeGreaterThan(0)
    expect(
      valid({ action: 'split', sub_issues: [part, part], blocker: part, reason: 'r' }).length,
    ).toBeGreaterThan(0)
    expect(valid({ action: 'create_blocker', blocker: part, reason: 'r' })).toEqual([])
    expect(valid({ action: 'create_blocker', reason: 'r' }).length).toBeGreaterThan(0)
    expect(valid({ action: 'escalate_lead', reason: 'r' })).toEqual([])
    expect(valid({ action: 'escalate_lead', blocker: part, reason: 'r' }).length).toBeGreaterThan(0)
  })
})

describe('acceptor', () => {
  test('one verdict per criterion in order', async () => {
    const { output } = await replay<{ criteria: { verdict: string }[] }>('acceptor', 'export-milestone')
    expect(output.criteria.map((c) => c.verdict)).toEqual(['met', 'not_met', 'unverifiable'])
  })
})

describe('default config', () => {
  test('loads with the repository catalog and the example user config', () => {
    const res = loadConfig({
      user: join(ROOT, 'config/example.yaml'),
      env: { HOME: '/home/test' },
      isGitRepo: () => true,
    })
    expect(res.ok ? [] : res.errors).toEqual([])
  })
})
