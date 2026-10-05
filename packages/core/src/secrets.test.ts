import { describe, expect, test } from 'bun:test'
import { type CommandRunner, parseSecretRef, SecretError, SecretLockedError, SecretResolver } from './secrets'

describe('parseSecretRef', () => {
  test.each([
    ['env:NIGHTSHIFT_LINEAR_KEY', { kind: 'env', name: 'NIGHTSHIFT_LINEAR_KEY' }],
    ['rbw:litellm-api', { kind: 'rbw', item: 'litellm-api' }],
    ['rbw:gateway/litellm-api', { kind: 'rbw', folder: 'gateway', item: 'litellm-api' }],
    [
      'rbw:linear/oauth-app#client_secret',
      { kind: 'rbw', folder: 'linear', item: 'oauth-app', field: 'client_secret' },
    ],
    ['rbw:github/agent token (owner)', { kind: 'rbw', folder: 'github', item: 'agent token (owner)' }],
  ])('%s', (ref, expected) => {
    expect(parseSecretRef(ref)).toEqual(expected as never)
  })

  test.each(['sk-123', 'env:lower', 'rbw:', 'rbw:gateway/', 'rbw:a/b/c', 'vault:x'])('rejects %s', (ref) => {
    expect(() => parseSecretRef(ref)).toThrow(SecretError)
  })
})

type Call = { cmd: string[]; env: Record<string, string> }

function fakeRbw(entries: Record<string, string>, unlocked = true): { run: CommandRunner; calls: Call[] } {
  const calls: Call[] = []
  const run: CommandRunner = async (cmd, env) => {
    calls.push({ cmd, env })
    if (cmd[1] === 'unlocked') return { exitCode: unlocked ? 0 : 1, stdout: '', stderr: '' }
    const key = cmd.slice(2).join(' ')
    const value = entries[key]
    if (value === undefined) return { exitCode: 1, stdout: '', stderr: `couldn't find entry for '${key}'` }
    return { exitCode: 0, stdout: `${value}\n`, stderr: '' }
  }
  return { run, calls }
}

describe('SecretResolver', () => {
  test('reads env references from the given environment', async () => {
    const r = new SecretResolver({ env: { A_KEY: 'v1' }, run: fakeRbw({}).run })
    expect(await r.resolve('env:A_KEY')).toBe('v1')
  })

  test('unset env variable names the reference, never a value', async () => {
    const r = new SecretResolver({ env: {}, run: fakeRbw({}).run })
    await expect(r.resolve('env:A_KEY')).rejects.toThrow('environment variable A_KEY is not set')
  })

  test('reads rbw references with folder and field, trimming the trailing newline', async () => {
    const { run } = fakeRbw({ '--folder linear --field client_secret oauth-app': 's3cret' })
    const r = new SecretResolver({ env: {}, run })
    expect(await r.resolve('rbw:linear/oauth-app#client_secret')).toBe('s3cret')
  })

  test('always uses the nightshift rbw profile, never the default one', async () => {
    const { run, calls } = fakeRbw({ 'litellm-api': 'k' })
    const r = new SecretResolver({ env: { HOME: '/Users/x' }, run })
    await r.resolve('rbw:litellm-api')
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((c) => c.env.RBW_PROFILE === 'nightshift')).toBe(true)
  })

  test('the profile is configurable but never empty', () => {
    expect(() => new SecretResolver({ env: {}, run: fakeRbw({}).run, rbwProfile: '' })).toThrow(SecretError)
  })

  test('caches per reference for the life of the resolver', async () => {
    const { run, calls } = fakeRbw({ '--folder gateway litellm-api': 'k' })
    const r = new SecretResolver({ env: {}, run })
    await r.resolve('rbw:gateway/litellm-api')
    await r.resolve('rbw:gateway/litellm-api')
    expect(calls.filter((c) => c.cmd[1] === 'get')).toHaveLength(1)
  })

  test('a locked vault gives an actionable error', async () => {
    const r = new SecretResolver({ env: {}, run: fakeRbw({}, false).run })
    await expect(r.resolve('rbw:gateway/litellm-api')).rejects.toThrow(
      'rbw profile nightshift is locked: run `RBW_PROFILE=nightshift rbw unlock`',
    )
  })

  test('a locked vault is a SecretLockedError; a missing entry is not', async () => {
    const locked = new SecretResolver({ env: {}, run: fakeRbw({}, false).run })
    await expect(locked.resolve('rbw:x')).rejects.toBeInstanceOf(SecretLockedError)
    expect(await locked.locked()).toBe(true)
    const open = new SecretResolver({ env: {}, run: fakeRbw({}).run })
    expect(await open.locked()).toBe(false)
    const missing = await open.resolve('rbw:x').catch((e: unknown) => e)
    expect(missing).toBeInstanceOf(SecretError)
    expect(missing).not.toBeInstanceOf(SecretLockedError)
  })

  test('a missing entry names the reference', async () => {
    const r = new SecretResolver({ env: {}, run: fakeRbw({}).run })
    await expect(r.resolve('rbw:gateway/nope')).rejects.toThrow('rbw:gateway/nope: entry not found')
  })

  test('errors never contain a resolved value', async () => {
    const { run } = fakeRbw({ 'litellm-api': '' })
    const r = new SecretResolver({ env: {}, run })
    await expect(r.resolve('rbw:litellm-api')).rejects.toThrow('rbw:litellm-api: entry is empty')
  })
})
