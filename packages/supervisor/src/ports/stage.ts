import type { IssueSnapshot } from './linear'

export type StageWork = { issue: IssueSnapshot; stage: string; agent: string | undefined }

export interface StageHandler {
  run(work: StageWork): Promise<void>
  /** False when the handler has nothing to do for the stage; omitted means it handles every stage. */
  handles?(stage: string): boolean
}
