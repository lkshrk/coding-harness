import { parseSecretRef, SecretError, type SecretResolver } from '../secrets'
import type { ConfigError } from './errors'
import { formatPath } from './errors'
import type { Config } from './schema'

export type SecretRefEntry = { path: string; ref: string }

export function secretRefs(config: Config): SecretRefEntry[] {
  const refs: SecretRefEntry[] = [
    { path: 'gateway.api_key', ref: config.gateway.api_key },
    { path: 'gateway.worker_key', ref: config.gateway.worker_key },
  ]
  const auth = config.linear.auth
  if (auth.mode === 'app') {
    refs.push({ path: 'linear.auth.client_id', ref: auth.client_id })
    refs.push({ path: 'linear.auth.client_secret', ref: auth.client_secret })
  } else {
    refs.push({ path: 'linear.auth.api_key', ref: auth.api_key })
  }
  for (const [name, a] of Object.entries(config.github.accounts)) {
    if (a.token !== undefined)
      refs.push({ path: formatPath(['github', 'accounts', name, 'token']), ref: a.token })
    if (a.octo_sts)
      refs.push({
        path: formatPath(['github', 'accounts', name, 'octo_sts', 'password']),
        ref: a.octo_sts.password,
      })
  }
  const signal = config.notifications?.signal
  if (signal) refs.push({ path: 'notifications.signal.api_key', ref: signal.api_key })
  return refs
}

export function resolveSecret(ref: `env:${string}`, env: Record<string, string | undefined>): string {
  const parsed = parseSecretRef(ref)
  if (parsed.kind !== 'env') throw new SecretError(`${ref}: not an env: reference`)
  const value = env[parsed.name]
  if (value === undefined || value === '')
    throw new SecretError(`environment variable ${parsed.name} is not set`)
  return value
}

export function unsetSecrets(config: Config, env: Record<string, string | undefined>): ConfigError[] {
  const errors: ConfigError[] = []
  for (const { path, ref } of secretRefs(config)) {
    if (!ref.startsWith('env:')) continue
    try {
      resolveSecret(ref as `env:${string}`, env)
    } catch (e) {
      errors.push({ path, message: (e as Error).message })
    }
  }
  return errors
}

export async function resolveConfigSecret(
  config: Config,
  path: string,
  resolver: SecretResolver,
): Promise<string> {
  const entry = secretRefs(config).find((e) => e.path === path)
  if (!entry) throw new SecretError(`${path}: not a secret reference`)
  try {
    return await resolver.resolve(entry.ref)
  } catch (e) {
    if (e instanceof SecretError) throw new SecretError(`${path}: ${e.message}`)
    throw e
  }
}
