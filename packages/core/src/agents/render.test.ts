import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { parse } from 'yaml'
import type { Config, Policy, Profile } from '../config/schema'
import { parseConfigSection } from '../config/validate'
import { splitFrontmatter } from './frontmatter'
import { loadAgents } from './load'
import {
  type ActiveProfile,
  AgentConfigError,
  activeProfile,
  type RenderContext,
  renderAgent,
  renderAgentConfig,
  renderContext,
  renderFinishPlugin,
  renderGuardPlugin,
} from './render'
import type { AgentDef } from './types'

const { agents } = loadAgents(join(import.meta.dir, 'fixtures/valid/agents'))
const fixer = agents.get('fixer') as AgentDef
const lead = agents.get('lead') as AgentDef
const classifier = agents.get('classifier') as AgentDef

const roles = { worker: 'ns/worker', lead: 'ns/lead', classifier: 'ns/small' }
const profile: ActiveProfile = { name: 'default', profile: { roles, models: {} } }
const policy: Policy = { deny: { bash: ['git push --force *', 'gh pr merge *'] } }
const ctx: RenderContext = { profile, policy, stepsLimit: 50 }

describe('renderAgent', () => {
  test('renders a worker into an OpenCode agent file', () => {
    const out = renderAgent(fixer, ctx)
    expect(out.path).toBe('agent/fixer.md')
    const split = splitFrontmatter(out.content)
    if (!split) throw new Error('no frontmatter')
    const fm = parse(split.frontmatter)
    expect(fm).toMatchObject({
      description: fixer.description,
      mode: 'primary',
      model: 'litellm/ns/worker',
      temperature: 0.2,
      steps: 50,
    })
    expect(fm).not.toHaveProperty('nightshift')
    expect(fm.permission.finish).toBe('allow')
    expect(fm.permission.bash['git push --force *']).toBe('deny')
    expect(split.body).toBe(fixer.body)
  })

  test('keeps steps below the limit', () => {
    expect(renderAgentConfig(fixer, { ...ctx, stepsLimit: 500 }).config.steps).toBe(80)
  })

  test('policy denies come last so they win over agent allows', () => {
    const def: AgentDef = {
      ...fixer,
      opencode: { ...fixer.opencode, permission: { bash: { 'git push --force *': 'allow', '*': 'allow' } } },
    }
    const { config, warnings } = renderAgentConfig(def, ctx)
    const perm = config.permission as Record<string, Record<string, string>>
    expect(Object.entries(perm.bash ?? {})).toEqual([
      ['*', 'allow'],
      ['git push --force *', 'deny'],
      ['gh pr merge *', 'deny'],
    ])
    expect(warnings).toEqual(["permission.bash 'git push --force *' conflicts with policy deny"])
  })

  test('orders the global wildcard first and renderer keys last', () => {
    const def: AgentDef = {
      ...fixer,
      opencode: { ...fixer.opencode, permission: { read: 'allow', '*': 'deny' } },
    }
    const perm = renderAgentConfig(def, ctx).config.permission as Record<string, unknown>
    expect(Object.keys(perm)).toEqual(['*', 'read', 'bash', 'finish', 'skill'])
  })

  test('expands a bare permission action', () => {
    const def: AgentDef = { ...fixer, opencode: { ...fixer.opencode, permission: 'allow' } }
    const perm = renderAgentConfig(def, ctx).config.permission as Record<string, unknown>
    expect(perm['*']).toBe('allow')
    expect(perm.bash).toEqual({ 'git push --force *': 'deny', 'gh pr merge *': 'deny' })
  })

  test('allows only the listed skills', () => {
    const perm = renderAgentConfig(fixer, ctx).config.permission as Record<string, unknown>
    expect(perm.skill).toEqual({ '*': 'deny', 'diagnosing-bugs': 'allow' })
  })

  test('renders the interactive lead without finish and with its own steps', () => {
    const { config } = renderAgentConfig(lead, ctx)
    expect(config).toMatchObject({ mode: 'primary', model: 'litellm/ns/lead', color: 'primary' })
    expect(config).not.toHaveProperty('steps')
    const perm = config.permission as Record<string, unknown>
    expect(perm).not.toHaveProperty('finish')
    expect(perm.skill).toEqual({ '*': 'deny' })
  })

  test('uses the given provider name', () => {
    const { config } = renderAgentConfig(fixer, { ...ctx, provider: 'gw' })
    expect(config.model).toBe('gw/ns/worker')
  })

  test('rejects a role missing from the profile', () => {
    expect(() =>
      renderAgent(fixer, {
        ...ctx,
        profile: { name: 'local', profile: { roles: { lead: 'x' }, models: {} } },
      }),
    ).toThrow(new AgentConfigError("agents/fixer.md: nightshift.role: 'worker' not in profile local"))
  })

  test('rejects single_call agents', () => {
    expect(() => renderAgent(classifier, ctx)).toThrow(AgentConfigError)
  })
})

describe('renderContext', () => {
  const local: Profile = { roles: { worker: 'basic/qwen', lead: 'basic/glm' }, models: {} }
  const config: Pick<Config, 'profiles' | 'policies' | 'limits'> = {
    profiles: parseConfigSection('profiles', {
      active: 'default',
      memory_budget_gb: 220,
      default: profile.profile,
      local,
    }),
    policies: policy,
    limits: {
      concurrency: 3,
      worker: { wall_clock: '45m', tokens: '2M', steps: 120 },
      repair_rounds: 2,
      best_of: 2,
    },
  }

  test('takes the active profile, the policy and the worker step limit from the config', () => {
    expect(renderContext(config)).toEqual({ profile, policy, stepsLimit: 120 })
  })

  test('renders through the named profile', () => {
    const { config: out } = renderAgentConfig(fixer, renderContext(config, 'local'))
    expect(out.model).toBe('litellm/basic/qwen')
    expect(out.steps).toBe(80)
    expect(out.permission?.bash).toMatchObject({ 'gh pr merge *': 'deny' })
  })

  test('rejects an unknown profile', () => {
    expect(() => activeProfile(config.profiles, 'fast')).toThrow(new AgentConfigError("no profile 'fast'"))
  })
})

describe('renderFinishPlugin', () => {
  const output = { type: 'object', properties: { files: { type: 'array' } } }

  test('installs the bundle as a local plugin with the output schemas of the workers', () => {
    const out = renderFinishPlugin(
      [{ ...fixer, output }, lead, classifier],
      '/sandbox/opencode/',
      'export default {}',
    )
    expect(out?.files).toEqual([
      {
        path: 'plugins/nightshift-finish/package.json',
        content: `${JSON.stringify({ name: 'nightshift-finish', type: 'module', exports: { '.': './index.js' } }, null, 2)}\n`,
      },
      { path: 'plugins/nightshift-finish/index.js', content: 'export default {}' },
    ])
    expect(out?.plugin).toEqual({
      package: '/sandbox/opencode/plugins/nightshift-finish',
      options: { outputs: { fixer: output } },
    })
  })

  test('installs nothing without a worker', () => {
    expect(renderFinishPlugin([lead, classifier], '/host/opencode', 'x')).toBeUndefined()
  })
})

describe('renderGuardPlugin', () => {
  test('installs linear-guard for the lead', () => {
    const out = renderGuardPlugin([fixer, lead], '/host/opencode/', 'export default {}', {
      allowNoDesign: true,
    })
    expect(out?.files.map((f) => f.path)).toEqual([
      'plugins/linear-guard/package.json',
      'plugins/linear-guard/index.js',
    ])
    expect(out?.plugin).toEqual({
      package: '/host/opencode/plugins/linear-guard',
      options: { allowNoDesign: true },
    })
  })

  test('installs nothing without the lead', () => {
    expect(renderGuardPlugin([fixer, classifier], '/host/opencode', 'x')).toBeUndefined()
  })
})
