// Generated from schemas/acceptor.json by `bun run gen`; do not edit.
export interface AcceptorOutput {
  /**
   * one entry per criterion in CRITERIA, in the same order
   *
   * @minItems 1
   */
  criteria: {
    /**
     * the criterion text as given
     */
    criterion: string
    /**
     * met: evidence shows it holds; not_met: evidence shows it does not; unverifiable: no evidence either way
     */
    verdict: 'met' | 'not_met' | 'unverifiable'
    /**
     * gate, test or issue result that decides the verdict; for unverifiable, what is missing
     */
    evidence: string
  }[]
}
