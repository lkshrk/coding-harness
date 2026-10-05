import { describe, expect, test } from 'bun:test'
import { SecretError, SecretResolver } from '../secrets'
import type { Config } from './schema'
import { resolveConfigSecret, resolveSecret, secretRefs, unsetSecrets } from './secret-refs'
import { minimalCatalog, readFixture, testCatalog } from './testing'
import { validateConfig } from './validate'

function load(name: string): Config {
  const res = validateConfig(readFixture(name), {
    catalog: name.includes('minimal') ? minimalCatalog() : testCatalog(),
    isGitRepo: () => true,
    home: '/home/me',
  })
  if (!res.ok) throw new Error(JSON.stringify(res.errors))
  return res.config
}

describe('secret references in the config', () => {
  test('lists every secret reference with its path', () => {
    expect(secretRefs(load('valid/full.yaml'))).toEqual([
      { path: 'gateway.api_key', ref: 'rbw:gateway/litellm#master_key' },
      { path: 'gateway.worker_key', ref: 'env:NS_WORKER_KEY' },
      { path: 'linear.auth.client_id', ref: 'rbw:linear/nightshift#client_id' },
      { path: 'linear.auth.client_secret', ref: 'rbw:linear/nightshift#client_secret' },
      { path: 'github.accounts.work.token', ref: 'env:GH_WORK_TOKEN' },
      { path: 'github.accounts.personal.token', ref: 'rbw:github#token' },
      { path: 'github.accounts.agent.octo_sts.password', ref: 'rbw:octo-sts#nightshift-host' },
      { path: 'notifications.signal.api_key', ref: 'env:NIGHTSHIFT_SIGNAL_API_KEY' },
    ])
  })

  test('doctor reports an unset octo_sts password', () => {
    const config = load('valid/minimal.yaml')
    config.github.accounts.personal = {
      octo_sts: {
        url: 'https://sts.example.com',
        token_url: 'https://auth.example.com/application/o/token/',
        client_id: 'octo-sts',
        identity: 'nightshift-host',
        password: 'env:NIGHTSHIFT_OCTO_STS_PASSWORD',
      },
    }
    expect(
      unsetSecrets(config, { NIGHTSHIFT_GATEWAY_KEY: 'x', NIGHTSHIFT_LINEAR_KEY: 'y', NS_WORKER_KEY: 'w' }),
    ).toEqual([
      {
        path: 'github.accounts.personal.octo_sts.password',
        message: 'environment variable NIGHTSHIFT_OCTO_STS_PASSWORD is not set',
      },
    ])
  })

  test('doctor reports every unset env: reference up front', () => {
    const config = load('valid/minimal.yaml')
    expect(unsetSecrets(config, { GH_TOKEN: 'x' })).toEqual([
      { path: 'gateway.api_key', message: 'environment variable NIGHTSHIFT_GATEWAY_KEY is not set' },
      { path: 'gateway.worker_key', message: 'environment variable NS_WORKER_KEY is not set' },
      { path: 'linear.auth.api_key', message: 'environment variable NIGHTSHIFT_LINEAR_KEY is not set' },
    ])
  })

  test('the first use of an unset reference fails with the config path', async () => {
    const config = load('valid/minimal.yaml')
    const resolver = new SecretResolver({ env: {} })
    const use = resolveConfigSecret(config, 'linear.auth.api_key', resolver)
    await expect(use).rejects.toThrow(SecretError)
    await expect(use).rejects.toThrow(
      'linear.auth.api_key: environment variable NIGHTSHIFT_LINEAR_KEY is not set',
    )
  })

  test('a set reference resolves', async () => {
    const config = load('valid/minimal.yaml')
    const resolver = new SecretResolver({ env: { NIGHTSHIFT_LINEAR_KEY: 'lin_api_x' } })
    expect(await resolveConfigSecret(config, 'linear.auth.api_key', resolver)).toBe('lin_api_x')
  })

  test('resolving a path that holds no secret reference fails', async () => {
    const config = load('valid/minimal.yaml')
    const resolver = new SecretResolver({ env: {} })
    await expect(resolveConfigSecret(config, 'paths.state', resolver)).rejects.toThrow(
      'paths.state: not a secret reference',
    )
  })

  test('resolveSecret reads env: references', () => {
    expect(resolveSecret('env:A', { A: 'x' })).toBe('x')
    expect(() => resolveSecret('env:A', {})).toThrow('environment variable A is not set')
  })
})
