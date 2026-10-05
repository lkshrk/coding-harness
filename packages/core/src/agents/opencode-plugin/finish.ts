import { writeFileSync } from 'node:fs'
import { finishToolInput, validateFinish } from '../finish'
import type { JsonSchema } from '../types'

export const FINISH_PATH_ENV = 'NIGHTSHIFT_FINISH_PATH'

export type FinishPluginOptions = { outputs?: Record<string, JsonSchema> }

export type FinishCall = { sessionID: string; agent: string }

export type FinishTool = {
  name: 'finish'
  description: string
  input: JsonSchema
  options: { codemode: false }
  execute(input: unknown, context: FinishCall): Promise<{ content: string }>
}

type PluginContext = {
  options?: unknown
  tool: { transform(fn: (editor: { add(tool: FinishTool): void }) => void): Promise<void> }
}

export function finishTool(opts: FinishPluginOptions, path: string): FinishTool {
  return {
    name: 'finish',
    description:
      'Report the result of your task and end the run. Call it exactly once, as your last action, after verifying your work.',
    input: finishToolInput,
    options: { codemode: false },
    async execute(input, context) {
      const output = opts.outputs?.[context.agent]
      const result = validateFinish(output ? { output } : {}, input)
      if (!result.ok) {
        throw new Error(
          `Invalid finish payload:\n${result.errors.map((e) => `- ${e}`).join('\n')}\nCorrect it and call finish again.`,
        )
      }
      try {
        writeFileSync(path, `${JSON.stringify(result.value)}\n`, { flag: 'wx' })
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new Error('finish was already called; the first result stands. Stop now.')
        }
        throw e
      }
      return { content: 'Result recorded. Stop now.' }
    },
  }
}

export default {
  id: 'nightshift-finish',
  async setup(ctx: PluginContext): Promise<void> {
    const path = process.env[FINISH_PATH_ENV]
    if (!path) throw new Error(`${FINISH_PATH_ENV} is not set`)
    const opts = (ctx.options ?? {}) as FinishPluginOptions
    await ctx.tool.transform((editor) => editor.add(finishTool(opts, path)))
  },
}
