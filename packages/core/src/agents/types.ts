import type { JsonSchema } from '../json-schema'
import type { AgentFrontmatter, OpenCodeAgentFields } from './frontmatter'

export type { JsonSchema }

export type AgentKind = AgentFrontmatter['nightshift']['kind']

export type AgentDef = {
  name: string
  file: string
  kind: AgentKind
  role: string
  description: string
  body: string
  skills: string[]
  outputPath?: string
  output?: JsonSchema
  reasoning: AgentFrontmatter['nightshift']['reasoning']
  budget: { promptWords: number; inputTokens: number }
  graceTurns: number
  opencode: OpenCodeAgentFields
}

export type AgentError = { file: string; path: string; message: string }
