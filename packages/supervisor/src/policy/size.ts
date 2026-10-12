import { validateIssue } from '@nightshift/core'
import type { EffectiveLimits } from './limits'
import type { IssueView } from './stages'

export type IssueSize = {
  estimate: number | null
  files: number
  risk: string[]
  designVerbs: string[]
  over: string[]
  near: boolean
}

export type SizeDecision = 'dispatch' | 'forced' | 'explore' | 'decomposition' | 'too_large'

export function sizeData(size: IssueSize, decision: SizeDecision, profile: string): Record<string, unknown> {
  return {
    estimate: size.estimate,
    files: size.files,
    risk: size.risk,
    design_verbs: size.designVerbs,
    over: size.over,
    near: size.near,
    profile,
    decision,
  }
}

type SizeLimits = Pick<EffectiveLimits, 'max_estimate' | 'max_files'>

const DIRECTORY_WEIGHT = 3
const DESIGN_VERBS: readonly [string, RegExp][] = [
  ['decide', /\bdecid(e|es|ing)\b/i],
  ['design', /\bdesign(s|ing)?\b/i],
  ['choose', /\b(choose|chooses|choosing)\b/i],
  ['bind … to', /\bbind\b[^.\n]*\bto\b/i],
]

const isDirectory = (entry: string) => entry.endsWith('/') || /[*?[{]/.test(entry)

function goalOf(view: IssueView): string {
  const parsed = validateIssue(view.snapshot.description, { allowNoDesign: true })
  return parsed.ok ? parsed.issue.sections.goal : ''
}

export function issueSize(
  view: IssueView,
  repo: { risk_paths?: readonly string[] } | undefined,
  limits: SizeLimits = {},
): IssueSize {
  const estimate = view.snapshot.estimate
  const files = view.files.reduce((n, f) => n + (isDirectory(f) ? DIRECTORY_WEIGHT : 1), 0)
  const riskPaths = repo?.risk_paths ?? []
  const risk = view.files.filter((f) =>
    riskPaths.some((p) => {
      const path = f.replace(/^\.\//, '').replace(/\/+$/, '')
      return new Bun.Glob(p).match(path) || new Bun.Glob(p).match(`${path}/x`)
    }),
  )
  const goal = goalOf(view)
  const designVerbs = DESIGN_VERBS.filter(([, re]) => re.test(goal)).map(([verb]) => verb)
  const over: string[] = []
  const { max_estimate, max_files } = limits
  if (max_estimate !== undefined && estimate !== null && estimate > max_estimate)
    over.push(`estimate ${estimate} > ${max_estimate}`)
  if (max_files !== undefined && files > max_files) over.push(`files ${files} > ${max_files}`)
  const near =
    over.length === 0 &&
    ((max_estimate !== undefined && estimate !== null && estimate >= max_estimate - 1) ||
      (max_files !== undefined && files >= max_files - 2))
  return { estimate, files, risk, designVerbs, over, near }
}
