import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '../config/generated/config'
import { expandHome } from '../config/semantic'
import { environmentHash, gitTree, type RepoTree, selectStacks } from './detect'
import { orderAgentLayerLast, prepareEnvironment, stackFeatures } from './devcontainer'
import {
  DEFAULT_DEVCONTAINER,
  type Environment,
  filesUnder,
  imageRepository,
  inputFiles,
  inputPatterns,
  lspConfig,
  type Plan,
  parseJsonc,
  playwrightVersion,
  type Run,
  type RunResult,
  spawnRun,
} from './inputs'
import { featureDigest, type LspEntry, loadStacks, type Stack } from './load'

export * from './inputs'

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

  private async must(cmd: string[], repo: string, onLine?: (line: string) => void): Promise<RunResult> {
    const res = await this.run(cmd, onLine ? { onLine } : {})
    if (res.exitCode !== 0) {
      const tail = `${res.stderr}\n${res.stdout}`.trim().split('\n').slice(-5).join('\n')
      throw new ImageBuildError(repo, `${cmd.slice(0, 2).join(' ')} exited ${res.exitCode}: ${tail}`)
    }
    return res
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
      const devDir = prepareEnvironment(this.o.root, plan, workspace)
      const features = await stackFeatures(this.o.root, plan, devDir)
      orderAgentLayerLast(devDir, features, plan)
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
