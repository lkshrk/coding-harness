import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '@nightshift/core'
import {
  GitHubAuthError,
  GitHubTokens,
  GitHubUnauthorizedError,
  gitAuthEnv,
  githubOwner,
  TOKEN_TTL_MS,
} from './github-tokens'

const PASSWORD = 'app-password-secret'
const ACCESS_TOKEN = 'authentik-jwt-secret'

type Seen = {
  method: string
  path: string
  query: Record<string, string>
  auth: string | null
  form?: Record<string, string>
}

type Fake = {
  url: string
  seen: Seen[]
  authStatus: number
  stsStatus: number
  stsBody: string
  issued: number
}

let fake: Fake
let server: ReturnType<typeof Bun.serve>

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const seen: Seen = {
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        auth: req.headers.get('authorization'),
      }
      fake.seen.push(seen)
      if (url.pathname === '/application/o/token/') {
        seen.form = Object.fromEntries(new URLSearchParams(await req.text()))
        if (fake.authStatus !== 200)
          return Response.json(
            { error: `invalid_grant for ${seen.form.password}` },
            { status: fake.authStatus },
          )
        return Response.json({ access_token: ACCESS_TOKEN, expires_in: 600 })
      }
      if (url.pathname === '/sts/exchange') {
        if (fake.stsStatus !== 200) return new Response(fake.stsBody, { status: fake.stsStatus })
        fake.issued += 1
        return Response.json({ token: `ghs_${url.searchParams.get('scope')}_${fake.issued}` })
      }
      return new Response('not found', { status: 404 })
    },
  })
})

afterAll(() => {
  server.stop(true)
})

function reset(): Fake {
  fake = {
    url: `http://127.0.0.1:${server.port}`,
    seen: [],
    authStatus: 200,
    stsStatus: 200,
    stsBody: '',
    issued: 0,
  }
  return fake
}

function config(f: Fake): Config {
  return {
    github: {
      default: 'agent',
      accounts: {
        agent: {
          octo_sts: {
            url: `${f.url}/`,
            token_url: `${f.url}/application/o/token/`,
            client_id: 'octo-sts',
            identity: 'nightshift-host',
            password: 'env:NIGHTSHIFT_OCTO_STS_PASSWORD',
          },
        },
        personal: { token: 'env:GH_PERSONAL_TOKEN' },
      },
    },
    repositories: {
      omni: { path: '~/Dev/omni', remote: 'origin', github: undefined },
      tools: { path: '/src/tools', remote: 'upstream' },
      litellm: { path: '/src/litellm', remote: 'origin', github: 'personal' },
    },
  } as unknown as Config
}

async function failure(p: Promise<unknown>): Promise<Error> {
  try {
    await p
  } catch (e) {
    return e as Error
  }
  throw new Error('expected a failure')
}

const REMOTES: Record<string, string> = {
  '/home/me/Dev/omni origin': 'git@github.com:lkshrk/omni.git',
  '/src/tools upstream': 'https://github.com/acme-org/tools',
  '/src/litellm origin': 'https://github.com/BerriAI/litellm.git',
}

function tokens(f: Fake, now = () => 0): { tokens: GitHubTokens; resolved: string[] } {
  const resolved: string[] = []
  const secrets: Record<string, string> = {
    'env:NIGHTSHIFT_OCTO_STS_PASSWORD': PASSWORD,
    'env:GH_PERSONAL_TOKEN': 'ghp_personal',
  }
  return {
    resolved,
    tokens: new GitHubTokens({
      config: () => config(f),
      resolve: async (ref) => {
        resolved.push(ref)
        const value = secrets[ref]
        if (value === undefined) throw new Error(`unknown ${ref}`)
        return value
      },
      remoteUrl: async (path, remote) => {
        const url = REMOTES[`${path} ${remote}`]
        if (!url) throw new Error(`no remote ${remote} in ${path}`)
        return url
      },
      now,
      home: '/home/me',
    }),
  }
}

describe('GitHubTokens with an octo_sts account', () => {
  test('exchanges Authentik client credentials for a token of the remote owner', async () => {
    const f = reset()
    const { tokens: t } = tokens(f)
    expect(await t.token('omni')).toBe('ghs_lkshrk_1')
    const [auth, sts] = f.seen
    expect(auth?.method).toBe('POST')
    expect(auth?.form).toEqual({
      grant_type: 'client_credentials',
      client_id: 'octo-sts',
      username: 'nightshift-host',
      password: PASSWORD,
      scope: 'openid profile',
    })
    expect(sts).toMatchObject({
      method: 'GET',
      path: '/sts/exchange',
      query: { scope: 'lkshrk', identity: 'nightshift-host' },
      auth: `Bearer ${ACCESS_TOKEN}`,
    })
  })

  test('caches per owner and refetches after invalidate', async () => {
    const f = reset()
    const { tokens: t } = tokens(f)
    expect(await t.token('omni')).toBe('ghs_lkshrk_1')
    expect(await t.token('omni')).toBe('ghs_lkshrk_1')
    expect(await t.token('tools')).toBe('ghs_acme-org_2')
    expect(f.seen).toHaveLength(4)
    await t.invalidate('omni')
    expect(await t.token('omni')).toBe('ghs_lkshrk_3')
    expect(await t.token('tools')).toBe('ghs_acme-org_2')
  })

  test('concurrent requests share one exchange', async () => {
    const f = reset()
    const { tokens: t } = tokens(f)
    const all = await Promise.all([t.token('omni'), t.token('omni'), t.token('omni')])
    expect(all).toEqual(['ghs_lkshrk_1', 'ghs_lkshrk_1', 'ghs_lkshrk_1'])
    expect(f.issued).toBe(1)
  })

  test('a cached token is reused for 50 minutes after issue', async () => {
    const f = reset()
    let now = 1_000
    const { tokens: t } = tokens(f, () => now)
    await t.token('omni')
    now += TOKEN_TTL_MS - 1
    expect(await t.token('omni')).toBe('ghs_lkshrk_1')
    now += 1
    expect(await t.token('omni')).toBe('ghs_lkshrk_2')
  })

  test('withToken refetches once after a 401, then fails as an environment failure', async () => {
    const f = reset()
    const { tokens: t } = tokens(f)
    const used: string[] = []
    const once = await t.withToken('omni', async (token) => {
      used.push(token)
      if (used.length === 1) throw new GitHubUnauthorizedError('401')
      return 'pushed'
    })
    expect(once).toBe('pushed')
    expect(used).toEqual(['ghs_lkshrk_1', 'ghs_lkshrk_2'])

    const always = t.withToken('omni', async () => {
      throw new GitHubUnauthorizedError('401')
    })
    await expect(always).rejects.toThrow(GitHubAuthError)
    const error = await always.catch((e: GitHubAuthError) => e)
    expect(error.failureClass).toBe('environment')
    expect(f.issued).toBe(3)
  })

  test('rejected client credentials name the account and hide the password', async () => {
    const f = reset()
    f.authStatus = 401
    const { tokens: t } = tokens(f)
    const error = await failure(t.token('omni'))
    expect(error).toBeInstanceOf(GitHubAuthError)
    expect(error.message).toStartWith(
      'github.accounts.agent.octo_sts: Authentik rejected the client credentials',
    )
    expect(error.message).toContain('HTTP 401')
    expect(error.message).not.toContain(PASSWORD)
  })

  test('a trust policy mismatch is reported without the bearer or password', async () => {
    const f = reset()
    f.stsStatus = 403
    f.stsBody = JSON.stringify({
      code: 'permission_denied',
      message: `trust policy: subject ${ACCESS_TOKEN} with ${PASSWORD} does not match`,
    })
    const { tokens: t } = tokens(f)
    const error = await failure(t.token('tools'))
    expect(error).toBeInstanceOf(GitHubAuthError)
    expect(error.message).toContain('octo-sts refused acme-org (HTTP 403): trust policy:')
    expect(error.message).not.toContain(ACCESS_TOKEN)
    expect(error.message).not.toContain(PASSWORD)
  })

  test('a missing bearer is reported as an HTTP error', async () => {
    const f = reset()
    f.stsStatus = 401
    f.stsBody = 'unauthorized'
    const { tokens: t } = tokens(f)
    await expect(t.token('omni')).rejects.toThrow(
      'github.accounts.agent.octo_sts: octo-sts refused lkshrk (HTTP 401)',
    )
  })

  test('an unreachable endpoint names only its origin', async () => {
    const f = reset()
    f.url = 'http://octo-sts.invalid'
    const { tokens: t } = tokens(f)
    const error = await failure(t.token('omni'))
    expect(error.message).toBe('github.accounts.agent.octo_sts: request to http://octo-sts.invalid failed')
  })
})

describe('GitHubTokens with a static token account', () => {
  test('returns the personal token without any exchange', async () => {
    const f = reset()
    const { tokens: t, resolved } = tokens(f)
    expect(await t.token('litellm')).toBe('ghp_personal')
    await t.invalidate('litellm')
    expect(f.seen).toEqual([])
    expect(resolved).toEqual(['env:GH_PERSONAL_TOKEN'])
  })
})

describe('githubOwner', () => {
  test.each([
    ['https://github.com/lkshrk/omni.git', 'lkshrk'],
    ['https://github.com/lkshrk/omni', 'lkshrk'],
    ['https://x-access-token@github.com/acme/tools/', 'acme'],
    ['git@github.com:lkshrk/omni.git', 'lkshrk'],
    ['ssh://git@github.com/acme/tools.git', 'acme'],
    ['https://gitlab.com/lkshrk/omni.git', undefined],
    ['git@example.com:lkshrk/omni.git', undefined],
  ])('%s → %s', (url, owner) => {
    expect(githubOwner(url)).toBe(owner)
  })
})

describe('gitAuthEnv', () => {
  test('git push sends the token as basic auth without a global git config', async () => {
    const headers: (string | null)[] = []
    const git = Bun.serve({
      port: 0,
      fetch(req) {
        headers.push(req.headers.get('authorization'))
        return new Response('no', { status: 403 })
      },
    })
    const home = mkdtempSync(join(tmpdir(), 'ns-git-home-'))
    try {
      const repo = join(home, 'repo')
      const env = {
        PATH: process.env.PATH ?? '',
        HOME: home,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
      }
      const run = (cmd: string[], extra: Record<string, string> = {}) =>
        Bun.spawn(cmd, { cwd: repo, env: { ...env, ...extra }, stdout: 'ignore', stderr: 'ignore' }).exited
      Bun.spawnSync(['git', 'init', '-q', repo], { env })
      await run([
        'git',
        '-c',
        'user.name=n',
        '-c',
        'user.email=n@x',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'x',
      ])
      const base = `http://127.0.0.1:${git.port}/`
      const pushed = await run(
        ['git', 'push', `${base}acme/tools.git`, 'HEAD:refs/heads/main'],
        gitAuthEnv('ghs_abc', base, env),
      )
      expect(pushed).not.toBe(0)
      const expected = `basic ${Buffer.from('x-access-token:ghs_abc').toString('base64')}`
      expect(headers.length).toBeGreaterThan(0)
      expect(new Set(headers)).toEqual(new Set([expected]))
      expect(existsSync(join(home, '.gitconfig'))).toBe(false)
    } finally {
      git.stop(true)
      rmSync(home, { recursive: true, force: true })
    }
  })

  const header = `AUTHORIZATION: basic ${Buffer.from('x-access-token:ghs_abc').toString('base64')}`

  test('scopes the header to github.com and sets GH_TOKEN for gh', () => {
    expect(gitAuthEnv('ghs_abc', undefined, {})).toEqual({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: header,
      GH_TOKEN: 'ghs_abc',
    })
  })

  test('appends after GIT_CONFIG entries already in the environment instead of replacing them', () => {
    expect(gitAuthEnv('ghs_abc', undefined, { GIT_CONFIG_COUNT: '1' })).toEqual({
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_1: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_1: header,
      GH_TOKEN: 'ghs_abc',
    })
  })
})
