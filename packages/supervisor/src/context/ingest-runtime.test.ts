import { expect, test } from 'bun:test'
import { testConfig } from '../testing'
import { ingestConfig, ingestTaskMessage, VAULT_REPOSITORY } from './ingest-runtime'

test('derives an isolated vault repository with only the required lints', () => {
  const config = testConfig()
  const derived = ingestConfig(config)
  expect(config.repositories[VAULT_REPOSITORY]).toBeUndefined()
  expect(derived.repositories[VAULT_REPOSITORY]).toMatchObject({
    path: config.paths.vault,
    base: 'main',
    remote: 'origin',
    stacks: ['bun'],
    checks: [{ run: 'bun scripts/lint.ts' }, { run: 'obsidian-wiki lint "$PWD"' }],
  })
})

test('ingest task names immutable sources and checks without selecting issue context', () => {
  const built = ingestTaskMessage(['raw/linear/2026-10-05-FOR-1.md'])
  expect(built.message).toContain('raw/linear/2026-10-05-FOR-1.md')
  expect(built.message).toContain('obsidian-wiki lint "$PWD"')
  expect(built.sections[0]?.sources).toEqual(['raw/linear/2026-10-05-FOR-1.md'])
})
