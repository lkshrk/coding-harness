import { lifecycleOf } from '../policy/stages'
import type { Intent } from '../policy/transition'
import type { Awaiting } from '../ports'
import type { By } from '../ports/control'
import { ControlError } from '../ports/control'
import type { Event } from '../state/events'
import type { Run } from '../state/runs'
import type { FinishLike, SupervisorRuntime } from './runtime'

type QuestionRow = { comment: string; issue: string; run: string | null; asked_to: 'lead' | 'user' }

type Asked = { comment: string; issue: string; run: Run; question: string; options?: string[] }

export type QuestionsPeers = {
  requireActive: (target: string) => Run
  awaiting: (issue: string) => Awaiting | null
  applyIntent: (identifier: string, intent: Intent) => Promise<void>
  refresh: (identifier: string) => Promise<void>
  replanAnswered: (issue: string, comment: string, answer: string) => Promise<boolean>
}

export class Questions {
  private readonly forwarded = new Set<string>()

  constructor(
    private readonly rt: SupervisorRuntime,
    private readonly peers: QuestionsPeers,
  ) {}

  async sendMessage(target: string, text: string, by: By): Promise<Run> {
    const run = this.peers.requireActive(target)
    if (run.state !== 'running' || run.session === null) {
      throw new ControlError('refused', `run ${run.id} of ${run.issue} is ${run.state}; it takes no messages`)
    }
    await this.rt.deps.executor.nudge(run, text)
    this.rt.log.append({ type: 'MESSAGE_SENT', issue: run.issue, run: run.id, data: { text, by } })
    return run
  }

  async answerQuestion(issue: string, text: string, by: By): Promise<void> {
    const q = this.rt.deps.db
      .query<{ comment: string; run: string | null }, [string]>(
        'SELECT comment, run FROM questions WHERE issue = ? AND answered_at IS NULL ORDER BY asked_at DESC',
      )
      .get(issue)
    if (!q) throw new ControlError('not_found', `no open question on ${issue}`)
    await this.rt.deps.linear.comment(issue, text, { parentId: q.comment })
    this.rt.log.append({
      type: 'MESSAGE_SENT',
      issue,
      ...(q.run ? { run: q.run } : {}),
      data: { text, by, comment: q.comment },
    })
  }

  async askQuestion(run: Run, cause: Event, blocker: NonNullable<FinishLike['blocker']>): Promise<void> {
    const to = blocker.needs === 'decision' || blocker.needs === 'permission' ? 'user' : 'lead'
    const question = blocker.question || blocker.reason || 'the worker needs more context'
    const options = blocker.options?.length ? blocker.options : undefined
    const choices = options ? `\n\nOptions: ${options.join(' | ')}` : ''
    const comment = await this.rt.postOnce(
      run.issue,
      cause.id,
      `Question for the ${to}: ${question}${choices}`,
    )
    this.rt.log.append({
      type: 'QUESTION_ASKED',
      issue: run.issue,
      run: run.id,
      data: { to, question, comment: comment.id, ...(options ? { options } : {}) },
    })
    this.rt.deps.db
      .query(
        'INSERT OR IGNORE INTO questions (comment, issue, run, asked_to, asked_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(comment.id, run.issue, run.id, to, this.rt.now().toISOString())
    await this.peers.applyIntent(run.issue, { kind: 'heldForUser' })
    const asked = { comment: comment.id, issue: run.issue, run, question, ...(options ? { options } : {}) }
    if (to === 'lead' && this.rt.deps.lead) this.forward(asked)
    else await this.notifyOwner(to, asked)
  }

  private async notifyOwner(to: 'lead' | 'user', q: Asked, reason?: string): Promise<void> {
    await this.rt.notify(`question for the ${to}: ${q.question}`, q.issue, {
      kind: 'question',
      context: [
        `asked by ${q.run.agent} (attempt ${q.run.attempt})${q.options ? `; options: ${q.options.join(' | ')}` : ''}`,
        ...(reason ? [reason] : []),
      ],
      question: { comment: q.comment, text: q.question, ...(q.options ? { options: q.options } : {}) },
    })
  }

  /** Asks the lead in the background; one ask per question comment for the life of the process. */
  private forward(q: Asked): void {
    const lead = this.rt.deps.lead
    if (!lead || this.forwarded.has(q.comment)) return
    this.forwarded.add(q.comment)
    const ask = async () => {
      const reply = await lead
        .ask({ issue: q.issue, question: q.question, ...(q.options ? { options: q.options } : {}) })
        .catch(() => null)
      if (reply && 'answer' in reply) {
        await this.rt.deps.linear.comment(q.issue, reply.answer, { parentId: q.comment })
        this.rt.log.append({
          type: 'MESSAGE_SENT',
          issue: q.issue,
          run: q.run.id,
          data: { text: reply.answer, by: 'lead', comment: q.comment },
        })
        return
      }
      const reason = reply ? `lead escalated: ${reply.escalate}` : 'lead unavailable or timed out'
      await this.notifyOwner('lead', q, reason)
    }
    ask().catch((e: Error) =>
      console.error(`${q.issue}: forwarding the question to the lead failed: ${e.message}`),
    )
  }

  private reforward(q: QuestionRow): void {
    if (q.asked_to !== 'lead' || !this.rt.deps.lead || this.forwarded.has(q.comment) || !q.run) return
    const run = this.rt.runs.get(q.run)
    const data = this.rt.log
      .since(null, { issue: q.issue, types: ['QUESTION_ASKED'] })
      .find((e) => e.data.comment === q.comment)?.data as
      | { question?: string; options?: string[] }
      | undefined
    if (!run || !data?.question) return
    this.forward({
      comment: q.comment,
      issue: q.issue,
      run,
      question: data.question,
      ...(data.options?.length ? { options: data.options } : {}),
    })
  }

  async checkQuestions(): Promise<string[]> {
    const answered: string[] = []
    const open = this.rt.deps.db
      .query<QuestionRow, []>(
        'SELECT comment, issue, run, asked_to FROM questions WHERE answered_at IS NULL ORDER BY asked_at',
      )
      .all()
    for (const q of open) {
      const reply = (await this.rt.deps.linear.comments(q.issue)).find((c) => c.parentId === q.comment)
      if (!reply) {
        this.reforward(q)
        continue
      }
      this.rt.deps.db
        .query('UPDATE questions SET answered_at = ?, answer = ? WHERE comment = ?')
        .run(this.rt.now().toISOString(), reply.body, q.comment)
      this.rt.log.append({
        type: 'QUESTION_ANSWERED',
        issue: q.issue,
        data: { comment: q.comment, answer: reply.body, by: reply.by },
      })
      answered.push(q.issue)
      if (await this.peers.replanAnswered(q.issue, q.comment, reply.body)) continue
      await this.resumeAnswered(q.issue)
    }
    return answered
  }

  private async resumeAnswered(identifier: string): Promise<void> {
    const stillOpen = this.rt.deps.db
      .query<{ n: number }, [string]>(
        'SELECT COUNT(*) AS n FROM questions WHERE issue = ? AND answered_at IS NULL',
      )
      .get(identifier)
    if (
      stillOpen?.n ||
      this.peers.awaiting(identifier) ||
      this.rt.runs.active().some((r) => r.issue === identifier)
    )
      return
    const issue = this.rt.cache.get(identifier)
    if (!issue || lifecycleOf(this.rt.config(), issue.team, issue.status) !== 'blocked') return
    await this.peers.applyIntent(identifier, { kind: 'released' })
    await this.peers.refresh(identifier)
  }
}
