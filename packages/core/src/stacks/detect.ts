import { createHash } from 'node:crypto'
import type { Marker, Stack } from './load'

export type RepoTree = { list(): Promise<string[]>; read(path: string): Promise<string | undefined> }

const IGNORED = new Set(['node_modules', 'vendor', '.git', 'third_party'])

async function git(
  checkout: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['git', '-C', checkout, ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { ok: code === 0, stdout, stderr }
}

export function gitTree(checkout: string, ref: string): RepoTree {
  let paths: Promise<string[]> | undefined
  return {
    list() {
      paths ??= git(checkout, ['ls-tree', '-r', '-z', '--name-only', ref]).then((r) => {
        if (!r.ok) throw new Error(`git ls-tree ${ref} in ${checkout}: ${r.stderr.trim()}`)
        return r.stdout.split('\0').filter(Boolean)
      })
      return paths
    },
    async read(path) {
      const r = await git(checkout, ['show', `${ref}:${path}`])
      return r.ok ? r.stdout : undefined
    },
  }
}

export function memoryTree(files: Record<string, string>): RepoTree {
  return {
    list: async () => Object.keys(files),
    read: async (path) => files[path],
  }
}

function visible(path: string): boolean {
  return !path.split('/').some((segment) => IGNORED.has(segment))
}

export function matchesFile(path: string, file: string): boolean {
  return path === file || path.endsWith(`/${file}`)
}

function candidates(paths: string[], marker: Marker): string[] {
  if (marker.file !== undefined) {
    const file = marker.file
    return paths.filter((p) => matchesFile(p, file))
  }
  const glob = new Bun.Glob(marker.glob ?? '')
  return paths.filter((p) => glob.match(p))
}

async function matched(tree: RepoTree, paths: string[], marker: Marker): Promise<string[]> {
  const found = candidates(paths, marker)
  if (marker.contains === undefined) return found
  const pattern = new RegExp(marker.contains, 'm')
  const hits: string[] = []
  for (const path of found) if (pattern.test((await tree.read(path)) ?? '')) hits.push(path)
  return hits
}

async function markerMatches(tree: RepoTree, paths: string[], marker: Marker): Promise<boolean> {
  if ((await matched(tree, paths, marker)).length === 0) return false
  for (const excluded of marker.not ?? []) if (await markerMatches(tree, paths, excluded)) return false
  return true
}

async function visiblePaths(tree: RepoTree): Promise<string[]> {
  return (await tree.list()).filter(visible)
}

export async function detectStacks(tree: RepoTree, stacks: Map<string, Stack>): Promise<string[]> {
  const paths = await visiblePaths(tree)
  const found: string[] = []
  for (const stack of stacks.values()) {
    for (const marker of stack.markers) {
      if (await markerMatches(tree, paths, marker)) {
        found.push(stack.id)
        break
      }
    }
  }
  return found.some((id) => !stacks.get(id)?.addon) ? found.sort() : []
}

export type RepositoryStacks = { stacks: 'auto' | string[]; macos_only?: boolean }

export async function selectStacks(
  name: string,
  repo: RepositoryStacks,
  tree: RepoTree,
  stacks: Map<string, Stack>,
): Promise<string[]> {
  if (repo.macos_only) throw new Error(`repository '${name}' is macos_only; no image is built for it`)
  if (Array.isArray(repo.stacks)) {
    const unknown = repo.stacks.filter((s) => !stacks.has(s))
    if (unknown.length > 0) throw new Error(`unknown stack '${unknown[0]}' in repositories.${name}.stacks`)
    return [...repo.stacks].sort()
  }
  const detected = await detectStacks(tree, stacks)
  if (detected.length === 0) throw new Error(`no stack detected for ${name}; set repositories.${name}.stacks`)
  return detected
}

function lookup(value: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((node, k) => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return undefined
    return (node as Record<string, unknown>)[k]
  }, value)
}

function parse(path: string, text: string): unknown {
  try {
    if (path.endsWith('.toml')) return Bun.TOML.parse(text)
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export async function versionValues(
  tree: RepoTree,
  stacks: readonly Stack[],
  paths?: string[],
): Promise<Map<string, string>> {
  const all = paths ?? (await visiblePaths(tree))
  const out = new Map<string, string>()
  for (const stack of stacks) {
    for (const entry of stack.versionFiles) {
      const [file = entry, key] = entry.split('#')
      for (const path of all.filter((p) => matchesFile(p, file))) {
        const text = await tree.read(path)
        if (text === undefined) continue
        if (key === undefined) {
          out.set(path, text)
          continue
        }
        const value = lookup(parse(path, text), key)
        if (value !== undefined) out.set(`${path}#${key}`, JSON.stringify(value))
      }
    }
  }
  return out
}

async function hashedFiles(tree: RepoTree, stacks: readonly Stack[]): Promise<Map<string, string>> {
  const paths = await visiblePaths(tree)
  const out = await versionValues(tree, stacks, paths)
  for (const stack of stacks) {
    for (const marker of stack.markers) {
      // A content-free glob (e.g. **/*.lua) matches source files; hashing them would rebuild on every commit.
      if (marker.file === undefined && marker.contains === undefined) continue
      for (const path of await matched(tree, paths, marker)) {
        const text = await tree.read(path)
        if (text !== undefined) out.set(path, text)
      }
    }
  }
  for (const path of paths.filter((p) => p.startsWith('.devcontainer/'))) {
    const text = await tree.read(path)
    if (text !== undefined) out.set(path, text)
  }
  return out
}

export type EnvironmentExtra = {
  agentLayerVersion: string
  environmentFiles?: Record<string, string>
  inputFiles?: Record<string, string>
}

export async function environmentHash(
  tree: RepoTree,
  selected: Stack[],
  extra: EnvironmentExtra,
): Promise<string> {
  const stacks = [...selected].sort((a, b) => a.id.localeCompare(b.id))
  const entries = [...(await hashedFiles(tree, stacks))]
  for (const stack of stacks) entries.push([`stack:${stack.id}`, `${stack.version}+${stack.digest}`])
  entries.push(['agent-layer', extra.agentLayerVersion])
  for (const [path, content] of Object.entries(extra.environmentFiles ?? {}))
    entries.push([`environment:${path}`, content])
  for (const [path, content] of Object.entries(extra.inputFiles ?? {}))
    entries.push([`input:${path}`, content])
  const hash = createHash('sha256')
  for (const [key, value] of entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    hash.update(`${key}\0${value}\0`)
  }
  return hash.digest('hex')
}
