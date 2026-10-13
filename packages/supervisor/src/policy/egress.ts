export const DOCKER_HUB_HOSTS: readonly string[] = [
  'auth.docker.io',
  'registry-1.docker.io',
  'production.cloudflare.docker.com',
  'production.cloudfront.docker.com',
]

const normalize = (hosts: readonly string[]): string[] =>
  [...new Set(hosts.map((h) => h.trim().toLowerCase()).filter(Boolean))].sort()

const hostname = (host: string): string => host.replace(/:\d+$/, '')

export function workerEgress(o: {
  gatewayUrl: string
  otelEndpoint?: string
  stackHosts: readonly string[]
  nestedDocker?: boolean
}): string[] {
  return normalize([
    new URL(o.gatewayUrl).host,
    ...(o.otelEndpoint ? [new URL(o.otelEndpoint).host] : []),
    ...o.stackHosts,
    ...(o.nestedDocker ? DOCKER_HUB_HOSTS : []),
  ])
}

export function gateEgress(o: { gatewayUrl: string; stackHosts: readonly string[] }): string[] {
  const gateway = new URL(o.gatewayUrl).hostname
  return normalize(o.stackHosts).filter((h) => hostname(h) !== gateway)
}
