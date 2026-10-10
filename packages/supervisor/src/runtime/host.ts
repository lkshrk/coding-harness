import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { type Config, expandHome, GatewayError, parseAgent } from '@nightshift/core'
import { prRef } from '../policy/naming'
import type { Notifier, OutboxDirs, RepoInspector } from '../ports'
import type { SingleCall } from '../stages/gates'

export function gitRepos(
  config: () => Config,
  auth: (repository: string) => Promise<Record<string, string>> = async () => ({}),
): RepoInspector {
  return {
    async baseSha(repository) {
      const { repo, git } = await hostGit(config, auth, repository)
      git('fetch', '--quiet', repo.remote, repo.base)
      return git('rev-parse', `${repo.remote}/${repo.base}`)
    },
    async fetchPullRequest(repository, pr) {
      const { repo, git } = await hostGit(config, auth, repository)
      const ref = prRef(pr.number)
      git('fetch', '--quiet', '--no-write-fetch-head', repo.remote, `+refs/heads/${pr.branch}:${ref}`)
      return git('rev-parse', '--verify', `${ref}^{commit}`)
    },
  }
}

async function hostGit(
  config: () => Config,
  auth: (repository: string) => Promise<Record<string, string>>,
  repository: string,
) {
  const repo = config().repositories[repository]
  if (!repo) throw new Error(`no repository '${repository}'`)
  const cwd = expandHome(repo.path, homedir())
  const env = { ...process.env, ...(await auth(repository)) }
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(['git', ...args], {
      cwd,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
    })
    if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} in ${cwd}: ${r.stderr.toString().trim()}`)
    return r.stdout.toString().trim()
  }
  return { repo, git }
}

export function outboxDirs(dir: string): OutboxDirs {
  return {
    list: () => {
      try {
        return readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
      } catch {
        return []
      }
    },
    remove: (run) => rmSync(join(dir, run), { recursive: true, force: true }),
  }
}

export function logNotifier(out: (line: string) => void): Notifier {
  return {
    async notify({ title, issue }) {
      out(`notify: ${title}${issue ? ` (${issue})` : ''}`)
      return null
    },
  }
}

export function skillFiles(dir: string): { path: string; content: string }[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)))
    .sort()
    .map((path) => ({ path, content: readFileSync(join(dir, path), 'utf8') }))
}

// Interactive agents' skills ship outside this repository's skills/ directory.
export function hostSkills(agentsDir: string): string[] {
  return readdirSync(agentsDir)
    .filter((f) => f.endsWith('.md'))
    .flatMap((f) => {
      const { def } = parseAgent(f, readFileSync(join(agentsDir, f), 'utf8'))
      return def?.kind === 'interactive' ? def.skills : []
    })
}

export function gatewaySingleCall(
  call: SingleCall,
  reachable: (ok: boolean, reason: string) => void,
): SingleCall {
  return async <T>(...args: Parameters<SingleCall>) => {
    try {
      const result = await call<T>(...args)
      if (!result.ok && result.reason === 'gateway_error') reachable(false, result.detail)
      else if (result.ok || result.reason === 'invalid_output' || result.trace?.inputTokens !== undefined)
        reachable(true, `${args[0].name} gateway call succeeded`)
      return result
    } catch (e) {
      if (e instanceof GatewayError) reachable(false, e.message)
      throw e
    }
  }
}
