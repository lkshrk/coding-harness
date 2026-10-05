import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import type { Config } from '../config/generated/config'
import { expandHome } from '../config/semantic'
import { environmentHash, gitTree, matchesFile, type RepoTree, selectStacks, versionValues } from './detect'
import { featureDigest, type LspEntry, loadStacks, type Stack } from './load'

export type RepoImage = {
  repo: string
  tag: string
  hash: string
  imageId: string
  stacks: string[]
  builtAt: string
}

export interface EnvironmentBuilder {
  current(repo: string): Promise<RepoImage | undefined>
  build(repo: string, opts?: { log?: (line: string) => void }): Promise<RepoImage>
}

export type RunResult = { exitCode: number; stdout: string; stderr: string }
export type Run = (cmd: string[], opts?: { onLine?: (line: string) => void }) => Promise<RunResult>

export class UnknownRepositoryError extends Error {
  constructor(readonly repo: string) {
    super(`unknown repository '${repo}'`)
  }
}

export class ImageBuildError extends Error {
  constructor(
    readonly repo: string,
    readonly detail: string,
  ) {
    super(`image build failed for ${repo}: ${detail}`)
  }
}

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

const FEATURES_DIR = '.nightshift'
const PACKAGE_MANAGERS_OPTION = 'packageManagers'
const PLAYWRIGHT_VERSION_OPTION = 'playwrightVersion'
const PYTHON_VERSION_OPTION = 'pythonVersion'

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

function filesUnder(dir: string): Record<string, string> {
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

type Environment = { kind: 'repository' | 'environments' | 'default'; files: Record<string, string> }

function parseJsonc(text: string | undefined): Record<string, unknown> {
  if (text === undefined) return {}
  try {
    const value = Bun.JSONC.parse(text)
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function inputPatterns(devcontainer: Record<string, unknown>): string[] {
  const inputs = (devcontainer.customizations as { nightshift?: { inputs?: unknown } } | undefined)
    ?.nightshift?.inputs
  return Array.isArray(inputs) ? inputs.filter((i): i is string => typeof i === 'string') : []
}

async function inputFiles(tree: RepoTree, patterns: string[]): Promise<Record<string, string>> {
  const globs = patterns.map((p) => new Bun.Glob(p))
  const out: Record<string, string> = {}
  for (const path of (await tree.list()).filter((p) => globs.some((g) => g.match(p))).sort()) {
    const text = await tree.read(path)
    if (text !== undefined) out[path] = text
  }
  return out
}

export type Plan = {
  repo: string
  checkout: string
  ref: string
  tree: RepoTree
  stacks: Stack[]
  hash: string
  tag: string
  environment: Environment
}

type Metadata = RepoImage & { previous?: string }

export type DevcontainerBuilderOptions = {
  config: () => Config
  root: string
  home?: string
  run?: Run
  tree?: (checkout: string, ref: string) => RepoTree
  devcontainer?: string[]
  now?: () => Date
}

export class DevcontainerEnvironmentBuilder implements EnvironmentBuilder {
  private readonly run: Run
  private readonly inflight = new Map<string, Promise<RepoImage>>()

  constructor(private readonly o: DevcontainerBuilderOptions) {
    this.run = o.run ?? spawnRun
  }

  private get home(): string {
    return this.o.home ?? homedir()
  }

  stacks(): Map<string, Stack> {
    const { stacks, errors } = loadStacks(join(this.o.root, 'features'))
    if (errors.length > 0) throw new Error(errors.join('\n'))
    return stacks
  }

  private environment(repo: string, paths: string[]): Environment {
    if (paths.some((p) => p.startsWith('.devcontainer/'))) return { kind: 'repository', files: {} }
    const dir = join(this.o.root, 'environments', repo)
    if (existsSync(dir)) return { kind: 'environments', files: filesUnder(dir) }
    return { kind: 'default', files: { 'devcontainer.json': JSON.stringify(DEFAULT_DEVCONTAINER) } }
  }

  async plan(repo: string): Promise<Plan> {
    const config = this.o.config()
    const r = Object.hasOwn(config.repositories, repo) ? config.repositories[repo] : undefined
    if (!r) throw new UnknownRepositoryError(repo)
    const checkout = expandHome(r.path, this.home)
    const ref = `${r.remote}/${r.base}`
    const tree = (this.o.tree ?? gitTree)(checkout, ref)
    const all = this.stacks()
    const ids = await selectStacks(repo, r, tree, all)
    const stacks = ids.map((id) => all.get(id) as Stack)
    const environment = this.environment(repo, await tree.list())
    const devcontainer = parseJsonc(
      environment.kind === 'repository'
        ? await tree.read('.devcontainer/devcontainer.json')
        : environment.files['devcontainer.json'],
    )
    const agentLayer = join(this.o.root, 'features', 'agent-layer')
    const version = JSON.parse(readFileSync(join(agentLayer, 'devcontainer-feature.json'), 'utf8')).version
    const hash = await environmentHash(tree, stacks, {
      agentLayerVersion: `${version}+${featureDigest(agentLayer)}`,
      environmentFiles: environment.files,
      inputFiles: {
        ...(await inputFiles(tree, inputPatterns(devcontainer))),
        ...(stacks.some((s) => s.id === 'browser')
          ? { 'playwright-version': await playwrightVersion(tree) }
          : {}),
      },
    })
    return {
      repo,
      checkout,
      ref,
      tree,
      stacks,
      hash,
      tag: `${imageRepository(repo)}:${hash.slice(0, 12)}`,
      environment,
    }
  }

  private metadataPath(repo: string): string {
    return join(expandHome(this.o.config().paths.cache, this.home), 'images', `${repo}.json`)
  }

  private readMetadata(repo: string): Metadata | undefined {
    try {
      return JSON.parse(readFileSync(this.metadataPath(repo), 'utf8')) as Metadata
    } catch {
      return undefined
    }
  }

  private async imageId(tag: string): Promise<string | undefined> {
    const res = await this.run(['docker', 'image', 'inspect', '--format', '{{.Id}}', tag])
    return res.exitCode === 0 ? res.stdout.trim() : undefined
  }

  async current(repo: string): Promise<RepoImage | undefined> {
    const plan = await this.plan(repo)
    const meta = this.readMetadata(repo)
    if (!meta || meta.hash !== plan.hash || meta.tag !== plan.tag) return undefined
    if ((await this.imageId(plan.tag)) === undefined) return undefined
    const { previous: _, ...image } = meta
    return image
  }

  build(repo: string, opts: { log?: (line: string) => void } = {}): Promise<RepoImage> {
    return this.once(repo, () => this.buildNow(repo, opts))
  }

  ensure(repo: string, opts: { log?: (line: string) => void } = {}): Promise<RepoImage> {
    return this.once(repo, async () => (await this.current(repo)) ?? (await this.buildNow(repo, opts)))
  }

  private once(repo: string, fn: () => Promise<RepoImage>): Promise<RepoImage> {
    const running = this.inflight.get(repo)
    if (running) return running
    const p = fn().finally(() => this.inflight.delete(repo))
    this.inflight.set(repo, p)
    return p
  }

  private async packageManagers(tree: RepoTree): Promise<string> {
    const found = new Set<string>()
    for (const path of (await tree.list()).filter((p) => matchesFile(p, 'package.json'))) {
      if (path.split('/').includes('node_modules')) continue
      try {
        const pm = JSON.parse((await tree.read(path)) ?? '{}').packageManager
        if (typeof pm === 'string' && /^[a-z]+@\S+$/.test(pm)) found.add(pm)
      } catch {}
    }
    return [...found].sort().join(' ')
  }

  private async features(plan: Plan, devDir: string): Promise<Record<string, Record<string, unknown>>> {
    const out: Record<string, Record<string, unknown>> = {}
    for (const stack of plan.stacks) {
      const name = `stack-${stack.id}`
      cpSync(stack.featureDir, join(devDir, FEATURES_DIR, name), { recursive: true })
      const feature = JSON.parse(readFileSync(join(stack.featureDir, 'devcontainer-feature.json'), 'utf8'))
      const options: Record<string, unknown> = {}
      if (feature.options?.[PACKAGE_MANAGERS_OPTION])
        options[PACKAGE_MANAGERS_OPTION] = await this.packageManagers(plan.tree)
      if (feature.options?.[PLAYWRIGHT_VERSION_OPTION])
        options[PLAYWRIGHT_VERSION_OPTION] = await playwrightVersion(plan.tree)
      if (feature.options?.[PYTHON_VERSION_OPTION])
        options[PYTHON_VERSION_OPTION] = await pythonVersion(plan.tree, stack)
      out[`./${FEATURES_DIR}/${name}`] = options
    }
    cpSync(join(this.o.root, 'features', 'agent-layer'), join(devDir, FEATURES_DIR, 'agent-layer'), {
      recursive: true,
    })
    out[`./${FEATURES_DIR}/agent-layer`] = {}
    return out
  }

  // overrideFeatureInstallOrder installs listed Features first, so listing every other Feature puts the agent layer last.
  private orderAgentLayerLast(
    devDir: string,
    features: Record<string, Record<string, unknown>>,
    plan: Plan,
  ): void {
    const path = join(devDir, 'devcontainer.json')
    const config = Bun.JSONC.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const unversioned = (ref: string) => (ref.startsWith('.') ? ref : ref.replace(/[:@][^/]*$/, ''))
    const dependencies = plan.stacks.flatMap((stack) => {
      const feature = JSON.parse(readFileSync(join(stack.featureDir, 'devcontainer-feature.json'), 'utf8'))
      return Object.keys(feature.dependsOn ?? {})
    })
    const own = Object.keys((config.features as Record<string, unknown> | undefined) ?? {})
    const order = [
      ...((config.overrideFeatureInstallOrder as string[] | undefined) ?? []),
      ...[...own, ...dependencies].map(unversioned),
      ...Object.keys(features).filter((ref) => !ref.endsWith('/agent-layer')),
    ]
    config.overrideFeatureInstallOrder = [...new Set(order)]
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`)
  }

  private async must(cmd: string[], repo: string, onLine?: (line: string) => void): Promise<RunResult> {
    const res = await this.run(cmd, onLine ? { onLine } : {})
    if (res.exitCode !== 0) {
      const tail = `${res.stderr}\n${res.stdout}`.trim().split('\n').slice(-5).join('\n')
      throw new ImageBuildError(repo, `${cmd.slice(0, 2).join(' ')} exited ${res.exitCode}: ${tail}`)
    }
    return res
  }

  private prepareEnvironment(plan: Plan, workspace: string): string {
    const devDir = join(workspace, '.devcontainer')
    if (plan.environment.kind === 'repository') return devDir
    mkdirSync(devDir, { recursive: true })
    if (plan.environment.kind === 'environments')
      cpSync(join(this.o.root, 'environments', plan.repo), devDir, { recursive: true })
    if (!existsSync(join(devDir, 'devcontainer.json')))
      writeFileSync(join(devDir, 'devcontainer.json'), `${JSON.stringify(DEFAULT_DEVCONTAINER, null, 2)}\n`)
    return devDir
  }

  private async buildNow(repo: string, opts: { log?: (line: string) => void }): Promise<RepoImage> {
    const plan = await this.plan(repo)
    const log = opts.log ?? (() => {})
    const ctx = mkdtempSync(join(tmpdir(), 'nightshift-env-'))
    try {
      const workspace = join(ctx, 'workspace')
      mkdirSync(workspace)
      const archive = join(ctx, 'source.tar')
      await this.must(['git', '-C', plan.checkout, 'archive', '--format=tar', '-o', archive, plan.ref], repo)
      await this.must(['tar', '-xf', archive, '-C', workspace], repo)
      const devDir = this.prepareEnvironment(plan, workspace)
      const features = await this.features(plan, devDir)
      this.orderAgentLayerLast(devDir, features, plan)
      log(
        `building ${plan.tag} (${plan.environment.kind} environment; stacks ${plan.stacks.map((s) => s.id).join(', ')})`,
      )
      await this.must(
        [
          ...(this.o.devcontainer ?? [join(this.o.root, 'node_modules/.bin/devcontainer')]),
          'build',
          '--workspace-folder',
          workspace,
          '--image-name',
          plan.tag,
          '--label',
          `nightshift.repository=${repo}`,
          '--additional-features',
          JSON.stringify(features),
        ],
        repo,
        log,
      )
      const imageId = await this.imageId(plan.tag)
      if (!imageId) throw new ImageBuildError(repo, `${plan.tag} missing after build`)
      const previous = this.readMetadata(repo)
      const image: RepoImage = {
        repo,
        tag: plan.tag,
        hash: plan.hash,
        imageId,
        stacks: plan.stacks.map((s) => s.id),
        builtAt: (this.o.now ?? (() => new Date()))().toISOString(),
      }
      const keep = previous && previous.tag !== plan.tag ? previous.tag : previous?.previous
      mkdirSync(join(this.metadataPath(repo), '..'), { recursive: true })
      writeFileSync(
        this.metadataPath(repo),
        `${JSON.stringify({ ...image, ...(keep ? { previous: keep } : {}) }, null, 2)}\n`,
      )
      await this.prune(repo, [plan.tag, ...(keep ? [keep] : [])])
      return image
    } finally {
      rmSync(ctx, { recursive: true, force: true })
    }
  }

  private async prune(repo: string, keep: string[]): Promise<void> {
    const res = await this.run([
      'docker',
      'image',
      'ls',
      '--format',
      '{{.Repository}}:{{.Tag}}',
      imageRepository(repo),
    ])
    if (res.exitCode !== 0) return
    for (const tag of res.stdout.split('\n').map((l) => l.trim())) {
      // An image still used by a running sandbox fails to remove and is retried after the next build.
      if (tag && !tag.endsWith(':<none>') && !keep.includes(tag))
        await this.run(['docker', 'image', 'rm', tag])
    }
  }
}

export type WorkerImage = { image: string; lsp: Record<string, LspEntry>; egress: string[]; stacks: string[] }

export async function workerImageFor(
  builder: DevcontainerEnvironmentBuilder,
  repo: string,
  opts: { log?: (line: string) => void } = {},
): Promise<WorkerImage> {
  const image = await builder.ensure(repo, opts)
  const all = builder.stacks()
  const stacks = image.stacks.flatMap((id) => all.get(id) ?? [])
  return {
    image: image.tag,
    lsp: lspConfig(stacks),
    egress: [...new Set(stacks.flatMap((s) => s.egress))].sort(),
    stacks: image.stacks,
  }
}
