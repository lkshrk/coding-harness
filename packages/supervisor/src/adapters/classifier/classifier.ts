import {
  type AgentDef,
  activeProfile,
  type Config,
  fence,
  type Gateway,
  runSingleCall,
} from '@nightshift/core'
import type { Classification, Classifier, FailureClass, FailureSignal, Remediation } from '../../ports'
import type { SingleCall } from '../../ports/context'
import type { Event } from '../../state/events'

const ACTIONS: Record<FailureClass, Remediation> = {
  environment: 'retry_same',
  implementation_defect: 'retry_same',
  insufficient_context: 'enrich_context',
  task_too_large: 'split',
  missing_dependency: 'create_blocker',
  architectural_conflict: 'escalate_lead',
  capability_limit: 'escalate_user',
  unknown: 'escalate_user',
}

type ClassifierDeps = {
  config: () => Config
  agents: ReadonlyMap<string, AgentDef>
  gateway: () => Promise<Gateway>
  events: (run: string) => Event[]
  call?: SingleCall
  out?: (line: string) => void
  timeoutMs?: number
}

function input(f: FailureSignal, events: Event[]): string {
  return [
    fence('EVENT', JSON.stringify(f)),
    fence('GATES', JSON.stringify(events.filter((e) => e.type === 'GATE_FAILED' || e.type === 'CI_FAILED'))),
    fence('FINISH', JSON.stringify(f.run.finish)),
    fence('HISTORY', JSON.stringify(events)),
  ].join('\n\n')
}

export function agentClassifier(d: ClassifierDeps): Classifier {
  return {
    async classify(f): Promise<Classification> {
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const result = await Promise.race([
          (async () => {
            const def = d.agents.get('classifier')
            if (!def) throw new Error('classifier agent unavailable')
            const gateway = await d.gateway()
            const fetch = gateway.fetch ?? globalThis.fetch
            return (d.call ?? runSingleCall)<{ class: FailureClass; evidence: string }>(
              def,
              input(f, d.events(f.run.id).slice(-20)),
              {
                profile: activeProfile(d.config().profiles, f.run.profile),
                gateway: {
                  ...gateway,
                  fetch: (url, init) => fetch(url, { ...init, signal: controller.signal }),
                },
                sessionId: `${f.run.id}-classifier`,
              },
            )
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort()
              reject(new Error('classifier timed out'))
            }, d.timeoutMs ?? 30_000)
          }),
        ])
        if (!result.ok) throw new Error(`${result.reason}: ${result.detail}`)
        return { ...result.output, action: ACTIONS[result.output.class], fallback: false }
      } catch (e) {
        ;(d.out ?? console.error)(
          `${f.run.issue}: classifier fallback: ${e instanceof Error ? e.message : String(e)}`,
        )
        return { class: 'unknown', action: 'escalate_user', fallback: true }
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    },
  }
}
