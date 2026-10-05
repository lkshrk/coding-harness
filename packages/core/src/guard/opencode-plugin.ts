import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { guardLinearCommand } from './linear-guard'

export type GuardPluginOptions = { allowNoDesign?: boolean }

export type ToolCall = { tool: string; sessionID?: string; agent?: string; input: unknown }

type PluginContext = {
  options?: unknown
  tool: { hook(event: 'execute.before', fn: (call: ToolCall) => void | Promise<void>): unknown }
}

const SHELL_TOOLS = new Set(['shell', 'bash'])

export function guardToolCall(call: ToolCall, opts: GuardPluginOptions = {}): void {
  if (!SHELL_TOOLS.has(call.tool.toLowerCase())) return
  const input = (call.input ?? {}) as { command?: unknown; workdir?: unknown; cwd?: unknown }
  if (typeof input.command !== 'string') return
  const dir = [input.workdir, input.cwd].find((d): d is string => typeof d === 'string') ?? process.cwd()
  const decision = guardLinearCommand(input.command, {
    readFile: (path) => readFileSync(resolve(dir, path), 'utf8'),
    ...(opts.allowNoDesign ? { allowNoDesign: true } : {}),
  })
  if (!decision.allow) throw new Error(decision.message)
}

export default {
  id: 'linear-guard',
  async setup(ctx: PluginContext): Promise<void> {
    const opts = (ctx.options ?? {}) as GuardPluginOptions
    await ctx.tool.hook('execute.before', (call) => guardToolCall(call, opts))
  },
}
