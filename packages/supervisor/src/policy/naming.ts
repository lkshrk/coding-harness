import type { Run } from '../ports/records'
import type { Ms } from '../ports/sandbox'

export const BRANCH_PREFIX = 'ns/'

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000 }
const UNIT_TOKENS: Record<string, number> = { k: 1_000, M: 1_000_000 }

export function parseDuration(value: string): Ms {
  const m = value.match(/^([1-9][0-9]*)(s|m|h)$/)
  if (!m) throw new Error(`invalid duration '${value}'`)
  return Number(m[1]) * (UNIT_MS[m[2] as string] as number)
}

export function parseTokens(value: string): number {
  const m = value.match(/^([1-9][0-9]*)(k|M)?$/)
  if (!m) throw new Error(`invalid token count '${value}'`)
  return Number(m[1]) * (m[2] ? (UNIT_TOKENS[m[2]] as number) : 1)
}

export function workdirOf(run: Pick<Run, 'repository'>): string {
  return `/work/${run.repository}`
}

export function branchOf(run: Pick<Run, 'issue' | 'attempt'>): string {
  return `ns/${run.issue}-${run.attempt}`
}

export function runRef(run: string): string {
  return `refs/nightshift/${run}`
}

export function prRef(number: number): string {
  return `refs/nightshift/pr/${number}`
}
