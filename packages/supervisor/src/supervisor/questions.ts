import { lifecycleOf } from '../policy/stages'
import type { Awaiting, IssueUpdate } from '../ports'
import type { By } from '../ports/control'
import { ControlError } from '../ports/control'
import type { Event } from '../state/events'
import type { Run } from '../state/runs'
import type { FinishLike, SupervisorRuntime } from './runtime'

type QuestionRow = { comment: string; issue: string }

export type QuestionsPeers = {
  requireActive: (target: string) => Run
  awaiting: (issue: string) => Awaiting | null
  writeStatus: (identifier: string, change: IssueUpdate) => Promise<void>
  refresh: (identifier: string) => Promise<void>
}

export class Questions {
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
    await this.peers.writeStatus(run.issue, { status: 'blocked' })
    await this.rt.notify(`question for the ${to}: ${question}`, run.issue, {
      kind: 'question',
      context: [
        `asked by ${run.agent} (attempt ${run.attempt})${options ? `; options: ${options.join(' | ')}` : ''}`,
      ],
      question: { comment: comment.id, text: question, ...(options ? { options } : {}) },
    })
  }

  async checkQuestions(): Promise<string[]> {
    const answered: string[] = []
    const open = this.rt.deps.db
      .query<QuestionRow, []>(
        'SELECT comment, issue FROM questions WHERE answered_at IS NULL ORDER BY asked_at',
      )
      .all()
    for (const q of open) {
      const reply = (await this.rt.deps.linear.comments(q.issue)).find((c) => c.parentId === q.comment)
      if (!reply) continue
      this.rt.deps.db
        .query('UPDATE questions SET answered_at = ?, answer = ? WHERE comment = ?')
        .run(this.rt.now().toISOString(), reply.body, q.comment)
      this.rt.log.append({
        type: 'QUESTION_ANSWERED',
        issue: q.issue,
        data: { comment: q.comment, answer: reply.body, by: reply.by },
      })
      answered.push(q.issue)
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
    await this.peers.writeStatus(identifier, { status: 'ready' })
    await this.peers.refresh(identifier)
  }
}
