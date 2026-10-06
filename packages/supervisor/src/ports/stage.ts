import type { IssueSnapshot } from './linear'

export type StageWork = { issue: IssueSnapshot; stage: string; agent: string | undefined }

export interface StageHandler {
  run(work: StageWork): Promise<void>
}
