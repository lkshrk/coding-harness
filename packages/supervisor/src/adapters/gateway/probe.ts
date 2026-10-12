import { existsSync, readFileSync } from 'node:fs'
import { type Config, expandHome } from '@nightshift/core'

export type GatewayProbe = { ok: boolean; reason: string }

const TIMEOUT_MS = 10_000

export async function probeGateway(
  gateway: Config['gateway'],
  d: { fetch: typeof fetch; home: string; timeoutMs?: number },
): Promise<GatewayProbe> {
  let url: string
  try {
    url = `${new URL(gateway.base_url).origin}/health/readiness`
  } catch {
    return { ok: false, reason: `invalid base_url ${gateway.base_url}` }
  }
  const bundle = gateway.ca_bundle ? expandHome(gateway.ca_bundle, d.home) : undefined
  let ca: string | undefined
  if (bundle) {
    if (!existsSync(bundle)) return { ok: false, reason: `ca_bundle ${bundle} not found` }
    try {
      ca = readFileSync(bundle, 'utf8')
    } catch (e) {
      return {
        ok: false,
        reason: `ca_bundle ${bundle} unreadable (${e instanceof Error ? e.message : String(e)})`,
      }
    }
  }
  const timeoutMs = d.timeoutMs ?? TIMEOUT_MS
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    const res = await d.fetch(url, { method: 'GET', signal, ...(ca ? { tls: { ca } } : {}) } as RequestInit)
    return { ok: res.ok, reason: `${url}: HTTP ${res.status}` }
  } catch (e) {
    if (signal.aborted) return { ok: false, reason: `${url}: timed out after ${timeoutMs}ms` }
    const message = e instanceof Error ? e.message : String(e)
    const tls = /certificate|self[- ]signed|issuer|CERT|SSL|TLS/i.test(message)
    return {
      ok: false,
      reason: `${url}: ${tls ? 'TLS certificate not trusted' : 'unreachable'} (${message})`,
    }
  }
}
