import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { guardLinearCommand } from './linear-guard'

export type HookResult = { code: 0 | 2; stderr: string }

export type HookDeps = { readFile(path: string): string; cwd: string }

const defaultDeps: HookDeps = { readFile: (path) => readFileSync(path, 'utf8'), cwd: process.cwd() }

export function runClaudeHook(stdin: string, deps: HookDeps = defaultDeps): HookResult {
  let payload: { tool_name?: unknown; tool_input?: { command?: unknown }; cwd?: unknown }
  try {
    payload = JSON.parse(stdin)
  } catch {
    return { code: 2, stderr: 'linear-guard: hook input is not JSON' }
  }
  const command = payload.tool_input?.command
  if (payload.tool_name !== 'Bash' || typeof command !== 'string') return { code: 0, stderr: '' }
  const dir = typeof payload.cwd === 'string' ? payload.cwd : deps.cwd
  const decision = guardLinearCommand(command, { readFile: (path) => deps.readFile(resolve(dir, path)) })
  return decision.allow ? { code: 0, stderr: '' } : { code: 2, stderr: decision.message }
}

if (import.meta.main) {
  const { code, stderr } = runClaudeHook(await Bun.stdin.text())
  if (stderr) console.error(stderr)
  process.exit(code)
}
