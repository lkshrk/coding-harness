import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finishToolInput } from '../finish'
import { buildFinishPlugin } from './build'
import plugin, { FINISH_PATH_ENV, type FinishTool, finishTool } from './finish'

const done = {
  status: 'DONE',
  summary: 'Fixed the off-by-one in pagination.',
  evidence: [{ kind: 'test', ref: 'pagination.test.ts', result: 'pass' }],
}
const output = { type: 'object', required: ['files'], properties: { files: { type: 'array' } } }
const call = { sessionID: 'ses_1', agent: 'fixer' }

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nightshift-finish-'))
  path = join(dir, 'finish.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('finishTool', () => {
  test('is a direct tool with the finish schema as input', () => {
    const tool = finishTool({}, path)
    expect(tool).toMatchObject({ name: 'finish', input: finishToolInput, options: { codemode: false } })
  })

  test('records a valid payload and tells the model to stop', async () => {
    const res = await finishTool({}, path).execute(done, call)
    expect(res.content).toContain('recorded')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(done)
  })

  test('returns the validation errors and records nothing for an invalid payload', async () => {
    await expect(finishTool({}, path).execute({ ...done, status: 'BLOCKED' }, call)).rejects.toThrow(
      'blocker: required for status BLOCKED',
    )
    expect(existsSync(path)).toBe(false)
  })

  test("validates report against the calling agent's output schema", async () => {
    const tool = finishTool({ outputs: { fixer: output } }, path)
    await expect(tool.execute({ ...done, report: { files: 1 } }, call)).rejects.toThrow('report.files')
    await expect(
      finishTool({ outputs: { other: output } }, path).execute({ ...done, report: { files: 1 } }, call),
    ).resolves.toBeDefined()
  })

  test('rejects a second call and keeps the first payload', async () => {
    const tool = finishTool({}, path)
    await tool.execute(done, call)
    await expect(tool.execute({ ...done, summary: 'again' }, call)).rejects.toThrow(
      'finish was already called',
    )
    expect(JSON.parse(readFileSync(path, 'utf8')).summary).toBe(done.summary)
  })
})

describe('plugin', () => {
  async function setupWith(env: string | undefined, options?: unknown): Promise<FinishTool[]> {
    const added: FinishTool[] = []
    const ctx = {
      options,
      tool: {
        transform: async (fn: (e: { add(t: FinishTool): void }) => void) => fn({ add: (t) => added.push(t) }),
      },
    }
    const prev = process.env[FINISH_PATH_ENV]
    if (env === undefined) delete process.env[FINISH_PATH_ENV]
    else process.env[FINISH_PATH_ENV] = env
    try {
      await plugin.setup(ctx)
      return added
    } finally {
      if (prev === undefined) delete process.env[FINISH_PATH_ENV]
      else process.env[FINISH_PATH_ENV] = prev
    }
  }

  test('registers finish with the path from the environment', async () => {
    const [tool] = await setupWith(path, { outputs: { fixer: output } })
    await tool?.execute({ ...done, report: { files: [] } }, call)
    expect(existsSync(path)).toBe(true)
  })

  test('fails to load without the finish path', async () => {
    await expect(setupWith(undefined)).rejects.toThrow(`${FINISH_PATH_ENV} is not set`)
  })
})

describe('buildFinishPlugin', () => {
  test('bundles a self-contained module that default-exports the plugin', async () => {
    const code = await buildFinishPlugin()
    expect(code).not.toMatch(/from ["'](zod|\.\.?\/)/)
    const file = join(dir, 'index.js')
    writeFileSync(file, code)
    const mod = await import(file)
    expect(mod.default.id).toBe('nightshift-finish')
  })
})
