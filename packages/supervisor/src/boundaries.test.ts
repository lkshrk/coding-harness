import { expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import type { ControlSupervisor, InboxSupervisor } from './ports/control'
import type { Supervisor } from './supervisor/supervisor'

export type SupervisorPorts<T extends ControlSupervisor & InboxSupervisor = Supervisor> = T

const ALLOWED: Record<string, readonly string[]> = {
  runtime: ['supervisor', 'policy', 'state', 'ports', 'stages', 'adapters', 'control'],
  supervisor: ['policy', 'state', 'ports', 'stages'],
  policy: ['ports'],
  state: ['ports'],
  ports: [],
  stages: ['ports', 'state', 'policy'],
  adapters: ['ports', 'state'],
  control: ['ports', 'state'],
}

const KNOWN_VIOLATIONS = [
  'adapters/worker/executor.ts → stages/gates/host.ts',
  'adapters/worker/opencode.ts → control/generated/control.ts',
  'ports/control.ts → state/events.ts',
  'ports/control.ts → state/runs.ts',
  'ports/failure.ts → state/runs.ts',
  'ports/vault.ts → state/events.ts',
  'ports/vault.ts → state/runs.ts',
  'ports/worker.ts → state/runs.ts',
  'stages/context/ingest-runtime.ts → adapters/worker/executor.ts',
  'stages/gates/step.ts → adapters/worker/executor.ts',
  'stages/integration/stage.ts → adapters/github/gh.ts',
  'supervisor/questions.ts → control/socket/errors.ts',
  'supervisor/supervisor.ts → control/socket/errors.ts',
]

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'testing' || entry.name === 'generated') return []
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return files(path)
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && entry.name !== 'testing.ts'
      ? [path]
      : []
  })
}

test('enforces supervisor package import boundaries', () => {
  const root = import.meta.dir
  const violations = new Set<string>()
  for (const file of files(root)) {
    const importer = relative(root, file)
    if (importer === 'index.ts') continue
    const layer = importer.split('/')[0] as string
    const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const imports = source.matchAll(/^\s*(?:import|export)\s+(?:[^'";]*?\s+from\s*)?['"](\.[^'"]+)['"]/gm)
    for (const match of imports) {
      const path = resolve(dirname(file), match[1] as string)
      const target = [path, `${path}.ts`, join(path, 'index.ts')].find(
        (candidate) => candidate.endsWith('.ts') && existsSync(candidate),
      )
      expect(target, `${importer} → ${match[1]} does not resolve`).toBeDefined()
      const targetFile = relative(root, target as string)
      const targetLayer = targetFile.split('/')[0] as string
      if (targetLayer === layer) continue
      if (targetLayer === 'runtime' || !ALLOWED[layer]?.includes(targetLayer)) {
        violations.add(`${importer} → ${targetFile}`)
      }
    }
  }
  const unexpected = [...violations].filter((pair) => !KNOWN_VIOLATIONS.includes(pair)).sort()
  expect(unexpected, unexpected.join('\n')).toEqual([])
  expect(
    KNOWN_VIOLATIONS.filter((pair) => !violations.has(pair)),
    'remove resolved exceptions',
  ).toEqual([])
})
