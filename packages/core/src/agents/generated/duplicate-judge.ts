// Generated from schemas/duplicate-judge.json by `bun run gen`; do not edit.
export interface DuplicateJudgeOutput {
  /**
   * duplicate: both ask for the same outcome; related: same area, different outcome; unrelated: neither
   */
  verdict: 'duplicate' | 'related' | 'unrelated'
  /**
   * probability that the verdict is right
   */
  confidence: number
  /**
   * the outcome both issues ask for, in one sentence; null unless the verdict is duplicate
   */
  shared_outcome: string | null
}
