import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type AgentDef,
  activeProfile,
  type Config,
  fence,
  type Gateway,
  runSingleCall,
} from '@nightshift/core'
import type { SingleCall } from '../gates'
import type { Ranking, RankRequest } from './builder'

export const SELECTOR = 'context-selector'

export type SelectorDeps = {
  config: () => Config
  agents: ReadonlyMap<string, AgentDef>
  gateway: () => Promise<Gateway>
  cacheDir: string
  call?: SingleCall
  out?: (line: string) => void
}

type SelectorOutput = { files: { path: string; reason: string }[]; pages: unknown[] }

export function selectorInput({ input, files, outlines }: RankRequest): string {
  const i = input.issue
  const issue = [
    `${i.identifier}: ${i.title}`,
    i.goal.trim() && `## Goal\n${i.goal.trim()}`,
    i.acceptance.length > 0 && `## Acceptance criteria\n${i.acceptance.map((a) => `- ${a}`).join('\n')}`,
    i.constraints.trim() && `## Constraints\n${i.constraints.trim()}`,
    i.interfacesIn.trim() && `## Interfaces in\n${i.interfacesIn.trim()}`,
    i.interfacesOut.trim() && `## Interfaces out\n${i.interfacesOut.trim()}`,
  ]
    .filter(Boolean)
    .join('\n\n')
  return `${[
    fence('ISSUE', issue),
    fence('FILES', files.map((f) => `- ${f}`).join('\n')),
    fence('OUTLINES', outlines.map((o) => `## ${o.path}\n${o.outline}`).join('\n\n')),
    fence('PAGES', ''),
  ].join('\n\n')}\n`
}

function cacheFile(dir: string, req: RankRequest): string | undefined {
  const run = req.input.run
  if (!run) return undefined
  const key = `${req.input.repository.base}-${run.attempt}`
  return join(dir, req.input.issue.identifier, `${key}.json`)
}

function readCache(file: string | undefined): Ranking | undefined {
  if (!file || !existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Ranking
  } catch {
    return undefined
  }
}

function writeCache(file: string | undefined, ranking: Ranking): void {
  if (!file) return
  mkdirSync(join(file, '..'), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(ranking, null, 2)}\n`)
  renameSync(tmp, file)
}

export function contextSelector(d: SelectorDeps): (req: RankRequest) => Promise<Ranking | undefined> {
  return async (req) => {
    const file = cacheFile(d.cacheDir, req)
    const cached = readCache(file)
    if (cached) return cached
    const def = d.agents.get(SELECTOR)
    const run = req.input.run
    if (!def || !run) return undefined
    const log = (msg: string) => d.out?.(`${req.input.issue.identifier}: ${SELECTOR}: ${msg}`)
    try {
      const res = await (d.call ?? runSingleCall)<SelectorOutput>(def, selectorInput(req), {
        profile: activeProfile(d.config().profiles, run.profile),
        gateway: await d.gateway(),
        sessionId: `${run.id}-selector`,
      })
      if (!res.ok) {
        log(`${res.reason}: ${res.detail}`)
        return undefined
      }
      const listed = new Set([...req.files, ...req.outlines.map((o) => o.path)])
      const seen = new Set<string>()
      const files = res.output.files.filter(
        (f) => listed.has(f.path) && !seen.has(f.path) && seen.add(f.path),
      )
      const ranking = { files }
      writeCache(file, ranking)
      return ranking
    } catch (e) {
      log((e as Error).message)
      return undefined
    }
  }
}
