import type { SelectionRule } from '@nightshift/core'

export type SelectionContext = {
  stage: string
  issueType?: string | null | undefined
  failureClass?: string | null | undefined
  attempt: number
}

function oneOf(expected: string | readonly string[] | undefined, actual: string | null | undefined): boolean {
  if (expected === undefined) return true
  if (actual === null || actual === undefined) return false
  return typeof expected === 'string' ? expected === actual : expected.includes(actual)
}

function attemptMatches(expr: string | undefined, attempt: number): boolean {
  if (expr === undefined) return true
  const n = Number(expr.slice(2))
  const op = expr.slice(0, 2)
  return op === '>=' ? attempt >= n : op === '<=' ? attempt <= n : attempt === n
}

export function selectAgent(rules: readonly SelectionRule[], ctx: SelectionContext): string | undefined {
  return rules.find(
    ({ when }) =>
      oneOf(when.stage, ctx.stage) &&
      oneOf(when.issue_type, ctx.issueType) &&
      oneOf(when.failure_class, ctx.failureClass) &&
      attemptMatches(when.attempt, ctx.attempt),
  )?.agent
}
