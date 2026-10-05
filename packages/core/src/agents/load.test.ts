import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { parseConfigSection } from '../config/validate'
import { lintAgent } from './lint'
import { checkAgents, formatAgentError, loadAgents, parseAgent } from './load'
import type { AgentDef } from './types'

const FIXTURES = join(import.meta.dir, 'fixtures')

function lines(errors: Parameters<typeof formatAgentError>[0][]): string[] {
  return errors.map(formatAgentError)
}

describe('loadAgents', () => {
  test('turns every valid file into an AgentDef', () => {
    const { agents, errors } = loadAgents(join(FIXTURES, 'valid/agents'))
    expect(lines(errors)).toEqual([])
    expect([...agents.keys()].sort()).toEqual(['classifier', 'fixer', 'lead'])
  })

  test('maps frontmatter to AgentDef', () => {
    const { agents } = loadAgents(join(FIXTURES, 'valid/agents'))
    const fixer = agents.get('fixer')
    expect(fixer).toMatchObject({
      name: 'fixer',
      file: 'agents/fixer.md',
      kind: 'worker',
      role: 'worker',
      skills: ['diagnosing-bugs'],
      reasoning: 'json_only',
      budget: { promptWords: 600, inputTokens: 16000 },
      graceTurns: 1,
      opencode: { temperature: 0.2, steps: 80 },
    })
    expect(fixer?.body.startsWith('Fixes one reported bug')).toBe(true)
    expect(fixer?.opencode).not.toHaveProperty('nightshift')
    expect(fixer?.opencode).not.toHaveProperty('description')
    const classifier = agents.get('classifier')
    expect(classifier?.reasoning).toBe('free_then_json')
    expect(classifier?.outputPath).toBe('schemas/classifier.json')
    expect(classifier?.output).toMatchObject({ required: ['class', 'reason'] })
  })

  test('reports one line per error and loads no broken agent', () => {
    const { agents, errors } = loadAgents(join(FIXTURES, 'invalid/agents'))
    expect(agents.size).toBe(0)
    expect(lines(errors)).toEqual(
      expect.arrayContaining([
        'agents/Bad_Name.md: file name must match [a-z][a-z0-9-]*',
        'agents/single-call-permission.md: permission: not allowed for kind single_call',
        'agents/worker-no-steps.md: steps: required for kind worker',
        'agents/model-set.md: model: set by the profile, remove it',
        'agents/unknown-key.md: nightshift.main_skill: unknown key',
        'agents/interactive-output.md: nightshift.output: not allowed for kind interactive',
        "agents/missing-skill.md: nightshift.skills[0]: no skill 'lean-build'",
        'agents/missing-output.md: nightshift.output: schemas/reviewer.json not found',
        'agents/no-frontmatter.md: frontmatter: missing (file must start with ---)',
      ]),
    )
    for (const f of ['short-description', 'bad-role', 'bad-permission']) {
      expect(lines(errors).some((l) => l.startsWith(`agents/${f}.md: `))).toBe(true)
    }
  })

  test('reports body budget and section order in one run', () => {
    const { errors } = loadAgents(join(FIXTURES, 'invalid/agents'))
    const body = lines(errors).filter((l) => l.startsWith('agents/body-rules.md: '))
    expect(body).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^agents\/body-rules\.md: body: body has \d+ words, budget 50$/),
        "agents/body-rules.md: body: '## Inputs' must come before '## Procedure'",
        "agents/body-rules.md: body: '## Output' must be the last section",
        "agents/body-rules.md: body: first line starts with 'You are'",
        'agents/body-rules.md: body: 4 all-caps emphasis words, max 2',
      ]),
    )
  })

  test('accepts external skills', () => {
    const { errors } = loadAgents(join(FIXTURES, 'invalid/agents'), { externalSkills: ['lean-build'] })
    expect(lines(errors).some((l) => l.startsWith('agents/missing-skill.md'))).toBe(false)
  })

  test('checks roles against every profile', () => {
    const { agents, errors } = loadAgents(join(FIXTURES, 'valid/agents'), {
      profiles: parseConfigSection('profiles', {
        active: 'default',
        memory_budget_gb: 220,
        default: { roles: { worker: 'ns/worker', classifier: 'ns/small', lead: 'ns/big' }, models: {} },
        local: { roles: { worker: 'basic/qwen', lead: 'basic/glm' }, models: {} },
      }),
    })
    expect(lines(errors)).toEqual([
      "agents/classifier.md: nightshift.role: 'classifier' not in profile local",
    ])
    expect(agents.has('classifier')).toBe(false)
  })

  test('rejects two interactive agents for one role', () => {
    const defs = ['agents/lead.md', 'agents/planner.md'].map((f) => parseAgent(f, LEAD).def as AgentDef)
    expect(lines(checkAgents(defs))).toEqual(['agents: two interactive agents for role lead'])
  })
})

const LEAD = `---
description: Plans features with you and writes issues.
permission: ask
nightshift:
  kind: interactive
  role: lead
  budget: { prompt_words: 400, input_tokens: 6000 }
---
Plans features with you.

## Rules

- Ask first.
- Keep issues small.
- Use the CLI.
`

describe('parseAgent', () => {
  test('rejects YAML that is not a mapping', () => {
    expect(lines(parseAgent('agents/x.md', '---\n- a\n---\nbody').errors)).toEqual([
      'agents/x.md: frontmatter: must be a YAML mapping',
    ])
  })

  test('reports YAML syntax errors', () => {
    const { errors } = parseAgent('agents/x.md', '---\na: [1\n---\nbody')
    expect(errors[0]?.path).toBe('frontmatter')
  })
})

function def(kind: AgentDef['kind'], body: string, promptWords = 600): AgentDef {
  return {
    name: 'x',
    file: 'agents/x.md',
    kind,
    role: 'worker',
    description: 'A test agent for lint rules.',
    body,
    skills: [],
    reasoning: 'json_only',
    budget: { promptWords, inputTokens: 6000 },
    graceTurns: 1,
    opencode: {},
  }
}

const WORKER_BODY = `Fixes one bug.

## Rules

- One.
- Two.
- Three.

## Inputs

Blocks.

## Procedure

1. Do it.

## Escalate

When stuck.

## Output

Call finish.
`

describe('lintAgent', () => {
  function msgs(d: AgentDef): string[] {
    return lintAgent(d).map((e) => e.message)
  }

  test('accepts a well-formed worker body', () => {
    expect(msgs(def('worker', WORKER_BODY))).toEqual([])
  })

  test('requires the sections of the kind', () => {
    expect(msgs(def('worker', 'Fixes one bug.\n\n## Rules\n\n- a\n- b\n- c\n'))).toEqual([
      "missing section '## Inputs'",
      "missing section '## Procedure'",
      "missing section '## Escalate'",
      "missing section '## Output'",
    ])
    expect(msgs(def('interactive', 'Plans.\n\n## Rules\n\n- a\n- b\n- c\n'))).toEqual([])
    expect(msgs(def('single_call', WORKER_BODY.replace(/## Escalate\n\nWhen stuck.\n\n/, '')))).toEqual([])
  })

  test('limits rules to 3–7 and procedure to 6 steps', () => {
    const tooFew = WORKER_BODY.replace('- Three.\n', '')
    expect(msgs(def('worker', tooFew))).toEqual(["'## Rules' has 2 rules, expected 3–7"])
    const steps = Array.from({ length: 7 }, (_, i) => `${i + 1}. Step.`).join('\n')
    expect(msgs(def('worker', WORKER_BODY.replace('1. Do it.', steps)))).toEqual([
      "'## Procedure' has 7 steps, max 6",
    ])
  })

  test('requires a first line that states the function', () => {
    expect(msgs(def('worker', `## Rules\n${WORKER_BODY.split('## Rules')[1]}`))).toContain(
      "first line must state the agent's function",
    )
    expect(msgs(def('worker', `You are a fixer.${WORKER_BODY.slice('Fixes one bug.'.length)}`))).toEqual([
      "first line starts with 'You are'",
    ])
  })

  test('ignores headings and emphasis inside code', () => {
    const body = WORKER_BODY.replace('Blocks.', '```\n## Output\nMUST NEVER ALWAYS\n```\n`MUST`')
    expect(msgs(def('worker', body))).toEqual([])
  })

  test('counts body words against the budget', () => {
    expect(msgs(def('worker', WORKER_BODY, 50))).toEqual([])
    expect(msgs(def('worker', `${WORKER_BODY}${'word '.repeat(40)}`, 50))).toEqual([
      'body has 67 words, budget 50',
    ])
  })
})
