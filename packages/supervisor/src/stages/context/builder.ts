import { WORKER_BLOCKS, type WorkerBlock } from '@nightshift/core'
import type { BuiltContext, ContextBudget, ContextBuilder, ContextInput, ContextSection } from '../../ports'

import {
  type ContextBuilderDeps,
  DONORS,
  designItems,
  type Flexible,
  fileItems,
  historyItems,
  type Item,
  interfaceItems,
  issueBody,
  joinParts,
  type Kept,
  knowledgeItems,
  renderMessage,
  SECTION_SHARES,
  takePrefix,
  verifyBody,
} from './sections'

export * from './sections'

export const TASK_TOO_LARGE = "issue too large for the agent's budget"

export class TaskTooLargeError extends Error {
  override name = 'TaskTooLargeError'
  readonly reason = 'task_too_large'

  constructor(detail: string) {
    super(`${TASK_TOO_LARGE}: ${detail}`)
  }
}

export class FencedContextBuilder implements ContextBuilder {
  constructor(private readonly d: ContextBuilderDeps) {}

  async build(input: ContextInput, budget: ContextBudget): Promise<BuiltContext> {
    const counted = new Map<string, Promise<number>>()
    const count = (text: string) => {
      let n = counted.get(text)
      if (n === undefined) {
        n = this.d.count(text, budget.model)
        counted.set(text, n)
      }
      return n
    }

    const issue = issueBody(input.issue)
    const verify = verifyBody(input.issue)
    const empty = { DESIGN: '', INTERFACES: '', FILES: '', KNOWLEDGE: '', HISTORY: '' }
    const fixed = await count(renderMessage({ ISSUE: issue, VERIFY: verify, ...empty }))
    if (fixed > budget.inputTokens) {
      throw new TaskTooLargeError(`ISSUE and VERIFY take ${fixed} tokens, budget ${budget.inputTokens}`)
    }
    const free = budget.inputTokens - fixed
    const cap = (name: Flexible) => Math.floor(free * SECTION_SHARES[name])

    const source = this.d.source(input.repository)
    const candidates: Record<Flexible, Item[]> = {
      DESIGN: designItems(input.issue),
      INTERFACES: interfaceItems(input),
      FILES: await fileItems(input, source, this.d),
      KNOWLEDGE: knowledgeItems(input.vaultPages),
      HISTORY: historyItems(input),
    }

    const kept = {} as Record<Flexible, Kept>
    let spare = 0
    for (const name of DONORS) {
      kept[name] = await takePrefix(candidates[name], cap(name), count)
      spare += cap(name) - kept[name].tokens
    }
    kept.FILES = await takePrefix(candidates.FILES, cap('FILES') + spare, count)

    const bodies = (): Record<WorkerBlock, string> => ({
      ISSUE: issue,
      VERIFY: verify,
      DESIGN: joinParts(kept.DESIGN.items.map((i) => i.text)),
      INTERFACES: joinParts(kept.INTERFACES.items.map((i) => i.text)),
      FILES: joinParts(kept.FILES.items.map((i) => i.text)),
      KNOWLEDGE: joinParts(kept.KNOWLEDGE.items.map((i) => i.text)),
      HISTORY: joinParts(kept.HISTORY.items.map((i) => i.text)),
    })
    let message = renderMessage(bodies())
    let tokens = await count(message)
    while (tokens > budget.inputTokens && kept.FILES.items.length > 0) {
      const dropped = kept.FILES.items.pop() as Item
      kept.FILES.tokens -= await count(dropped.text)
      kept.FILES.truncated = true
      message = renderMessage(bodies())
      tokens = await count(message)
    }

    const fixedSection = async (name: 'ISSUE' | 'VERIFY', body: string): Promise<ContextSection> => ({
      name,
      tokens: body === '' ? 0 : await count(body),
      sources: [input.issue.identifier],
      truncated: false,
    })
    const sections: ContextSection[] = [
      await fixedSection('ISSUE', issue),
      await fixedSection('VERIFY', verify),
    ]
    for (const name of WORKER_BLOCKS) {
      if (name === 'ISSUE' || name === 'VERIFY') continue
      const k = kept[name]
      sections.push({ name, tokens: k.tokens, sources: k.items.map((i) => i.source), truncated: k.truncated })
    }
    return { message, tokens, sections }
  }
}
