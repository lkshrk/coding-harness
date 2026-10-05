import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type ActiveProfile,
  type AgentDef,
  activeProfile,
  type Config,
  fence,
  type Gateway,
  resolveAlias,
  runSingleCall,
  validateIssue,
} from '@nightshift/core'
import type { IssueSnapshot, LinearPort } from '../ports'
import type { Run } from '../runs'
import type { GateEventData } from './report'

export const REVIEWER = 'reviewer'
const LENS_ITEMS = 8
const GATE_TAIL_LINES = 20

export type ReviewFinding = {
  severity: 'BLOCKER' | 'SUGGESTION'
  file: string
  lines?: string
  message: string
  evidence: string
  confidence: number
}

export type ReviewOutput = { verdict: 'pass' | 'fail'; findings: ReviewFinding[] }

export type ReviewOutcome =
  | { kind: 'verdict'; review: ReviewOutput; model: string }
  | {
      kind: 'unreviewed'
      reason: 'invalid_output' | 'input_over_budget'
      model: string
      detail: string
      errors?: string[]
      tokens?: number
      budget?: number
    }
  | { kind: 'refused'; error: string }
  | { kind: 'error'; reason: 'gateway_error' | 'crash'; detail: string }

export interface ReviewCallbacks {
  gateResults(runId: string): GateEventData[]
  reviewFinished(runId: string, outcome: ReviewOutcome): Promise<void>
}

export type SingleCall = typeof runSingleCall

export type ReviewStepDeps = {
  config: () => Config
  agents: ReadonlyMap<string, AgentDef>
  linear: Pick<LinearPort, 'issue'>
  artifacts: string
  gateway: () => Promise<Gateway>
  callbacks: () => ReviewCallbacks
  call?: SingleCall
}

export function concreteModel(active: ActiveProfile, alias: string): string {
  return active.profile.models[alias]?.model ?? alias
}

export function familyConflict(
  config: Config,
  run: Pick<Run, 'profile'>,
  worker: Pick<AgentDef, 'role'> | undefined,
  reviewer: Pick<AgentDef, 'role'>,
): string | undefined {
  const active = activeProfile(config.profiles, run.profile)
  const family = (role: string) => {
    const alias = active.profile.roles[role]
    return alias === undefined ? undefined : active.profile.models[alias]?.family
  }
  const theirs = family(reviewer.role)
  if (theirs === undefined || theirs !== family(worker?.role ?? 'worker')) return undefined
  return `profiles.${active.name}: reviewer family ${theirs} equals worker family`
}

export function numberDiff(patch: string): string {
  let oldLine = 0
  let newLine = 0
  return patch
    .split('\n')
    .map((line) => {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      if (hunk) {
        oldLine = Number(hunk[1])
        newLine = Number(hunk[2])
        return line
      }
      if (
        /^(diff --git |index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode)/.test(
          line,
        )
      )
        return line
      if (line.startsWith('+')) return `+${newLine++} ${line.slice(1)}`
      if (line.startsWith('-')) return `-${oldLine++} ${line.slice(1)}`
      if (line.startsWith(' ')) {
        oldLine++
        return ` ${newLine++} ${line.slice(1)}`
      }
      return line
    })
    .join('\n')
}

export function splitDiff(numbered: string, tests: readonly string[]): { diff: string; tests: string } {
  const files = numbered.split(/^(?=diff --git )/m)
  const isTest = (part: string) => {
    const path = /^diff --git a\/(\S+) b\//.exec(part)?.[1]
    return path !== undefined && tests.includes(path)
  }
  return {
    diff: files.filter((f) => !isTest(f)).join(''),
    tests: files.filter(isTest).join(''),
  }
}

function section(title: string, body: string): string {
  return body.trim() === '' ? '' : `## ${title}\n${body.trim()}`
}

export function reviewInput(o: {
  issue: IssueSnapshot
  patch: string
  testsTouched: readonly string[]
  gates: readonly GateEventData[]
}): string {
  const parsed = validateIssue(o.issue.description, { allowNoDesign: true })
  const acceptance = parsed.ok ? parsed.issue.acceptance : []
  const issue = parsed.ok
    ? [
        `${o.issue.identifier}: ${o.issue.title}`,
        section('Goal', parsed.issue.sections.goal),
        section('Acceptance criteria', acceptance.map((a) => `- ${a}`).join('\n')),
        section('Design excerpt', parsed.issue.sections.design),
      ]
    : [`${o.issue.identifier}: ${o.issue.title}`, o.issue.description]
  const lens = ['Lens: acceptance', ...acceptance.slice(0, LENS_ITEMS).map((a, i) => `${i + 1}. ${a}`)].join(
    '\n',
  )
  const { diff, tests } = splitDiff(numberDiff(o.patch), o.testsTouched)
  const gates = o.gates
    .map((g) => {
      const tail = (g.output_tail ?? '').split('\n').slice(-GATE_TAIL_LINES).join('\n').trim()
      return [`${g.check}: pass (exit ${g.exit_code}, ${(g.duration_ms / 1000).toFixed(1)}s)`, tail]
        .filter(Boolean)
        .join('\n')
    })
    .join('\n\n')
  return `${[
    fence('ISSUE', issue.filter(Boolean).join('\n\n')),
    fence('LENS', lens),
    fence('DIFF', diff),
    fence('TESTS', tests),
    fence('GATES', gates),
  ].join('\n\n')}\n`
}

function readLines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : []
}

async function review(d: ReviewStepDeps, run: Run): Promise<ReviewOutcome> {
  const config = d.config()
  const def = d.agents.get(REVIEWER)
  if (!def) return { kind: 'refused', error: `agents: no ${REVIEWER} agent loaded` }
  const conflict = familyConflict(config, run, d.agents.get(run.agent), def)
  if (conflict) return { kind: 'refused', error: conflict }
  const active = activeProfile(config.profiles, run.profile)
  const model = concreteModel(active, resolveAlias(def, active))
  const issue = await d.linear.issue(run.issue)
  if (!issue) return { kind: 'error', reason: 'crash', detail: `review: no issue ${run.issue}` }
  const dir = join(d.artifacts, run.id)
  const patchPath = join(dir, 'diff.patch')
  if (!existsSync(patchPath)) return { kind: 'error', reason: 'crash', detail: `review: no ${patchPath}` }
  const input = reviewInput({
    issue,
    patch: readFileSync(patchPath, 'utf8'),
    testsTouched: readLines(join(dir, 'tests-touched.txt')),
    gates: d.callbacks().gateResults(run.id),
  })
  const call = d.call ?? runSingleCall
  const res = await call<ReviewOutput>(def, input, {
    profile: active,
    gateway: await d.gateway(),
    sessionId: run.id,
  })
  if (res.ok) return { kind: 'verdict', review: res.output, model }
  if (res.reason === 'gateway_error') return { kind: 'error', reason: 'gateway_error', detail: res.detail }
  return {
    kind: 'unreviewed',
    reason: res.reason,
    model,
    detail: res.detail,
    ...(res.errors ? { errors: res.errors } : {}),
    ...(res.tokens !== undefined ? { tokens: res.tokens, budget: def.budget.inputTokens } : {}),
  }
}

export function reviewStep(d: ReviewStepDeps): (run: Run) => Promise<void> {
  return async (run) => {
    let outcome: ReviewOutcome
    try {
      outcome = await review(d, run)
    } catch (e) {
      outcome = { kind: 'error', reason: 'crash', detail: `review: ${(e as Error).message}` }
    }
    await d.callbacks().reviewFinished(run.id, outcome)
  }
}

export function reviewComment(review: ReviewOutput, model: string): string {
  const head = `Review ${review.verdict === 'pass' ? 'passed' : 'failed'} (\`${model}\`).`
  if (!review.findings.length) return `${head} No findings.`
  const lines = review.findings.map((f) => {
    const where = f.lines ? `${f.file}:${f.lines}` : f.file
    return `- **${f.severity}** \`${where}\` (confidence ${f.confidence}): ${f.message}\n  Evidence: ${f.evidence.replace(/\n/g, ' ')}`
  })
  return [head, '', ...lines].join('\n')
}

export function blockerSummary(review: ReviewOutput): string {
  return review.findings
    .filter((f) => f.severity === 'BLOCKER')
    .map((f) => `${f.lines ? `${f.file}:${f.lines}` : f.file}: ${f.message}`)
    .join('; ')
}
