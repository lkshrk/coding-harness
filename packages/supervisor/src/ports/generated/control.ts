// Generated from packages/supervisor/schema/control.schema.json by `bun run gen`; do not edit.
export type ErrorCode = 'bad_request' | 'not_found' | 'refused' | 'internal'
export type Issue = string
/**
 * Linear identifier (the issue's newest run) or run id (ULID)
 */
export type Target = string

/**
 * JSON over HTTP on the supervisor's Unix socket <paths.state>/nightshift.sock (mode 0600).
 */
export interface ControlApi {
  error?: ErrorResponse
  health?: Health
  ok?: Ok
  pause?: PauseRequest
  cover?: CoverRequest
  send?: SendRequest
  answer?: AnswerRequest
  stop?: StopRequest
  retry?: RetryRequest
  run?: RunResponse
  attach?: AttachInfo
  [k: string]: unknown
}
export interface ErrorResponse {
  error: {
    code: ErrorCode
    message: string
  }
}
export interface Health {
  dispatch: 'running' | 'paused'
  gateway: 'ok' | 'unavailable'
  version: string
}
export interface Ok {
  ok: true
}
export interface PauseRequest {
  issue?: Issue
}
export interface CoverRequest {
  issue: Issue
  covered: boolean
}
export interface SendRequest {
  target: Target
  message: string
}
export interface AnswerRequest {
  issue: Issue
  text: string
}
export interface StopRequest {
  target: Target
  reason?: string
}
export interface RetryRequest {
  target: Target
  agent?: string
  profile?: string
  /**
   * continue from the commit of the latest attempt that has one, whatever its failure class
   */
  continue?: boolean
}
export interface RunResponse {
  run: string
}
export interface AttachInfo {
  /**
   * OpenCode server on host loopback
   */
  url: string
  /**
   * server password; pass to the TUI through its environment only
   */
  password: string
  session: string
  workdir: string
  /**
   * command that runs the TUI inside the sandbox
   */
  fallback: string[]
  /**
   * command that opens a shell in the sandbox
   */
  shell: string[]
}
