// Generated from packages/core/schema/finish.schema.json by `bun run gen`; do not edit.
/**
 * Argument of the 'finish' tool every worker must call exactly once. 'report' is validated against the agent's own output schema when the agent declares one.
 */
export interface FinishPayload {
  /**
   * DONE: acceptance criteria met and verified; DONE_WITH_CONCERNS: met, with doubts listed in concerns; BLOCKED: cannot proceed, see blocker; NEEDS_CONTEXT: information missing, see blocker.question
   */
  status: 'DONE' | 'DONE_WITH_CONCERNS' | 'BLOCKED' | 'NEEDS_CONTEXT'
  /**
   * one to three sentences a human can read in Linear
   */
  summary: string
  /**
   * what was run or checked; the supervisor re-runs gates itself and never trusts this alone
   */
  evidence: {
    kind: 'command' | 'test' | 'file' | 'observation'
    /**
     * command line, test id, file path, or what was looked at
     */
    ref: string
    result: 'pass' | 'fail' | 'info'
    detail?: string
  }[]
  changed_files?: string[]
  concerns?: string[]
  blocker?: {
    needs: 'context' | 'decision' | 'dependency' | 'permission' | 'environment'
    reason: string
    /**
     * the exact question for the lead or you
     */
    question?: string
    /**
     * fixed answers to choose from, when the question has them
     *
     * @minItems 2
     * @maxItems 10
     */
    options?: string[]
  }
  /**
   * agent-specific result, validated against nightshift.output of the agent
   */
  report?: {
    [k: string]: unknown
  }
}
