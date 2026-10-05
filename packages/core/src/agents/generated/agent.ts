// Generated from packages/core/schema/agent.schema.json by `bun run gen`; do not edit.
/**
 * YAML frontmatter of agents/<name>.md: OpenCode's own AgentConfig (vendored schema, not redefined here) plus nightshift's keys under 'nightshift', which the renderer strips. Cross-file rules are in agents.md, section 'Semantic rules'.
 */
export type AgentFrontmatter = AgentConfig & {
  /**
   * what the agent does and when it is used; shown in tooling, never used for routing (routing is config.selection)
   */
  description: string
  nightshift: {
    /**
     * interactive: OpenCode TUI on the host; worker: headless OpenCode session in a sandbox; single_call: one model call, no tools
     */
    kind: 'interactive' | 'worker' | 'single_call'
    /**
     * key in config.profiles.<p>.roles that supplies the model
     */
    role: string
    /**
     * skills installed and allowed for this agent; all others are denied
     */
    skills: Id[]
    /**
     * JSON Schema for the agent's result: the single_call response, or the worker's finish 'report' field
     */
    output?: string
    /**
     * single_call only: free_then_json lets the model reason in text and end with one fenced json block
     */
    reasoning: 'json_only' | 'free_then_json'
    budget: {
      /**
       * max words in the body; checked in CI
       */
      prompt_words: number
      /**
       * max tokens of the task message the supervisor builds
       */
      input_tokens: number
    }
    /**
     * worker only: turns granted after the step or time cap to call finish
     */
    grace_turns: number
  }
  model?: never
  prompt?: never
  mode?: never
  options?: never
  tools?: never
}
export type PermissionConfig =
  | PermissionActionConfig
  | {
      read?: PermissionRuleConfig
      edit?: PermissionRuleConfig
      glob?: PermissionRuleConfig
      grep?: PermissionRuleConfig
      list?: PermissionRuleConfig
      bash?: PermissionRuleConfig
      task?: PermissionRuleConfig
      external_directory?: PermissionRuleConfig
      todowrite?: PermissionActionConfig
      question?: PermissionActionConfig
      webfetch?: PermissionActionConfig
      websearch?: PermissionActionConfig
      lsp?: PermissionRuleConfig
      doom_loop?: PermissionActionConfig
      skill?: PermissionRuleConfig
      [k: string]: PermissionRuleConfig | PermissionActionConfig | undefined
    }
export type PermissionActionConfig = 'ask' | 'allow' | 'deny'
export type PermissionRuleConfig = PermissionActionConfig | PermissionObjectConfig
export type Id = string

export interface AgentConfig {
  model?: string
  /**
   * Default model variant for this agent (applies only when using the agent's configured model).
   */
  variant?: string
  temperature?: number
  top_p?: number
  prompt?: string
  /**
   * @deprecated Use 'permission' field instead
   */
  tools?: {
    [k: string]: boolean
  }
  disable?: boolean
  /**
   * Description of when to use the agent
   */
  description?: string
  mode?: 'subagent' | 'primary' | 'all'
  /**
   * Hide this subagent from the @ autocomplete menu (default: false, only applies to mode: subagent)
   */
  hidden?: boolean
  options?: {
    [k: string]: unknown
  }
  /**
   * Hex color code (e.g., #FF5733) or theme color (e.g., primary)
   */
  color?: string | ('primary' | 'secondary' | 'accent' | 'success' | 'warning' | 'error' | 'info')
  /**
   * Maximum number of agentic iterations before forcing text-only response
   */
  steps?: number
  /**
   * @deprecated Use 'steps' field instead.
   */
  maxSteps?: number
  permission?: PermissionConfig
}
export interface PermissionObjectConfig {
  [k: string]: PermissionActionConfig
}
