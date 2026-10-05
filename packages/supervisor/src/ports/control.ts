import type { Event } from '../state/events'
import type { Run } from '../state/runs'

export type By = 'cli' | 'supervisor' | 'lead' | 'signal'

export interface InboxSupervisor {
  status(): SupervisorStatus
  pause(reason: string, by?: By): void
  resume(reason: string, by?: By): void
  hold(issue: string, by?: By): void
  unhold(issue: string, by?: By): void
  cover(issue: string, by?: By): void
  sendMessage(target: string, text: string, by: By): Promise<Run>
  answerQuestion(issue: string, text: string, by: By): Promise<void>
  stopForUser(target: string, reason: string | undefined, by: By): Promise<Run>
  retryRun(target: string, o: { agent?: string; profile?: string; continue?: boolean }, by: By): Promise<Run>
}

export interface ControlSupervisor extends InboxSupervisor {
  gateway(): 'ok' | 'unavailable'
  uncover(issue: string, by?: By): void
  resolveRun(target: string): Run | undefined
}

export type Waiting = { identifier: string; reason: string }

export type OpenQuestion = {
  comment: string
  issue: string
  run: string | null
  askedTo: string
  askedAt: string
}

export type SupervisorStatus = {
  dispatch: 'running' | 'paused'
  restartRequired: boolean
  activeProfile: string | null
  active: Run[]
  waiting: Waiting[]
  questions: OpenQuestion[]
  failures: Event[]
  held: string[]
  covered: string[]
  linearOrg: string | null
}
