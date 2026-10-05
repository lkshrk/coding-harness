import { isTerminal, type Run, type RunStore } from './runs'

const ISSUE = /^[A-Z][A-Z0-9]{1,6}-[1-9][0-9]*$/
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/

export function isIssueRef(target: string): boolean {
  return ISSUE.test(target)
}

export function isRunId(target: string): boolean {
  return ULID.test(target)
}

export function resolveRun(runs: Pick<RunStore, 'get' | 'forIssue'>, target: string): Run | undefined {
  if (isRunId(target)) return runs.get(target)
  if (!isIssueRef(target)) return undefined
  return runs
    .forIssue(target)
    .sort((a, b) => a.id.localeCompare(b.id))
    .at(-1)
}

export function activeRun(runs: Pick<RunStore, 'get' | 'forIssue'>, target: string): Run | undefined {
  const run = resolveRun(runs, target)
  return run && !isTerminal(run.state) ? run : undefined
}
