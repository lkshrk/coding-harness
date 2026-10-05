import { join } from 'node:path'

export async function buildFinishPlugin(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, 'finish.ts')],
    target: 'bun',
    format: 'esm',
  })
  const [artifact] = result.outputs
  if (!result.success || !artifact) {
    throw new Error(`finish plugin build failed: ${result.logs.map(String).join('\n')}`)
  }
  return artifact.text()
}
