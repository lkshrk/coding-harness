import { join } from 'node:path'

export async function buildFinishMcp(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, 'main.ts')],
    target: 'node',
    format: 'esm',
    // Bun-only; reached through json-schema.ts but unused on the finish path.
    define: { 'import.meta.dir': '"."' },
  })
  const [artifact] = result.outputs
  if (!result.success || !artifact)
    throw new Error(`finish MCP build failed: ${result.logs.map(String).join('\n')}`)
  return artifact.text()
}
