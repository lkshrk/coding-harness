import type { Config } from '@nightshift/core'
import type { LifecycleState } from '../ports'
import { type IssueView, lifecycleOf } from './stages'

export type RunningIssue = { identifier: string; repository: string; files: string[] }

export type DispatchPlan = {
  dispatch: IssueView[]
  unblocked: { view: IssueView; by: string[] }[]
  waiting: { identifier: string; reason: string }[]
}

const GLOB = /[*?[{]/

const segments = (p: string) => p.replace(/^\.\//, '').replace(/\/+$/, '').split('/')

const isPrefix = (short: string[], long: string[]) =>
  short.length <= long.length && short.every((s, i) => s === long[i])

function staticPrefix(p: string): string[] {
  const parts = segments(p)
  const at = parts.findIndex((s) => GLOB.test(s))
  return at < 0 ? parts : parts.slice(0, at)
}

function patternsOverlap(a: string, b: string): boolean {
  const sa = segments(a)
  const sb = segments(b)
  const ga = GLOB.test(a)
  const gb = GLOB.test(b)
  if (!ga && !gb) return isPrefix(sa, sb) || isPrefix(sb, sa)
  if (ga && gb) {
    const pa = staticPrefix(a)
    const pb = staticPrefix(b)
    return isPrefix(pa, pb) || isPrefix(pb, pa)
  }
  const [glob, literal] = ga ? [a, sb] : [b, sa]
  return new Bun.Glob(glob).match(literal.join('/')) || isPrefix(literal, staticPrefix(glob))
}

export function filesOverlap(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return true
  return a.some((x) => b.some((y) => patternsOverlap(x, y)))
}

export function blockersSatisfied(view: IssueView, config: Config): string[] {
  const accepted: LifecycleState[] = view.mergeMode === 'manual' ? ['review', 'done'] : ['done']
  return view.snapshot.blockedBy
    .filter((b) => {
      const state = lifecycleOf(config, b.team, b.status)
      return state === null || !accepted.includes(state)
    })
    .map((b) => b.identifier)
}

function order(a: IssueView, b: IssueView): number {
  const prio = (v: IssueView) => (v.snapshot.priority > 0 ? v.snapshot.priority : 5)
  const est = (v: IssueView) => v.snapshot.estimate ?? Number.POSITIVE_INFINITY
  return prio(a) - prio(b) || est(a) - est(b) || a.snapshot.createdAt.localeCompare(b.snapshot.createdAt)
}

export function planDispatch(input: {
  candidates: IssueView[]
  running: RunningIssue[]
  slots: number
  config: Config
}): DispatchPlan {
  const plan: DispatchPlan = { dispatch: [], unblocked: [], waiting: [] }
  const taken: RunningIssue[] = [...input.running]
  const ready: IssueView[] = []
  for (const view of input.candidates) {
    const id = view.snapshot.identifier
    const pending = blockersSatisfied(view, input.config)
    if (pending.length) {
      plan.waiting.push({ identifier: id, reason: `blocked by ${pending.join(', ')}` })
    } else if (view.lifecycle === 'backlog') {
      plan.unblocked.push({ view, by: view.snapshot.blockedBy.map((b) => b.identifier) })
    } else {
      ready.push(view)
    }
  }
  for (const view of ready.sort(order)) {
    const id = view.snapshot.identifier
    const repository = view.repository
    if (view.templateErrors.length) {
      plan.waiting.push({ identifier: id, reason: `invalid issue: ${view.templateErrors.join('; ')}` })
      continue
    }
    if (repository === null) {
      plan.waiting.push({
        identifier: id,
        reason: 'no repo: label for a project with several repositories',
      })
      continue
    }
    const clash = taken.find((r) => r.repository === repository && filesOverlap(r.files, view.files))
    if (clash) {
      plan.waiting.push({ identifier: id, reason: `files overlap ${clash.identifier}` })
      continue
    }
    if (plan.dispatch.length >= input.slots) {
      plan.waiting.push({ identifier: id, reason: 'concurrency limit reached' })
      continue
    }
    plan.dispatch.push(view)
    taken.push({ identifier: id, repository, files: view.files })
  }
  return plan
}
