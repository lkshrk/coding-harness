import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { generate } from './gen'

describe('generated files', () => {
  test('match their schemas (bun run gen)', async () => {
    for (const { path, content } of await generate()) {
      expect({ path, content: readFileSync(path, 'utf8') }).toEqual({ path, content })
    }
  }, 30_000)
})
