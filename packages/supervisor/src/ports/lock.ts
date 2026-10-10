import type { Run } from './records'

export type LockOutcome = { headSha: string; locks: { feature: string; changed: boolean }[] }

// Regenerates mise.lock for the Features a run changed; resolves to the possibly new head.
export type LockStep = (checkout: string, run: Run, headSha: string) => Promise<LockOutcome>

export class LockFailedError extends Error {
  override name = 'LockFailedError'
  readonly reason = 'lock_failed'
}
