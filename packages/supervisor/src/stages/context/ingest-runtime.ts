import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from '@nightshift/core'
import { branchOf, workdirOf } from '../../policy/naming'
import type { BuiltContext, IssueSnapshot, SandboxDriver } from '../../ports'
import type { Event } from '../../state/events'
import type { Run } from '../../state/runs'
import type { PullRequestRecord } from '../integration/records'
import { publishIngest, writeIngestSources } from './ingest'
import type { VaultSyncOptions } from './vault'

export const VAULT_REPOSITORY = 'nightshift-vault'

export function ingestConfig(config: Config): Config {
  return {
    ...config,
    repositories: {
      ...config.repositories,
      [VAULT_REPOSITORY]: {
        path: config.paths.vault,
        remote: 'origin',
        base: 'main',
        stacks: ['bun'],
        checks: [
          { name: 'schema', run: 'bun scripts/lint.ts', timeout: '5m' },
          { name: 'wiki', run: 'obsidian-wiki lint "$PWD"', timeout: '5m' },
        ],
        risk_paths: [],
        macos_only: false,
      },
    },
  }
}

export function ingestTaskMessage(files: string[]): BuiltContext {
  const message = [
    'Ingest these immutable raw sources into this knowledge vault using AGENTS.md and wiki-ingest:',
    ...files.map((file) => `- ${file}`),
    'Commit each source separately: ingest: <source path>. Include the raw file and its page edits.',
    'If nothing durable exists, commit only the raw file. Do not push.',
    'Verify: bun scripts/lint.ts; obsidian-wiki lint "$PWD".',
    'Missing tooling or failed lint: finish BLOCKED with needs: environment.',
  ].join('\n')
  return {
    message,
    tokens: Math.ceil(message.length / 4),
    sections: [{ name: 'INGEST', tokens: Math.ceil(message.length / 4), sources: files, truncated: false }],
  }
}

export function ingestRuntime(
  o: VaultSyncOptions & { sandbox: SandboxDriver; driver: Config['sandbox']['driver']; artifacts: string },
) {
  let publishing: Promise<unknown> = Promise.resolve()
  return {
    async prepare(input: {
      issue: IssueSnapshot
      repository: string
      date: string
      events: Event[]
      pr: PullRequestRecord | null
      reuse?: boolean
    }) {
      await publishing.catch(() => undefined)
      const base = Bun.spawnSync(['git', '-C', o.dir, 'rev-parse', '--verify', 'main^{commit}'], {
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
      })
      if (base.exitCode !== 0) throw new Error(`vault base unavailable: ${base.stderr.toString().trim()}`)
      const files = writeIngestSources({ ...input, dir: o.dir })
      return {
        repository: VAULT_REPOSITORY,
        baseSha: base.stdout.toString().trim(),
        files,
        sourceFiles: files.map((path) => ({ path, content: readFileSync(join(o.dir, path), 'utf8') })),
      }
    },
    publish(run: Run): Promise<string[]> {
      const next = publishing
        .catch(() => undefined)
        .then(async () => {
          if (!run.sandbox) throw new Error('ingest worker has no sandbox')
          const context = JSON.parse(readFileSync(join(o.artifacts, run.id, 'context.json'), 'utf8')) as Pick<
            BuiltContext,
            'sections'
          >
          const sources = context.sections.find((section) => section.name === 'INGEST')?.sources
          if (!sources?.length) throw new Error('ingest sources missing from run context')
          const exported = await o.sandbox.exportCommits(
            { driver: o.driver, id: run.sandbox, name: run.id },
            workdirOf(run),
            branchOf(run),
          )
          return publishIngest({
            ...o,
            bundle: exported.bundle,
            ref: branchOf(run),
            run: run.id,
            baseSha: run.baseSha,
            sources,
          })
        })
      publishing = next
      return next
    },
  }
}
