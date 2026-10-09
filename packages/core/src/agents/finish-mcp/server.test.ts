import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildFinishMcp } from './build'
import { finishServer } from './server'

const dir = mkdtempSync(join(tmpdir(), 'ns-finish-mcp-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const done = {
  status: 'DONE',
  summary: 'fixed',
  evidence: [{ kind: 'command', ref: 'bun test', result: 'pass' }],
}

test('lists finish, records one valid payload and rejects invalid or repeated calls', () => {
  const path = join(dir, 'a.json')
  const handle = finishServer({ path })
  expect(
    handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
  ).toMatchObject({
    capabilities: { tools: {} },
  })
  expect(handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).toMatchObject({
    tools: [{ name: 'finish' }],
  })
  const bad = handle({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'finish', arguments: { status: 'DONE' } },
  })
  expect(bad).toMatchObject({ isError: true })
  const ok = handle({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'finish', arguments: done },
  })
  expect(ok).toMatchObject({ isError: false })
  expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ status: 'DONE' })
  const again = handle({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'finish', arguments: done },
  })
  expect(again).toMatchObject({ isError: true })
})

test('the node bundle speaks MCP over stdio', async () => {
  const bundle = join(dir, 'finish-mcp.mjs')
  writeFileSync(bundle, await buildFinishMcp())
  const path = join(dir, 'b.json')
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'finish', arguments: done } },
  ]
    .map((m) => JSON.stringify(m))
    .join('\n')
  const proc = Bun.spawnSync(['node', bundle], {
    stdin: new TextEncoder().encode(`${input}\n`),
    env: { ...process.env, NIGHTSHIFT_FINISH_PATH: path },
  })
  const replies = proc.stdout
    .toString()
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
  expect(replies.map((r) => r.id)).toEqual([1, 2])
  expect(replies[1].result.isError).toBe(false)
  expect(JSON.parse(readFileSync(path, 'utf8')).status).toBe('DONE')
})
