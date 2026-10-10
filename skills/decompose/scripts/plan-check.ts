import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { validateIssue } from '../../../packages/core/src/issues'
import { filesOverlap } from '../../../packages/supervisor/src/policy/ready'

export type PlanIssue = {
  key: string
  title: string
  description: string
  estimate?: number
  blocks?: string[]
}

export type Plan = { issues: PlanIssue[] }

export type PlanReport = { errors: string[]; warnings: string[] }

export function checkPlan(plan: Plan, read: (path: string) => string): PlanReport {
  const errors: string[] = []
  const warnings: string[] = []
  const keys = new Set(plan.issues.map((i) => i.key))
  const files = new Map<string, string[]>()

  for (const issue of plan.issues) {
    if (issue.estimate === undefined || issue.estimate === null) errors.push(`${issue.key}: no estimate`)
    for (const target of issue.blocks ?? [])
      if (!keys.has(target)) errors.push(`${issue.key}: blocks unknown issue ${target}`)
    let text: string
    try {
      text = read(issue.description)
    } catch {
      errors.push(`${issue.key}: cannot read ${issue.description}`)
      continue
    }
    const result = validateIssue(text, { allowNoDesign: false })
    if (!result.ok) for (const e of result.errors) errors.push(`${issue.key}: ${e.message}`)
    else files.set(issue.key, result.issue.files)
  }

  const edges = new Map(plan.issues.map((i) => [i.key, (i.blocks ?? []).filter((t) => keys.has(t))]))
  const cycle = findCycle([...keys], edges)
  if (cycle) errors.push(`cycle: ${cycle.join(' → ')}`)

  const reach = new Map([...keys].map((k) => [k, reachable(k, edges)]))
  const list = [...files.keys()]
  for (let a = 0; a < list.length; a++)
    for (let b = a + 1; b < list.length; b++) {
      const x = list[a] as string
      const y = list[b] as string
      const ordered = reach.get(x)?.has(y) || reach.get(y)?.has(x)
      if (!ordered && filesOverlap(files.get(x) ?? [], files.get(y) ?? []))
        warnings.push(
          `${x} and ${y} touch overlapping files without a blocks path; they will run one after the other`,
        )
    }
  return { errors, warnings }
}

function reachable(start: string, edges: Map<string, string[]>): Set<string> {
  const seen = new Set<string>()
  const stack = [...(edges.get(start) ?? [])]
  while (stack.length) {
    const next = stack.pop() as string
    if (seen.has(next)) continue
    seen.add(next)
    stack.push(...(edges.get(next) ?? []))
  }
  return seen
}

function findCycle(keys: string[], edges: Map<string, string[]>): string[] | null {
  const state = new Map<string, 'visiting' | 'done'>()
  const path: string[] = []
  const visit = (k: string): string[] | null => {
    if (state.get(k) === 'done') return null
    if (state.get(k) === 'visiting') return [...path.slice(path.indexOf(k)), k]
    state.set(k, 'visiting')
    path.push(k)
    for (const n of edges.get(k) ?? []) {
      const found = visit(n)
      if (found) return found
    }
    path.pop()
    state.set(k, 'done')
    return null
  }
  for (const k of keys) {
    const found = visit(k)
    if (found) return found
  }
  return null
}

if (import.meta.main) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: plan-check.sh <plan.json>')
    process.exit(2)
  }
  const base = dirname(resolve(file))
  const plan = JSON.parse(readFileSync(file, 'utf8')) as Plan
  const report = checkPlan(plan, (p) => readFileSync(resolve(base, p), 'utf8'))
  const lines = [
    ...report.errors.map((e) => `error ${e}`),
    ...report.warnings.map((w) => `warning ${w}`),
    `${plan.issues.length} issue(s), ${report.errors.length} error(s), ${report.warnings.length} warning(s)`,
  ]
  process.stdout.write(`${lines.join('\n')}\n`)
  process.exit(report.errors.length > 0 ? 1 : 0)
}
