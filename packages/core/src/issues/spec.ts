import type { ParsedIssue } from './template'

export type DesignExcerpt = { documentUrl: string; section: string; text: string }

export type IssueSpec = {
  identifier: string
  title: string
  goal: string
  why: string
  designExcerpt?: DesignExcerpt
  interfacesIn: string
  interfacesOut: string
  files: string[]
  constraints: string
  outOfScope: string
  acceptance: string[]
  testsExpected: string
  verify: string[]
}

function anchor(url: string): string {
  const hash = url.indexOf('#')
  if (hash < 0) return ''
  try {
    return decodeURIComponent(url.slice(hash + 1))
  } catch {
    return url.slice(hash + 1)
  }
}

export function issueSpec(identifier: string, title: string, issue: ParsedIssue): IssueSpec {
  const s = issue.sections
  const url = issue.designLinks[0]
  return {
    identifier,
    title,
    goal: s.goal,
    why: s.why,
    ...(url && s.design ? { designExcerpt: { documentUrl: url, section: anchor(url), text: s.design } } : {}),
    interfacesIn: s.interfacesIn,
    interfacesOut: s.interfacesOut,
    files: [...issue.files],
    constraints: s.constraints,
    outOfScope: s.outOfScope,
    acceptance: [...issue.acceptance],
    testsExpected: s.tests,
    verify: [...issue.verify],
  }
}
