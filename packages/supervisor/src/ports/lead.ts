export type LeadQuestion = { issue: string; question: string; options?: string[] }

export type LeadReply = { answer: string } | { escalate: string }

export interface LeadAdvisor {
  /** null when the lead is down, errors or times out. */
  ask(q: LeadQuestion): Promise<LeadReply | null>
}
