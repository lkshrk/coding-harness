import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { overlaps, selectVaultPages, vaultSync } from './vault'

let vault: string
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'ns-vault-'))
})
afterEach(() => rmSync(vault, { recursive: true, force: true }))

function page(path: string, fm: Record<string, string>, body = 'Body.') {
  const full = join(vault, path)
  mkdirSync(dirname(full), { recursive: true })
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`)
  writeFileSync(full, `---\n${lines.join('\n')}\n---\n\n${body}\n\n## Sources\n\n- raw/x.md\n`)
}

describe('overlaps', () => {
  test('globs and paths overlap through matches or nested fixed prefixes', () => {
    expect(
      overlaps(
        ['frontend/src/lib/components/planner/**'],
        ['frontend/src/lib/components/planner/Pane.svelte'],
      ),
    ).toBe(true)
    expect(overlaps(['frontend/**'], ['frontend/src/lib/components/planner/*.svelte'])).toBe(true)
    expect(overlaps(['frontend/src/lib/components/planner/**'], ['frontend/src/**'])).toBe(true)
    expect(overlaps(['backend/**'], ['frontend/src/a.ts'])).toBe(false)
    expect(overlaps(['frontend/src/lib/a.ts'], ['frontend/src/lib/ab.ts'])).toBe(false)
  })
})

describe('selectVaultPages', () => {
  test('pages for the repository: touched first, then by category, overview last; others excluded', () => {
    page('projects/routivo/routivo.md', {
      title: 'Routivo',
      category: 'project',
      repo: '[routivo]',
      paths: '[]',
      lifecycle: 'draft',
    })
    page('projects/routivo/patterns/ports.md', {
      title: 'Ports',
      category: 'patterns',
      repo: '[routivo]',
      paths: '[]',
      lifecycle: 'draft',
    })
    page('projects/routivo/pitfalls/hooks.md', {
      title: 'Hooks',
      category: 'pitfalls',
      repo: '[routivo]',
      paths: '[]',
      lifecycle: 'reviewed',
    })
    page('projects/routivo/decisions/planner.md', {
      title: 'Planner',
      category: 'decisions',
      repo: '[routivo]',
      paths: '["frontend/src/lib/components/planner/**"]',
      lifecycle: 'draft',
    })
    page('projects/routivo/pitfalls/maplibre.md', {
      title: 'MapLibre',
      category: 'pitfalls',
      repo: '[routivo]',
      paths: '["frontend/src/lib/map/**"]',
      lifecycle: 'draft',
    })
    page('projects/routivo/pitfalls/old.md', {
      title: 'Old',
      category: 'pitfalls',
      repo: '[routivo]',
      paths: '[]',
      lifecycle: 'archived',
    })
    page('projects/omni/pitfalls/tui.md', {
      title: 'TUI',
      category: 'pitfalls',
      repo: '[omni]',
      paths: '[]',
      lifecycle: 'draft',
    })
    writeFileSync(join(vault, 'index.md'), '# Index\n')
    mkdirSync(join(vault, 'raw'))
    writeFileSync(join(vault, 'raw', 'r.md'), '---\nrepo: [routivo]\n---\n')

    const pages = selectVaultPages(vault, 'routivo', [
      'frontend/src/lib/components/planner/PlaceSearchInput.svelte',
    ])
    expect(pages.map((p) => p.path)).toEqual([
      'projects/routivo/decisions/planner.md',
      'projects/routivo/pitfalls/hooks.md',
      'projects/routivo/pitfalls/maplibre.md',
      'projects/routivo/patterns/ports.md',
      'projects/routivo/routivo.md',
    ])
    expect(pages[0]).toEqual({
      path: 'projects/routivo/decisions/planner.md',
      title: 'Planner',
      content: 'Body.',
    })
  })

  test('a missing vault or a page with broken frontmatter yields no pages instead of failing', () => {
    expect(selectVaultPages(join(vault, 'missing'), 'routivo', [])).toEqual([])
    mkdirSync(join(vault, 'pitfalls'))
    writeFileSync(join(vault, 'pitfalls', 'bad.md'), '---\nrepo: [routivo\n---\nx\n')
    expect(selectVaultPages(vault, 'routivo', [])).toEqual([])
  })
})

describe('vaultSync', () => {
  test('pulls at most once per interval and never throws', async () => {
    mkdirSync(join(vault, '.git'))
    let t = 0
    const tokens: string[] = []
    const out: string[] = []
    const sync = vaultSync({
      dir: vault,
      token: async (owner) => {
        tokens.push(owner)
        throw new Error('sts down')
      },
      authEnv: () => ({}),
      owner: () => 'lkshrk',
      intervalMs: 1000,
      now: () => t,
      out: (l) => out.push(l),
    })
    await sync()
    await sync()
    t = 1500
    await sync()
    expect(tokens).toEqual(['lkshrk', 'lkshrk'])
    expect(out).toEqual(['vault: pull failed: sts down', 'vault: pull failed: sts down'])
  })

  test("runs the vault's sync script with the token env and reports local changes by name", async () => {
    mkdirSync(join(vault, '.git'))
    mkdirSync(join(vault, 'scripts'))
    const script = join(vault, 'scripts', 'sync.sh')
    writeFileSync(script, '#!/bin/sh\necho "uncommitted changes: $AUTH" >&2\nexit 1\n')
    chmodSync(script, 0o755)
    const out: string[] = []
    await vaultSync({
      dir: vault,
      token: async () => 'tok',
      authEnv: (token) => ({ AUTH: token }),
      owner: () => 'lkshrk',
      out: (l) => out.push(l),
    })()
    expect(out).toEqual(['vault: not synced, local changes: uncommitted changes: tok'])
  })
})
