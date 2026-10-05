import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import YAML from 'yaml'
import { formatError } from './errors'
import { type LoadConfigOptions, loadConfig, userConfigPath } from './loader'
import { FIXTURES, testCatalog } from './testing'

const DEFAULTS = join(FIXTURES, 'layers/defaults.yaml')
const USER = join(FIXTURES, 'layers/user.yaml')
const REPO = join(import.meta.dir, '../../../..')

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nightshift-config-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function opts(extra: Partial<LoadConfigOptions> = {}): LoadConfigOptions {
  return {
    defaults: DEFAULTS,
    user: USER,
    env: { HOME: '/home/me' },
    catalog: testCatalog(),
    isGitRepo: () => true,
    ...extra,
  }
}

function userWith(patch: (user: Record<string, unknown>) => void): string {
  const user = YAML.parse(readFileSync(USER, 'utf8'))
  patch(user)
  const path = join(dir, 'config.yaml')
  writeFileSync(path, YAML.stringify(user))
  return path
}

describe('loadConfig', () => {
  test('defaults and a valid user file merge into one config with both sources', () => {
    const res = loadConfig(opts())
    if (!res.ok) throw new Error(res.errors.map(formatError).join('\n'))
    expect(res.sources).toEqual([DEFAULTS, USER])
    expect(res.config.limits.concurrency).toBe(3)
    expect(res.config.repositories.omni?.path).toBe('/repos/omni')
  })

  test('a missing user file fails with a hint at nightshift init', () => {
    const res = loadConfig({ ...opts(), user: undefined, env: { HOME: '/home/me' } })
    expect(res).toEqual({
      ok: false,
      errors: [
        {
          path: 'paths',
          message: 'user config not found at ~/.config/nightshift/config.yaml',
          hint: 'run nightshift init to create it',
        },
      ],
    })
  })

  test('the user file is found under XDG_CONFIG_HOME, never ~/Library', () => {
    expect(userConfigPath({ HOME: '/home/me' })).toBe('/home/me/.config/nightshift/config.yaml')
    expect(userConfigPath({ HOME: '/home/me', XDG_CONFIG_HOME: '/xdg' })).toBe('/xdg/nightshift/config.yaml')
    mkdirSync(join(dir, 'nightshift'))
    writeFileSync(join(dir, 'nightshift/config.yaml'), readFileSync(USER))
    const res = loadConfig({ ...opts(), user: undefined, env: { HOME: '/home/me', XDG_CONFIG_HOME: dir } })
    expect(res.ok && res.sources).toEqual([DEFAULTS, join(dir, 'nightshift/config.yaml')])
  })

  test('maps merge key by key: limits.concurrency changes, limits.worker keeps its defaults', () => {
    const user = userWith((u) => {
      u.limits = { concurrency: 2 }
    })
    const res = loadConfig(opts({ user }))
    if (!res.ok) throw new Error(res.errors.map(formatError).join('\n'))
    expect(res.config.limits.concurrency).toBe(2)
    expect(res.config.limits.worker).toEqual({ wall_clock: '45m', tokens: '2M', steps: 200 })
    expect(res.config.limits.repair_rounds).toBe(2)
  })

  test('lists replace as a whole: a user pipeline is exactly the user list', () => {
    const user = userWith((u) => {
      u.pipelines = { feature: ['implementation', 'verification'] }
    })
    const res = loadConfig(opts({ user }))
    if (!res.ok) throw new Error(res.errors.map(formatError).join('\n'))
    expect(res.config.pipelines.feature).toEqual(['implementation', 'verification'])
    expect(res.config.pipelines.bug).toEqual(['intake', 'implementation', 'verification'])
  })

  test('an environment override sets one value and is recorded in sources', () => {
    const res = loadConfig(opts({ env: { HOME: '/home/me', NIGHTSHIFT_LIMITS_CONCURRENCY: '1' } }))
    if (!res.ok) throw new Error(res.errors.map(formatError).join('\n'))
    expect(res.config.limits.concurrency).toBe(1)
    expect(res.sources).toEqual([DEFAULTS, USER, 'env:NIGHTSHIFT_LIMITS_CONCURRENCY'])
  })

  test('environment overrides resolve keys that contain underscores and keys not yet set', () => {
    const res = loadConfig(
      opts({
        env: {
          HOME: '/home/me',
          NIGHTSHIFT_LIMITS_REPAIR_ROUNDS: '5',
          NIGHTSHIFT_LIMITS_WORKER_WALL_CLOCK: '2h',
          NIGHTSHIFT_NOTIFICATIONS_NTFY: 'https://ntfy.sh/x',
          NIGHTSHIFT_REPOSITORIES_OMNI_BASE: 'develop',
          NIGHTSHIFT_LINEAR_KEY: 'lin_api_secret',
        },
      }),
    )
    if (!res.ok) throw new Error(res.errors.map(formatError).join('\n'))
    expect(res.config.limits.repair_rounds).toBe(5)
    expect(res.config.limits.worker.wall_clock).toBe('2h')
    expect(res.config.notifications.ntfy).toBe('https://ntfy.sh/x')
    expect(res.config.repositories.omni?.base).toBe('develop')
    expect(res.sources).not.toContain('env:NIGHTSHIFT_LINEAR_KEY')
  })

  test('an invalid environment override is reported at its config path', () => {
    const res = loadConfig(opts({ env: { HOME: '/home/me', NIGHTSHIFT_LIMITS_CONCURRENCY: 'many' } }))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors.map((e) => e.path)).toEqual(['limits.concurrency'])
  })

  test('invalid YAML is reported with the file', () => {
    const user = join(dir, 'config.yaml')
    writeFileSync(user, 'paths: [unclosed\n')
    const res = loadConfig(opts({ user }))
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.errors).toHaveLength(1)
      expect(res.errors[0]?.path).toBe(user)
    }
  })

  test('a layer that is not a mapping is rejected', () => {
    const user = join(dir, 'config.yaml')
    writeFileSync(user, '- a\n- b\n')
    const res = loadConfig(opts({ user }))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors).toEqual([{ path: user, message: 'must be a YAML mapping' }])
  })

  test('profile files next to the defaults become named profiles', () => {
    mkdirSync(join(dir, 'profiles'))
    writeFileSync(join(dir, 'defaults.yaml'), readFileSync(DEFAULTS))
    writeFileSync(
      join(dir, 'profiles/cloud.yaml'),
      YAML.stringify({
        roles: { worker: 'claude-opus', reviewer: 'gpt-sol' },
        models: {
          'claude-opus': {
            model: 'anthropic/claude-opus-5-5',
            family: 'anthropic',
            size_gb: 0,
            phases: ['implementation'],
          },
          'gpt-sol': {
            model: 'openai/gpt-6.1-sol',
            family: 'openai',
            size_gb: 0,
            phases: ['implementation'],
          },
        },
      }),
    )
    const user = userWith((u) => {
      u.profiles = { active: 'cloud', memory_budget_gb: 220 }
    })
    const res = loadConfig(opts({ defaults: join(dir, 'defaults.yaml'), user }))
    if (!res.ok) throw new Error(res.errors.map(formatError).join('\n'))
    expect(res.config.profiles.active).toBe('cloud')
    expect(res.sources).toEqual([join(dir, 'defaults.yaml'), join(dir, 'profiles/cloud.yaml'), user])
  })

  test('an unset env: secret does not fail loading', () => {
    const res = loadConfig(opts({ env: { HOME: '/home/me' } }))
    expect(res.ok).toBe(true)
  })
})

describe('shipped config files', () => {
  const catalog = testCatalog({
    intake: 'intake',
    explorer: 'explorer',
    acceptor: 'acceptor',
    replanner: 'planner',
    refactorer: 'worker',
    migrator: 'worker',
  })

  test('config/example.yaml validates against config/defaults.yaml', () => {
    const res = loadConfig({
      defaults: join(REPO, 'config/defaults.yaml'),
      user: join(REPO, 'config/example.yaml'),
      env: { HOME: '/home/me' },
      catalog,
      isGitRepo: () => true,
    })
    if (!res.ok) throw new Error(res.errors.map(formatError).join('\n'))
    expect(res.sources).toContain(join(REPO, 'config/profiles/cloud.yaml'))
    expect(res.config.policies.deny.bash).toEqual(
      expect.arrayContaining(['git push --force *', 'git filter-branch *', 'gh pr merge *', 'kubectl *']),
    )
  })

  test('shipped files carry the yaml-language-server schema header', () => {
    for (const file of ['config/defaults.yaml', 'config/example.yaml']) {
      expect(readFileSync(join(REPO, file), 'utf8')).toStartWith('# yaml-language-server: $schema=')
    }
  })
})
