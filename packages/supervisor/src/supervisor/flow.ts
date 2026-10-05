import type { By } from '../ports/control'
import type { Run } from '../state/runs'
import type { Dispatcher } from './dispatch'
import type { Holds } from './holds'
import type { Ingest } from './ingest'
import type { Leases } from './leases'
import type { LinearSync } from './linear-sync'
import type { PullRequestWatch } from './pr-watch'
import type { Questions } from './questions'
import type { Remediation } from './remediation'
import type { RunLifecycle } from './run-lifecycle'
import type { RunFlow } from './runtime'
import type { Verification } from './verification'

export type Modules = {
  holds: Holds
  linearSync: LinearSync
  leasing: Leases
  questions: Questions
  ingest: Ingest
  lifecycle: RunLifecycle
  verification: Verification
  prWatch: PullRequestWatch
  dispatcher: Dispatcher
  remediation: Remediation
}

export type FlowHost = {
  stopped(): boolean
  paused(): boolean
  pause(reason: string, by?: By): void
  schedule(run: Run): void
  gatewayReachable(reachable: boolean, reason: string): void
  resolveRun(target: string): Run | undefined
  modules(): Modules
}

export function runFlow(h: FlowHost): RunFlow {
  return {
    stopped: h.stopped,
    paused: h.paused,
    pause: (reason, by) => h.pause(reason, by),
    schedule: (run) => h.schedule(run),
    gatewayReachable: (reachable, reason) => h.gatewayReachable(reachable, reason),
    viewOptions: (issue) => h.modules().holds.viewOptions(issue),
    awaiting: (issue) => h.modules().holds.awaiting(issue),
    setAwaiting: (issue, value) => h.modules().holds.setAwaiting(issue, value),
    holdForYou: (issue, awaiting) => h.modules().holds.holdForYou(issue, awaiting),
    coveredSet: () => h.modules().holds.coveredSet(),
    uncover: (issue) => h.modules().holds.uncover(issue),
    observeIssue: (issue) => h.modules().linearSync.observeIssue(issue),
    refresh: (id) => h.modules().linearSync.refresh(id),
    writeStatus: (id, change) => h.modules().linearSync.writeStatus(id, change),
    relabel: (id, stage, from) => h.modules().linearSync.relabel(id, stage, from),
    takeLease: (run) => h.modules().leasing.takeLease(run),
    releaseLease: (issue) => h.modules().leasing.releaseLease(issue),
    leaseEvent: (type, issue) => h.modules().leasing.leaseEvent(type, issue),
    askQuestion: (run, cause, blocker) => h.modules().questions.askQuestion(run, cause, blocker),
    checkQuestions: () => h.modules().questions.checkQuestions(),
    startIngest: (view) => h.modules().ingest.startIngest(view),
    ingestFinished: (run, event, finish) => h.modules().ingest.ingestFinished(run, event, finish),
    ingestRunFailed: (runId, reason, cause) => h.modules().ingest.ingestRunFailed(runId, reason, cause),
    workerFailed: (runId, reason, detail) => h.modules().lifecycle.workerFailed(runId, reason, detail),
    stopRun: (runId, reason, by) => h.modules().lifecycle.stopRun(runId, reason, by),
    end: (runId, to, cause) => h.modules().lifecycle.end(runId, to, cause),
    resolveRun: (target) => h.resolveRun(target),
    completeStage: (id) => h.modules().verification.completeStage(id),
    enterVerification: (id) => h.modules().verification.enterVerification(id),
    backToImplementation: (id) => h.modules().verification.backToImplementation(id),
    forceManual: (issue, why) => h.modules().prWatch.forceManual(issue, why),
    remediate: (run, reason, detail) => h.modules().remediation.remediate(run, reason, detail),
    recoverRun: (run) =>
      h.modules().lifecycle.recoverRun(run, { reattached: [], resumed: [], failed: [], stopped: [] }),
    requireActive: (target) => h.modules().lifecycle.requireActive(target),
    profileFor: (view) => h.modules().dispatcher.profileFor(view),
    forgetStalls: (runId) => h.modules().lifecycle.forgetStalls(runId),
  }
}
