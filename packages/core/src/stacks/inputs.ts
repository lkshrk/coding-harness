import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { matchesFile, type RepoTree, versionValues } from './detect'
import type { LspEntry, Stack } from './load'

export type RunResult = { exitCode: number; stdout: string; stderr: string }
export type Run = (cmd: string[], opts?: { onLine?: (line: string) => void }) => Promise<RunResult>

export const DEFAULT_DEVCONTAINER = {
  image: 'debian:trixie@sha256:9cc080028c43b27d2074d63a5f9caf7166d731494965616c1a6d2827a004585c',
  features: {
    'ghcr.io/devcontainers/features/common-utils:2': {
      installZsh: false,
      installOhMyZsh: false,
      installOhMyZshConfig: false,
      upgradePackages: false,
      username: 'none',
    },
  },
}

export const FEATURES_DIR = '.nightshift'

export const PACKAGE_MANAGERS_OPTION = 'packageManagers'

export const PLAYWRIGHT_VERSION_OPTION = 'playwrightVersion'

export const PYTHON_VERSION_OPTION = 'pythonVersion'

const PLAYWRIGHT_LOCKS: Record<string, (text: string) => string[]> = {
  'pnpm-lock.yaml': (t) =>
    [...t.matchAll(/^\s+'?\/?playwright-core@(\d[^:('\s]*)/gm)].map((m) => m[1] as string),
  'package-lock.json': (t) => {
    try {
      const v = JSON.parse(t).packages?.['node_modules/playwright-core']?.version
      return typeof v === 'string' ? [v] : []
    } catch {
      return []
    }
  },
  'yarn.lock': (t) =>
    [...t.matchAll(/^"?playwright-core@[^\n]*:\n\s+version:?\s+"?([^"\s]+)/gm)].map((m) => m[1] as string),
  'bun.lock': (t) => [...t.matchAll(/"playwright-core@(\d[^"]*)"/g)].map((m) => m[1] as string),
}

export async function playwrightVersion(tree: RepoTree): Promise<string> {
  const found = new Set<string>()
  for (const path of await tree.list()) {
    if (path.split('/').includes('node_modules')) continue
    for (const [file, extract] of Object.entries(PLAYWRIGHT_LOCKS)) {
      if (!matchesFile(path, file)) continue
      for (const v of extract((await tree.read(path)) ?? ''))
        if (/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v)) found.add(v)
    }
  }
  return [...found].sort(Bun.semver.order).at(-1) ?? ''
}

export async function pythonVersion(tree: RepoTree, python: Stack): Promise<string> {
  const values = await versionValues(tree, [python])
  const depth = (key: string) => key.split('/').length
  const pick = (suffix: string) =>
    [...values]
      .filter(([key]) => key.endsWith(suffix))
      .sort(([a], [b]) => depth(a) - depth(b) || a.localeCompare(b))
      .map(([, value]) => value)
  const pinned = pick('.python-version')
    .map(
      (text) =>
        text
          .split('\n')
          .find((l) => l.trim() && !l.trim().startsWith('#'))
          ?.trim() ?? '',
    )
    .find(Boolean)
  if (pinned) return pinned
  const required = pick('#project.requires-python')[0]
  return required === undefined ? '' : String(JSON.parse(required))
}

async function pipeLines(
  stream: ReadableStream<Uint8Array>,
  onLine?: (line: string) => void,
): Promise<string> {
  const decoder = new TextDecoder()
  let text = ''
  let pending = ''
  for await (const chunk of stream) {
    const part = decoder.decode(chunk, { stream: true })
    text += part
    if (!onLine) continue
    pending += part
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) onLine(line)
  }
  if (onLine && pending) onLine(pending)
  return text
}

export const spawnRun: Run = async (cmd, opts = {}) => {
  const proc = Bun.spawn(cmd, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    pipeLines(proc.stdout, opts.onLine),
    pipeLines(proc.stderr, opts.onLine),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

export function lspConfig(stacks: Stack[]): Record<string, LspEntry> {
  const out: Record<string, LspEntry> = {}
  for (const stack of [...stacks].sort((a, b) => a.id.localeCompare(b.id))) {
    for (const [name, entry] of Object.entries(stack.lsp)) {
      const existing = out[name]
      out[name] = existing
        ? { ...existing, extensions: [...new Set([...existing.extensions, ...entry.extensions])] }
        : structuredClone(entry)
    }
  }
  return out
}

export function imageRepository(repo: string): string {
  return `nightshift/env-${repo.toLowerCase()}`
}

export function filesUnder(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string) => {
    for (const f of readdirSync(d).sort()) {
      const path = join(d, f)
      if (statSync(path).isDirectory()) walk(path)
      else out[relative(dir, path)] = readFileSync(path, 'utf8')
    }
  }
  walk(dir)
  return out
}

export type Environment = { kind: 'repository' | 'environments' | 'default'; files: Record<string, string> }

export function parseJsonc(text: string | undefined): Record<string, unknown> {
  if (text === undefined) return {}
  try {
    const value = Bun.JSONC.parse(text)
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export function inputPatterns(devcontainer: Record<string, unknown>): string[] {
  const inputs = (devcontainer.customizations as { nightshift?: { inputs?: unknown } } | undefined)
    ?.nightshift?.inputs
  return Array.isArray(inputs) ? inputs.filter((i): i is string => typeof i === 'string') : []
}

export async function inputFiles(tree: RepoTree, patterns: string[]): Promise<Record<string, string>> {
  const globs = patterns.map((p) => new Bun.Glob(p))
  const out: Record<string, string> = {}
  for (const path of (await tree.list()).filter((p) => globs.some((g) => g.match(p))).sort()) {
    const text = await tree.read(path)
    if (text !== undefined) out[path] = text
  }
  return out
}
