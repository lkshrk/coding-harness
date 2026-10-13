import { describe, expect, test } from 'bun:test'
import { DOCKER_HUB_HOSTS, gateEgress, workerEgress } from './egress'

describe('workerEgress', () => {
  test('gateway only', () => {
    expect(workerEgress({ gatewayUrl: 'http://gateway.test', stackHosts: [] })).toEqual(['gateway.test'])
  })

  test('keeps a non-default gateway port', () => {
    expect(workerEgress({ gatewayUrl: 'http://gateway.test:4000/v1', stackHosts: [] })).toEqual([
      'gateway.test:4000',
    ])
  })

  test('an OTel endpoint on the gateway host is listed once, with the stack hosts', () => {
    expect(
      workerEgress({
        gatewayUrl: 'https://api.gw.lan/v1',
        otelEndpoint: 'https://api.gw.lan/otel/v1/traces',
        stackHosts: ['registry.npmjs.org'],
      }),
    ).toEqual(['api.gw.lan', 'registry.npmjs.org'])
  })

  test('a different OTel host is listed with its port', () => {
    expect(
      workerEgress({
        gatewayUrl: 'https://api.gw.lan/v1',
        otelEndpoint: 'https://otel.lan:4318/v1/traces',
        stackHosts: [],
      }),
    ).toEqual(['api.gw.lan', 'otel.lan:4318'])
  })

  test('nested Docker adds the Docker Hub hosts', () => {
    const allow = workerEgress({ gatewayUrl: 'http://gateway.test', stackHosts: [], nestedDocker: true })
    expect(allow).toEqual([...DOCKER_HUB_HOSTS, 'gateway.test'].sort())
    expect(DOCKER_HUB_HOSTS).toEqual([
      'auth.docker.io',
      'registry-1.docker.io',
      'production.cloudflare.docker.com',
      'production.cloudfront.docker.com',
    ])
  })

  test('without nested Docker no Docker Hub host appears', () => {
    const allow = workerEgress({ gatewayUrl: 'http://gateway.test', stackHosts: ['pypi.org'] })
    for (const h of DOCKER_HUB_HOSTS) expect(allow).not.toContain(h)
  })

  test('de-duplicates, lower-cases and sorts', () => {
    expect(
      workerEgress({
        gatewayUrl: 'http://Gateway.Test',
        stackHosts: ['PyPI.org', 'pypi.org', 'gateway.test', 'files.pythonhosted.org'],
      }),
    ).toEqual(['files.pythonhosted.org', 'gateway.test', 'pypi.org'])
  })
})

describe('gateEgress', () => {
  test('contains the stack hosts and never the gateway host', () => {
    expect(
      gateEgress({ gatewayUrl: 'http://gateway.test', stackHosts: ['pypi.org', 'Gateway.test', 'pypi.org'] }),
    ).toEqual(['pypi.org'])
  })

  test('strips the gateway host whatever the port', () => {
    expect(
      gateEgress({
        gatewayUrl: 'https://gateway.test:4000/v1',
        stackHosts: ['gateway.test', 'gateway.test:443', 'gateway.test:4000', 'registry.npmjs.org'],
      }),
    ).toEqual(['registry.npmjs.org'])
    expect(
      gateEgress({ gatewayUrl: 'https://gateway.test', stackHosts: ['gateway.test:8080', 'pypi.org'] }),
    ).toEqual(['pypi.org'])
  })

  test('empty', () => {
    expect(gateEgress({ gatewayUrl: 'http://gateway.test', stackHosts: [] })).toEqual([])
  })
})
