import { afterAll, describe, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatError } from './errors'
import { NIGHTSHIFT_ROOT } from './loader'
import { readCatalog } from './semantic'
import { readFixture, setPath } from './testing'
import { validateConfig } from './validate'

const root = mkdtempSync(join(tmpdir(), 'ns-catalog-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function errorsWith(stacks: unknown, catalogRoot = NIGHTSHIFT_ROOT): string[] {
  const data = readFixture('valid/full.yaml')
  setPath(data, 'repositories.omni.stacks', stacks)
  const catalog = { ...readCatalog(catalogRoot), agents: readCatalog(NIGHTSHIFT_ROOT).agents }
  const res = validateConfig(data, { catalog, isGitRepo: () => true, home: '/home/me' })
  return res.ok ? [] : res.errors.map(formatError)
}

describe('stack catalog', () => {
  test('a stack from features/ is known', () => {
    expect(errorsWith(['bun']).filter((e) => e.includes('stacks'))).toEqual([])
  })

  test('an unknown stack is reported', () => {
    expect(errorsWith(['golang'])).toContain("repositories.omni.stacks[0]: unknown stack 'golang'")
  })

  test('an invalid stack.yaml is reported with file and field', () => {
    cpSync(join(NIGHTSHIFT_ROOT, 'features/stack-bun'), join(root, 'features/stack-bun'), { recursive: true })
    mkdirSync(join(root, 'features/stack-broken'), { recursive: true })
    writeFileSync(
      join(root, 'features/stack-broken/devcontainer-feature.json'),
      JSON.stringify({ id: 'stack-broken', version: '0.1.0' }),
    )
    writeFileSync(
      join(root, 'features/stack-broken/stack.yaml'),
      'id: broken\nmarkers: [{ file: x }]\nlsp:\n  x:\n    extensions: [.x]\n',
    )
    const errors = errorsWith(['bun'], root)
    expect(errors).toContain('features/stack-broken/stack.yaml: lsp.x.command: required')
    expect(errors.filter((e) => e.includes('repositories.omni.stacks'))).toEqual([])
  })
})
