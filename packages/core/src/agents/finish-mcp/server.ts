import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { finishToolInput, validateFinish } from '../finish'
import type { JsonSchema } from '../types'

export const FINISH_MCP_SERVER = 'nightshift'
export const FINISH_MCP_TOOL = `mcp__${FINISH_MCP_SERVER}__finish`

type Request = { jsonrpc: '2.0'; id?: number | string; method: string; params?: Record<string, unknown> }
type Reply = Record<string, unknown> | undefined

const DESCRIPTION =
  'Report the result of your task and end the run. Call it exactly once, as your last action, after verifying your work.'

export function finishServer(o: { path: string; output?: JsonSchema }): (req: Request) => Reply {
  let done = false
  const text = (content: string, isError = false) => ({ content: [{ type: 'text', text: content }], isError })
  return (req) => {
    switch (req.method) {
      case 'initialize':
        return {
          protocolVersion: String(req.params?.protocolVersion ?? '2025-06-18'),
          capabilities: { tools: {} },
          serverInfo: { name: FINISH_MCP_SERVER, version: '1' },
        }
      case 'tools/list':
        return { tools: [{ name: 'finish', description: DESCRIPTION, inputSchema: finishToolInput }] }
      case 'tools/call': {
        if (req.params?.name !== 'finish') return text(`unknown tool ${String(req.params?.name)}`, true)
        if (done) return text('finish was already called; the first result stands. Stop now.', true)
        const result = validateFinish(o.output ? { output: o.output } : {}, req.params?.arguments ?? {})
        if (!result.ok)
          return text(
            `Invalid finish payload:\n${result.errors.map((e) => `- ${e}`).join('\n')}\nCorrect it and call finish again.`,
            true,
          )
        try {
          writeFileSync(o.path, `${JSON.stringify(result.value)}\n`, { flag: 'wx' })
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
          done = true
          return text('finish was already called; the first result stands. Stop now.', true)
        }
        done = true
        return text('Result recorded. Stop now.')
      }
      case 'ping':
        return {}
      default:
        return req.id === undefined
          ? undefined
          : { __error: { code: -32601, message: `unknown method ${req.method}` } }
    }
  }
}

export function serve(handle: (req: Request) => Reply): void {
  const lines = createInterface({ input: process.stdin })
  lines.on('line', (line) => {
    if (!line.trim()) return
    const req = JSON.parse(line) as Request
    if (req.id === undefined) return
    const result = handle(req)
    const error = result?.__error
    process.stdout.write(
      `${JSON.stringify(error ? { jsonrpc: '2.0', id: req.id, error } : { jsonrpc: '2.0', id: req.id, result })}\n`,
    )
  })
}
