import { join } from 'node:path'

async function bundle(entry: string, name: string): Promise<string> {
  const result = await Bun.build({ entrypoints: [entry], target: 'bun', format: 'esm' })
  const [artifact] = result.outputs
  if (!result.success || !artifact) {
    throw new Error(`${name} plugin build failed: ${result.logs.map(String).join('\n')}`)
  }
  return artifact.text()
}

export function buildFinishPlugin(): Promise<string> {
  return bundle(join(import.meta.dir, 'finish.ts'), 'finish')
}

export function buildGuardPlugin(): Promise<string> {
  return bundle(join(import.meta.dir, '..', '..', 'guard', 'opencode-plugin.ts'), 'linear-guard')
}
