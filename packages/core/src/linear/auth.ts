export class LinearAuthError extends Error {
  override name = 'LinearAuthError'
}

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>

export type LinearAuthConfig =
  | { mode: 'app'; client_id: string; client_secret: string; scopes?: string[] }
  | { mode: 'api_key'; api_key: string }

export interface TokenProvider {
  authorization(): Promise<string>
  invalidate(): void
}

export const TOKEN_URL = 'https://api.linear.app/oauth/token'
export const DEFAULT_SCOPES = ['read', 'write', 'initiative:read']
const REFRESH_MARGIN_MS = 5 * 60_000
const REJECTED_CODES = new Set(['invalid_client', 'unauthorized_client', 'invalid_grant'])

type Credentials = { clientId: string; clientSecret: string }
type CachedToken = { value: string; expiresAt: number }

export class ClientCredentialsProvider implements TokenProvider {
  private readonly credentials: () => Promise<Credentials>
  private readonly scopes: string[]
  private readonly fetch: FetchFn
  private readonly now: () => number
  private readonly tokenUrl: string
  private cached: CachedToken | undefined
  private pending: Promise<CachedToken> | undefined

  constructor(opts: {
    credentials: () => Promise<Credentials>
    scopes?: string[]
    fetch?: FetchFn
    now?: () => number
    tokenUrl?: string
  }) {
    this.credentials = opts.credentials
    this.scopes = opts.scopes ?? DEFAULT_SCOPES
    this.fetch = opts.fetch ?? ((url, init) => fetch(url, init))
    this.now = opts.now ?? Date.now
    this.tokenUrl = opts.tokenUrl ?? TOKEN_URL
  }

  async authorization(): Promise<string> {
    if (this.cached && this.now() < this.cached.expiresAt - REFRESH_MARGIN_MS)
      return `Bearer ${this.cached.value}`
    this.pending ??= this.request().finally(() => {
      this.pending = undefined
    })
    this.cached = await this.pending
    return `Bearer ${this.cached.value}`
  }

  invalidate(): void {
    this.cached = undefined
  }

  private async request(): Promise<CachedToken> {
    const { clientId, clientSecret } = await this.credentials()
    const res = await this.fetch(this.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        scope: this.scopes.join(','),
      }).toString(),
    })
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: unknown
      expires_in?: unknown
      error?: unknown
    }
    if (!res.ok) {
      const code = typeof body.error === 'string' ? body.error : undefined
      if (res.status === 401 || res.status === 403 || (code && REJECTED_CODES.has(code))) {
        throw new LinearAuthError(
          'linear.auth: client credentials rejected (is "Client credentials tokens" enabled for the app?)',
        )
      }
      throw new LinearAuthError(
        `linear.auth: token request failed (HTTP ${res.status}${code ? `, ${code}` : ''})`,
      )
    }
    if (typeof body.access_token !== 'string' || !body.access_token) {
      throw new LinearAuthError('linear.auth: token response has no access_token')
    }
    const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 0
    return { value: body.access_token, expiresAt: this.now() + expiresIn * 1000 }
  }
}

export class ApiKeyProvider implements TokenProvider {
  private readonly apiKey: () => Promise<string>

  constructor(opts: { apiKey: () => Promise<string> }) {
    this.apiKey = opts.apiKey
  }

  authorization(): Promise<string> {
    return this.apiKey()
  }

  invalidate(): void {}
}

export function createTokenProvider(
  auth: LinearAuthConfig,
  resolve: (ref: string) => Promise<string>,
  opts: { fetch?: FetchFn; now?: () => number; tokenUrl?: string } = {},
): TokenProvider {
  const at = async (key: string, ref: string) => {
    try {
      return await resolve(ref)
    } catch (e) {
      throw new LinearAuthError(`linear.auth.${key}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (auth.mode === 'api_key') return new ApiKeyProvider({ apiKey: () => at('api_key', auth.api_key) })
  return new ClientCredentialsProvider({
    ...opts,
    ...(auth.scopes ? { scopes: auth.scopes } : {}),
    credentials: async () => ({
      clientId: await at('client_id', auth.client_id),
      clientSecret: await at('client_secret', auth.client_secret),
    }),
  })
}
