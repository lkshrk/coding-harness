import { describe, expect, test } from 'bun:test'
import {
  ApiKeyProvider,
  ClientCredentialsProvider,
  createTokenProvider,
  type FetchFn,
  LinearAuthError,
  TOKEN_URL,
} from './auth'

type TokenCall = { url: string; form: URLSearchParams }

function fakeTokenEndpoint(responses: Array<{ status: number; body: unknown }>): {
  fetch: FetchFn
  calls: TokenCall[]
} {
  const calls: TokenCall[] = []
  const fetch: FetchFn = async (url, init) => {
    calls.push({ url, form: new URLSearchParams(String(init.body)) })
    const next = responses[Math.min(calls.length, responses.length) - 1]
    if (!next) throw new Error('no response configured')
    return new Response(JSON.stringify(next.body), { status: next.status })
  }
  return { fetch, calls }
}

const token = (access_token: string, expires_in = 2_592_000) => ({
  status: 200,
  body: { access_token, token_type: 'Bearer', scope: 'read write', expires_in },
})

const credentials = async () => ({ clientId: 'cid', clientSecret: 'csecret' })

describe('ClientCredentialsProvider', () => {
  test('exchanges the client credentials for an app actor token', async () => {
    const { fetch, calls } = fakeTokenEndpoint([token('t1')])
    const p = new ClientCredentialsProvider({ credentials, fetch })
    expect(await p.authorization()).toBe('Bearer t1')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(TOKEN_URL)
    expect(Object.fromEntries(calls[0]?.form ?? [])).toEqual({
      grant_type: 'client_credentials',
      client_id: 'cid',
      client_secret: 'csecret',
      scope: 'read,write,initiative:read',
    })
  })

  test('requests the configured scopes', async () => {
    const { fetch, calls } = fakeTokenEndpoint([token('t1')])
    const p = new ClientCredentialsProvider({ credentials, fetch, scopes: ['read'] })
    await p.authorization()
    expect(calls[0]?.form.get('scope')).toBe('read')
  })

  test('caches the token until shortly before it expires', async () => {
    let now = 1_000_000
    const { fetch, calls } = fakeTokenEndpoint([token('t1', 3600), token('t2', 3600)])
    const p = new ClientCredentialsProvider({ credentials, fetch, now: () => now })
    await p.authorization()
    now += 3600_000 - 10 * 60_000
    expect(await p.authorization()).toBe('Bearer t1')
    expect(calls).toHaveLength(1)
    now += 6 * 60_000
    expect(await p.authorization()).toBe('Bearer t2')
    expect(calls).toHaveLength(2)
  })

  test('invalidate forces a new token request', async () => {
    const { fetch, calls } = fakeTokenEndpoint([token('t1'), token('t2')])
    const p = new ClientCredentialsProvider({ credentials, fetch })
    await p.authorization()
    p.invalidate()
    expect(await p.authorization()).toBe('Bearer t2')
    expect(calls).toHaveLength(2)
  })

  test('concurrent callers share one token request', async () => {
    const { fetch, calls } = fakeTokenEndpoint([token('t1')])
    const p = new ClientCredentialsProvider({ credentials, fetch })
    const all = await Promise.all([p.authorization(), p.authorization(), p.authorization()])
    expect(all).toEqual(['Bearer t1', 'Bearer t1', 'Bearer t1'])
    expect(calls).toHaveLength(1)
  })

  test('rejected client credentials give the actionable error', async () => {
    const { fetch } = fakeTokenEndpoint([
      { status: 400, body: { error: 'invalid_client', error_description: 'Invalid client' } },
    ])
    const p = new ClientCredentialsProvider({ credentials, fetch })
    await expect(p.authorization()).rejects.toThrow(
      new LinearAuthError(
        'linear.auth: client credentials rejected (is "Client credentials tokens" enabled for the app?)',
      ),
    )
  })

  test('a failed request after rejection is retried on the next call', async () => {
    const { fetch } = fakeTokenEndpoint([{ status: 503, body: {} }, token('t1')])
    const p = new ClientCredentialsProvider({ credentials, fetch })
    await expect(p.authorization()).rejects.toThrow('linear.auth: token request failed (HTTP 503)')
    expect(await p.authorization()).toBe('Bearer t1')
  })

  test('errors never contain the client secret', async () => {
    const { fetch } = fakeTokenEndpoint([{ status: 400, body: { error: 'invalid_scope' } }])
    const p = new ClientCredentialsProvider({ credentials, fetch })
    const err = await p.authorization().catch((e: Error) => e)
    expect(String(err)).toContain('invalid_scope')
    expect(String(err)).not.toContain('csecret')
  })

  test('a response without an access token is an error', async () => {
    const { fetch } = fakeTokenEndpoint([{ status: 200, body: { token_type: 'Bearer' } }])
    const p = new ClientCredentialsProvider({ credentials, fetch })
    await expect(p.authorization()).rejects.toThrow('linear.auth: token response has no access_token')
  })
})

describe('ApiKeyProvider', () => {
  test('sends the key as is, without Bearer', async () => {
    const p = new ApiKeyProvider({ apiKey: async () => 'lin_api_x' })
    expect(await p.authorization()).toBe('lin_api_x')
  })
})

describe('createTokenProvider', () => {
  test('app mode resolves both references lazily', async () => {
    const resolved: string[] = []
    const resolve = async (ref: string) => {
      resolved.push(ref)
      return ref.endsWith('client_id') ? 'cid' : 'csecret'
    }
    const { fetch, calls } = fakeTokenEndpoint([token('t1')])
    const p = createTokenProvider(
      { mode: 'app', client_id: 'rbw:app#client_id', client_secret: 'rbw:app#client_secret' },
      resolve,
      { fetch },
    )
    expect(resolved).toEqual([])
    expect(await p.authorization()).toBe('Bearer t1')
    expect(resolved).toEqual(['rbw:app#client_id', 'rbw:app#client_secret'])
    expect(calls[0]?.form.get('client_id')).toBe('cid')
  })

  test('an unresolvable reference fails on first use, naming the config path', async () => {
    const resolve = async () => {
      throw new Error('environment variable NIGHTSHIFT_LINEAR_KEY is not set')
    }
    const p = createTokenProvider({ mode: 'api_key', api_key: 'env:NIGHTSHIFT_LINEAR_KEY' }, resolve)
    await expect(p.authorization()).rejects.toThrow(
      'linear.auth.api_key: environment variable NIGHTSHIFT_LINEAR_KEY is not set',
    )
  })

  test('app mode passes configured scopes through', async () => {
    const { fetch, calls } = fakeTokenEndpoint([token('t1')])
    const p = createTokenProvider(
      { mode: 'app', client_id: 'env:A', client_secret: 'env:B', scopes: ['read'] },
      async () => 'v',
      { fetch },
    )
    await p.authorization()
    expect(calls[0]?.form.get('scope')).toBe('read')
  })
})
