import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'
import type { Catalog } from './semantic'

export const FIXTURES = join(import.meta.dir, 'fixtures')

export function readFixture(name: string): Record<string, unknown> {
  return YAML.parse(readFileSync(join(FIXTURES, name), 'utf8'))
}

export function testCatalog(roles: Record<string, string> = {}): Catalog {
  const agents = {
    intake: 'worker',
    implementer: 'worker',
    repairer: 'worker',
    fixer: 'worker',
    replanner: 'worker',
    reviewer: 'reviewer',
    ...roles,
  }
  return {
    agents: new Map(Object.entries(agents).map(([name, role]) => [name, { role }])),
    stacks: new Set(['node', 'go']),
  }
}

export function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.')
  const last = keys.pop() as string
  let node: Record<string, unknown> = target
  for (const key of keys) {
    node[key] ??= {}
    node = node[key] as Record<string, unknown>
  }
  node[last] = value
}

export function unsetPath(target: Record<string, unknown>, path: string): void {
  const keys = path.split('.')
  const last = keys.pop() as string
  let node: Record<string, unknown> = target
  for (const key of keys) node = node[key] as Record<string, unknown>
  delete node[last]
}

export function minimalCatalog(): Catalog {
  return { agents: new Map([['implementer', { role: 'worker' }]]), stacks: new Set() }
}
