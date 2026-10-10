import {
  type Config,
  expandHome,
  type FetchFn,
  githubAccount,
  type OctoStsConfig,
  SecretError,
} from '@nightshift/core'

export class GitHubAuthError extends Error {
  override name = 'GitHubAuthError'
  readonly failureClass = 'environment'
}

export class GitHubUnauthorizedError extends Error {
  override name = 'GitHubUnauthorizedError'
}

export const TOKEN_TTL_MS = 50 * 60_000

type CachedToken = { value: string; expiresAt: number }

export type GitHubTokensOptions = {
  config: () => Config
  resolve: (ref: string) => Promise<string>
  remoteUrl?: (path: string, remote: string) => Promise<string>
  fetch?: FetchFn
  now?: () => number
  home?: string
}

export class GitHubTokens {
  private readonly config: () => Config
  private readonly resolve: (ref: string) => Promise<string>
  private readonly remoteUrl: (path: string, remote: string) => Promise<string>
  private readonly fetch: FetchFn
  private readonly now: () => number
  private readonly home: string
  private readonly cache = new Map<string, CachedToken>()
  private readonly pending = new Map<string, Promise<CachedToken>>()

  constructor(opts: GitHubTokensOptions) {
    this.config = opts.config
    this.resolve = opts.resolve
    this.remoteUrl = opts.remoteUrl ?? gitRemoteUrl
    this.fetch = opts.fetch ?? ((url, init) => fetch(url, init))
    this.now = opts.now ?? Date.now
    this.home = opts.home ?? process.env.HOME ?? ''
  }

  async token(repository: string): Promise<string> {
    const account = githubAccount(this.config(), repository)
    if ('token' in account) return this.secret(`github.accounts.${account.name}.token`, account.token)
    return this.exchanged(account.name, account.octo_sts, await this.owner(repository))
  }

  async ownerToken(owner: string): Promise<string> {
    const config = this.config()
    const name = config.github.default ?? Object.keys(config.github.accounts)[0]
    const account = name === undefined ? undefined : config.github.accounts[name]
    if (name === undefined || !account) throw new GitHubAuthError('no default GitHub account')
    if (!account.octo_sts) {
      if (account.token === undefined)
        throw new GitHubAuthError(`github.accounts.${name}: no token or octo_sts`)
      return this.secret(`github.accounts.${name}.token`, account.token)
    }
    return this.exchanged(name, account.octo_sts, owner)
  }

  private async exchanged(
    name: string,
    octo: Parameters<GitHubTokens['exchange']>[1],
    owner: string,
  ): Promise<string> {
    const key = `${name}/${owner}`
    const cached = this.cache.get(key)
    if (cached && this.now() < cached.expiresAt) return cached.value
    let pending = this.pending.get(key)
    if (!pending) {
      pending = this.exchange(name, octo, owner).finally(() => this.pending.delete(key))
      this.pending.set(key, pending)
    }
    const token = await pending
    this.cache.set(key, token)
    return token.value
  }

  async invalidate(repository: string): Promise<void> {
    const account = githubAccount(this.config(), repository)
    if ('token' in account) return
    this.cache.delete(`${account.name}/${await this.owner(repository)}`)
  }

  async withToken<T>(repository: string, op: (token: string) => Promise<T>): Promise<T> {
    try {
      return await op(await this.token(repository))
    } catch (e) {
      if (!(e instanceof GitHubUnauthorizedError)) throw e
    }
    await this.invalidate(repository)
    try {
      return await op(await this.token(repository))
    } catch (e) {
      if (!(e instanceof GitHubUnauthorizedError)) throw e
      const { name } = githubAccount(this.config(), repository)
      throw new GitHubAuthError(`github.accounts.${name}: GitHub rejected the token for ${repository}`)
    }
  }

  private async owner(repository: string): Promise<string> {
    const repo = this.config().repositories[repository]
    if (!repo) throw new GitHubAuthError(`no repository '${repository}'`)
    let url: string
    try {
      url = await this.remoteUrl(expandHome(repo.path, this.home), repo.remote)
    } catch (e) {
      throw new GitHubAuthError(
        `repositories.${repository}: cannot read remote ${repo.remote} (${e instanceof Error ? e.message : String(e)})`,
      )
    }
    const owner = githubOwner(url)
    if (!owner)
      throw new GitHubAuthError(`repositories.${repository}: remote ${repo.remote} is not on github.com`)
    return owner
  }

  private async secret(path: string, ref: string): Promise<string> {
    try {
      return await this.resolve(ref)
    } catch (e) {
      if (e instanceof SecretError) throw new GitHubAuthError(`${path}: ${e.message}`)
      throw e
    }
  }

  private async exchange(account: string, sts: OctoStsConfig, owner: string): Promise<CachedToken> {
    const at = `github.accounts.${account}.octo_sts`
    const issuedAt = this.now()
    const password = await this.secret(`${at}.password`, sts.password)
    const hide = (text: string) => text.split(password).join('***')
    const auth = await this.post(at, sts.token_url, {
      grant_type: 'client_credentials',
      client_id: sts.client_id,
      username: sts.identity,
      password,
      scope: 'openid profile',
    })
    const authBody = (await auth.json().catch(() => ({}))) as { access_token?: unknown; error?: unknown }
    if (!auth.ok) {
      const code = typeof authBody.error === 'string' ? `, ${hide(authBody.error)}` : ''
      throw new GitHubAuthError(
        `${at}: Authentik rejected the client credentials (HTTP ${auth.status}${code})`,
      )
    }
    if (typeof authBody.access_token !== 'string' || !authBody.access_token)
      throw new GitHubAuthError(`${at}: Authentik response has no access_token`)
    const bearer = authBody.access_token
    const url = `${sts.url.replace(/\/+$/, '')}/sts/exchange?${new URLSearchParams({ scope: owner, identity: sts.identity })}`
    const res = await this.get(at, url, bearer)
    const text = await res.text().catch(() => '')
    if (!res.ok) {
      const policy = /trust policy:[^"\n]*/.exec(text)?.[0]
      const detail = policy ? `: ${hide(policy.split(bearer).join('***'))}` : ''
      throw new GitHubAuthError(`${at}: octo-sts refused ${owner} (HTTP ${res.status})${detail}`)
    }
    let token: unknown
    try {
      token = (JSON.parse(text) as { token?: unknown }).token
    } catch {
      token = undefined
    }
    if (typeof token !== 'string' || !token)
      throw new GitHubAuthError(`${at}: octo-sts response has no token`)
    return { value: token, expiresAt: issuedAt + TOKEN_TTL_MS }
  }

  private async post(at: string, url: string, form: Record<string, string>): Promise<Response> {
    return this.send(at, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    })
  }

  private async get(at: string, url: string, bearer: string): Promise<Response> {
    return this.send(at, url, { method: 'GET', headers: { Authorization: `Bearer ${bearer}` } })
  }

  private async send(at: string, url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetch(url, init)
    } catch {
      // the fetch error can carry the request, which holds the password or bearer
      throw new GitHubAuthError(`${at}: request to ${new URL(url).origin} failed`)
    }
  }
}

const OWNER =
  /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/|[^@/]+@github\.com:)([^/]+)\/[^/]+?(?:\.git)?\/?$/

export function githubOwner(remoteUrl: string): string | undefined {
  return OWNER.exec(remoteUrl.trim())?.[1]
}

async function gitRemoteUrl(path: string, remote: string): Promise<string> {
  const proc = Bun.spawn(['git', '-C', path, 'remote', 'get-url', remote], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exitCode !== 0) throw new Error(stderr.trim() || `git exited ${exitCode}`)
  return stdout.trim()
}

export function gitAuthEnv(
  token: string,
  base = 'https://github.com/',
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
  // Callers merge this over the process environment, so keep its GIT_CONFIG_* entries and append ours.
  const slot = Number(env.GIT_CONFIG_COUNT) || 0
  return {
    GIT_CONFIG_COUNT: String(slot + 1),
    [`GIT_CONFIG_KEY_${slot}`]: `http.${base}.extraheader`,
    [`GIT_CONFIG_VALUE_${slot}`]: `AUTHORIZATION: basic ${basic}`,
    GH_TOKEN: token,
  }
}
