// Generated from schemas/intake.json by `bun run gen`; do not edit.
export interface IntakeOutput {
  /**
   * accept: ready for the project's pipeline; duplicate: same request as duplicate_of; needs_info: missing_info must be answered first; propose_decline: the user decides, nothing is cancelled
   */
  decision: 'accept' | 'duplicate' | 'needs_info' | 'propose_decline'
  type:
    | 'feature'
    | 'improvement'
    | 'bug'
    | 'chore'
    | 'investigation'
    | 'refactor'
    | 'migration'
    | 'dependency-upgrade'
  /**
   * project name exactly as listed in PROJECTS; null when none fits
   */
  project: string | null
  /**
   * Linear priority: 0 none, 1 urgent, 2 high, 3 medium, 4 low
   */
  priority: number
  /**
   * identifier from SIMILAR this issue duplicates
   */
  duplicate_of: string | null
  /**
   * identifiers from SIMILAR about the same area but not the same request
   */
  group_with: string[]
  /**
   * questions the reporter must answer, one per entry
   */
  missing_info: string[]
}
