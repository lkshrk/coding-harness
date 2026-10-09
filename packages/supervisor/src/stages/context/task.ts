import { homedir } from 'node:os'
import { type Config, expandHome, issueSpec, validateIssue } from '@nightshift/core'
import type {
  Attempt,
  BlockerOutput,
  ContextBuilder,
  ContextInput,
  IssueSnapshot,
  LinearPort,
} from '../../ports'
import type { TaskMessage, TaskStart } from '../../ports/context'
import type { Db } from '../../state/db'
import { EventLog } from '../../state/events'
import { type Run, RunStore } from '../../state/runs'
import { createUlid } from '../../state/ulid'
import { CiFailureStore } from '../integration/records'
import { selectVaultPages } from './vault'

export type { TaskMessage, TaskStart } from '../../ports/context'

export type TaskContextDeps = {
  config: () => Config
  db: Db
  linear: Pick<LinearPort, 'issue'>
  builder: ContextBuilder
  home?: string
  syncVault?: () => Promise<void>
}

function parse(issue: Pick<IssueSnapshot, 'identifier' | 'description'>) {
  return validateIssue(issue.description, { allowNoDesign: true })
}

async function blockerOutputs(
  issue: IssueSnapshot,
  linear: TaskContextDeps['linear'],
): Promise<BlockerOutput[]> {
  const ids = [...new Set(issue.blockedBy.map((b) => b.identifier))].sort()
  const out: BlockerOutput[] = []
  for (const identifier of ids) {
    const snap = await linear.issue(identifier)
    const parsed = snap ? parse(snap) : undefined
    out.push({ identifier, interfaces: parsed?.ok ? parsed.issue.sections.interfacesOut : '' })
  }
  return out
}

function summaryOf(run: Run, log: EventLog): string {
  const finish = run.finish as { summary?: unknown } | null
  if (typeof finish?.summary === 'string' && finish.summary.trim() !== '') return finish.summary
  const failed = log.since(null, { run: run.id, types: ['WORKER_FAILED', 'WORKER_NO_FINISH'] }).at(-1)
  const data = failed?.data as { reason?: string; detail?: string } | undefined
  return data?.reason ? `${data.reason}${data.detail ? `: ${data.detail}` : ''}` : ''
}

function gateTailOf(run: Run, log: EventLog): string | undefined {
  const tails = log.since(null, { run: run.id, types: ['GATE_FAILED'] }).map((e) => {
    const d = e.data as { check?: string; exit_code?: number; output_tail?: string }
    return `$ ${d.check ?? 'gate'} (exit ${d.exit_code ?? '?'})\n${d.output_tail ?? ''}`.trim()
  })
  return tails.length > 0 ? tails.join('\n\n') : undefined
}

function findingsOf(run: Run, log: EventLog): string | undefined {
  const review = log.since(null, { run: run.id, types: ['REVIEW_RECEIVED'] }).at(-1)?.data as
    | {
        verdict?: string
        findings?: { severity?: string; file?: string; lines?: string; message?: string }[]
      }
    | undefined
  if (review?.verdict !== 'fail' || !review.findings?.length) return undefined
  return review.findings
    .map(
      (f) =>
        `- ${f.severity ?? 'FINDING'} ${f.file ?? ''}${f.lines ? `:${f.lines}` : ''}: ${f.message ?? ''}`,
    )
    .join('\n')
}

export function attemptsOf(db: Db, issue: string, current: string): Attempt[] {
  const stores = { now: () => new Date(), ulid: createUlid() }
  const log = new EventLog(db, stores)
  const ci = new CiFailureStore(db)
  return new RunStore(db, stores)
    .forIssue(issue)
    .filter((r) => r.id !== current && r.failure !== null)
    .map((r) => {
      const gateTail = gateTailOf(r, log)
      const findings = findingsOf(r, log)
      const ciFailures = ci.get(r.id).filter((f) => f.log !== '')
      return {
        attempt: r.attempt,
        agent: r.agent,
        failureClass: r.failure as string,
        summary: summaryOf(r, log),
        ...(gateTail ? { gateTail } : {}),
        ...(findings ? { findings } : {}),
        ...(ciFailures.length ? { ciFailures } : {}),
      }
    })
}

export function answersOf(db: Db, issue: string): { question: string; answer: string }[] {
  const asked = new Map(
    new EventLog(db, { now: () => new Date(), ulid: createUlid() })
      .since(null, { issue, types: ['QUESTION_ASKED'] })
      .map((e) => [String(e.data.comment), String(e.data.question)]),
  )
  return db
    .query<{ comment: string; answer: string }, [string]>(
      'SELECT comment, answer FROM questions WHERE issue = ? AND answer IS NOT NULL ORDER BY asked_at',
    )
    .all(issue)
    .flatMap((r) => {
      const question = asked.get(r.comment)
      return question ? [{ question, answer: r.answer }] : []
    })
}

export function wipOf(db: Db, from: TaskStart['repairFrom']): ContextInput['wip'] {
  if (!from) return undefined
  const stores = { now: () => new Date(), ulid: createUlid() }
  const wip = new EventLog(db, stores)
    .since(null, { run: from.run, types: ['WIP_COMMITTED'] })
    .find((e) => e.data.sha === from.headSha)
  const prior = wip && new RunStore(db, stores).get(from.run)
  return prior ? { sha: from.headSha, attempt: prior.attempt } : undefined
}

export async function contextInput(
  d: TaskContextDeps,
  { run, issue, indexPath, repairFrom }: TaskStart,
): Promise<ContextInput> {
  const parsed = parse(issue)
  if (!parsed.ok) {
    throw new Error(
      `${issue.identifier}: description does not follow the issue template: ${parsed.errors.map((e) => e.message).join('; ')}`,
    )
  }
  const config = d.config()
  const repo = config.repositories[run.repository]
  if (!repo) throw new Error(`no repository '${run.repository}'`)
  const spec = issueSpec(issue.identifier, issue.title, parsed.issue)
  await d.syncVault?.()
  const wip = wipOf(d.db, repairFrom)
  return {
    ...(wip ? { wip } : {}),
    issue: spec,
    repository: {
      name: run.repository,
      checkoutPath: expandHome(repo.path, d.home ?? homedir()),
      base: run.baseSha || 'HEAD',
      ...(indexPath ? { indexPath } : {}),
    },
    blockers: await blockerOutputs(issue, d.linear),
    attempts: attemptsOf(d.db, issue.identifier, run.id),
    vaultPages: selectVaultPages(
      expandHome(config.paths.vault, d.home ?? homedir()),
      run.repository,
      spec.files,
    ),
    answers: answersOf(d.db, issue.identifier),
    run: { id: run.id, attempt: run.attempt, profile: run.profile },
  }
}

export function contextTaskMessage(d: TaskContextDeps): TaskMessage {
  return async (start, budget) => d.builder.build(await contextInput(d, start), budget)
}
