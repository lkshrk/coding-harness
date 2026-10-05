import { describe, expect, test } from 'bun:test'
import { SecretResolver } from '../secrets'
import { createTokenProvider } from './auth'
import { createLinearReader } from './client'

const live = process.env.NIGHTSHIFT_LINEAR_LIVE === '1'

describe.skipIf(!live)('Linear live (NIGHTSHIFT_LINEAR_LIVE=1)', () => {
  test('authenticates as the nightshift app and reads the workspace', async () => {
    const secrets = new SecretResolver({ env: process.env })
    const auth = createTokenProvider(
      {
        mode: 'app',
        client_id: 'rbw:linear-oauth-app#client_id',
        client_secret: 'rbw:linear-oauth-app#client_secret',
      },
      (ref) => secrets.resolve(ref),
    )
    const reader = createLinearReader({ auth })
    const viewer = await reader.viewer()
    expect(viewer.app).toBe(true)
    const ws = await reader.workspace()
    expect(ws.teams.length).toBeGreaterThan(0)
    console.error(
      JSON.stringify({
        viewer: { name: viewer.name, displayName: viewer.displayName, app: viewer.app },
        organization: ws.organization.name,
        plan: ws.organization.plan,
        teams: ws.teams.map((t) => `${t.key} (${t.statuses.map((s) => s.name).join(', ')})`),
        projects: ws.projects.length,
        initiatives: ws.initiatives?.length ?? null,
        labels: ws.labels.length,
        templates: ws.templates.map((t) => `${t.type}:${t.name}`),
      }),
    )
  }, 60_000)
})
