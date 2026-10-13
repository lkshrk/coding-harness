import { type Config, validateIssue } from '@nightshift/core'
import type { IssueSnapshot } from '../ports'
import { filesOverlap } from './ready'
import { lifecycleOf } from './stages'

export type PlanReport = { errors: string[]; warnings: string[]; ready: string[]; waiting: string[] }

const byId = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true })

/** Checks a project's issues before dispatch; pure. */
export function validatePlan(issues: readonly IssueSnapshot[], config: Config): PlanReport {
  const report: PlanReport = { errors: [], warnings: [], ready: [], waiting: [] }
  const given = new Map(issues.map((i) => [i.identifier, i]))
  const isOpen = (i: IssueSnapshot) => {
    const state = lifecycleOf(config, i.team, i.status)
    return state !== 'done' && state !== 'canceled'
  }
  const open = issues.filter(isOpen).sort((a, b) => byId(a.identifier, b.identifier))
  // Edges point from blocker to blocked, restricted to the given issues.
  const blocks = new Map<string, string[]>()
  for (const i of issues)
    for (const b of i.blockedBy)
      if (given.has(b.identifier))
        blocks.set(b.identifier, [...(blocks.get(b.identifier) ?? []), i.identifier])
  const openIds = new Set(open.map((i) => i.identifier))
  const openBlocks = new Map<string, string[]>()
  for (const [from, to] of blocks)
    if (openIds.has(from))
      openBlocks.set(
        from,
        to.filter((id) => openIds.has(id)),
      )

  const files = new Map<string, string[]>()
  for (const i of open) {
    const template = validateIssue(i.description, { allowNoDesign: true })
    if (template.ok) files.set(i.identifier, template.issue.files)
    else for (const e of template.errors) report.errors.push(`${i.identifier}: ${e.message}`)
    if (i.estimate === null) report.errors.push(`${i.identifier}: no estimate`)
  }
  for (const cycle of cycles(openBlocks)) report.errors.push(`cycle: ${cycle.join(' → ')}`)

  for (const i of open) {
    const done = i.blockedBy.every((b) => {
      const blocker = given.get(b.identifier) ?? b
      return lifecycleOf(config, blocker.team, blocker.status) === 'done'
    })
    ;(done ? report.ready : report.waiting).push(i.identifier)
  }

  const candidates = report.ready.filter((id) => files.has(id))
  for (const [n, a] of candidates.entries()) {
    for (const b of candidates.slice(n + 1)) {
      const fa = files.get(a) ?? []
      const fb = files.get(b) ?? []
      if (!filesOverlap(fa, fb) || reaches(blocks, a, b) || reaches(blocks, b, a)) continue
      const touched = [
        ...new Set([...fa.filter((x) => filesOverlap([x], fb)), ...fb.filter((y) => filesOverlap(fa, [y]))]),
      ]
      report.warnings.push(
        `${a} and ${b} both touch ${touched.join(', ')}; they will run one after the other`,
      )
    }
  }
  return report
}

function reaches(edges: ReadonlyMap<string, string[]>, from: string, to: string): boolean {
  const seen = new Set<string>([from])
  const stack = [from]
  for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
    for (const next of edges.get(at) ?? []) {
      if (next === to) return true
      if (!seen.has(next)) {
        seen.add(next)
        stack.push(next)
      }
    }
  }
  return false
}

/** One cycle per strongly connected component, starting and ending at its smallest identifier. */
function cycles(edges: ReadonlyMap<string, string[]>): string[][] {
  const nodes = [...new Set([...edges.keys(), ...[...edges.values()].flat()])].sort(byId)
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const components: string[][] = []
  const visit = (v: string) => {
    index.set(v, index.size)
    low.set(v, index.get(v) ?? 0)
    stack.push(v)
    onStack.add(v)
    for (const w of edges.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w)
        low.set(v, Math.min(low.get(v) ?? 0, low.get(w) ?? 0))
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v) ?? 0, index.get(w) ?? 0))
    }
    if (low.get(v) !== index.get(v)) return
    const component: string[] = []
    for (let w = stack.pop(); w !== undefined; w = stack.pop()) {
      onStack.delete(w)
      component.push(w)
      if (w === v) break
    }
    components.push(component)
  }
  for (const v of nodes) if (!index.has(v)) visit(v)

  const out: string[][] = []
  for (const component of components) {
    const members = new Set(component)
    const start = component.sort(byId)[0]
    if (start === undefined) continue
    if (component.length === 1 && !(edges.get(start) ?? []).includes(start)) continue
    out.push(shortestLoop(edges, members, start))
  }
  return out.sort((a, b) => byId(a[0] ?? '', b[0] ?? ''))
}

function shortestLoop(edges: ReadonlyMap<string, string[]>, members: Set<string>, start: string): string[] {
  const prev = new Map<string, string>()
  const queue = [start]
  for (let at = queue.shift(); at !== undefined; at = queue.shift()) {
    for (const next of [...(edges.get(at) ?? [])].sort(byId)) {
      if (!members.has(next)) continue
      if (next === start) {
        const path = [start]
        for (let p: string | undefined = at; p !== undefined && p !== start; p = prev.get(p))
          path.splice(1, 0, p)
        return [...path, start]
      }
      if (!prev.has(next)) {
        prev.set(next, at)
        queue.push(next)
      }
    }
  }
  return [start, start]
}
