import type { ErrorCode } from '../generated/control'

export type { ErrorCode }

export class ControlError extends Error {
  override name = 'ControlError'

  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
  }
}
