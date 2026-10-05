import { describe, expect, test } from 'bun:test'
import { type Config, SecretResolver } from '@nightshift/core'
import { GitHubTokens } from './github-tokens'

const live = process.env.NIGHTSHIFT_LIVE_OCTO_STS === '1'

describe.skipIf(!live)('octo-sts live (NIGHTSHIFT_LIVE_OCTO_STS=1)', () => {
  test('a token for lkshrk lists the installation repositories', async () => {
    const secrets = new SecretResolver({ env: process.env })
    const config = {
      github: {
        accounts: {
          agent: {
            octo_sts: {
              url: 'https://sts.h-cloud.io',
              token_url: 'https://auth.h-cloud.io/application/o/token/',
              client_id: 'octo-sts',
              identity: 'nightshift-towerr',
              password: process.env.NIGHTSHIFT_OCTO_STS_PASSWORD
                ? 'env:NIGHTSHIFT_OCTO_STS_PASSWORD'
                : 'rbw:octo-sts#nightshift-towerr',
            },
          },
        },
      },
      repositories: { probe: { path: '/', remote: 'origin' } },
    } as unknown as Config
    const tokens = new GitHubTokens({
      config: () => config,
      resolve: (ref) => secrets.resolve(ref),
      remoteUrl: async () => 'https://github.com/lkshrk/coding-harness.git',
    })
    const token = await tokens.token('probe')
    const res = await fetch('https://api.github.com/installation/repositories?per_page=100', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { total_count: number; repositories: { full_name: string }[] }
    expect(body.total_count).toBeGreaterThan(0)
    expect(body.repositories.every((r) => r.full_name.startsWith('lkshrk/'))).toBe(true)
    console.error(JSON.stringify({ repositories: body.repositories.map((r) => r.full_name) }))
  })
})
