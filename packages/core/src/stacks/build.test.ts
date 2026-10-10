import { afterAll, describe, expect, test } from 'bun:test'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { NIGHTSHIFT_ROOT } from '../config/loader'
import type { Config } from '../config/schema'
import {
  DevcontainerEnvironmentBuilder,
  ImageBuildError,
  lspConfig,
  playwrightVersion,
  pythonVersion,
  type Run,
  UnknownRepositoryError,
  workerImageFor,
} from './build'
import { memoryTree } from './detect'
import { loadStacks, type Stack } from './load'

const tmp = mkdtempSync(join(tmpdir(), 'ns-build-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const bareRoot = join(tmp, 'root')
mkdirSync(bareRoot)
symlinkSync(join(NIGHTSHIFT_ROOT, 'features'), join(bareRoot, 'features'))

const routivo = {
  'frontend/package.json': '{"packageManager":"pnpm@11.8.0"}',
  'frontend/pnpm-lock.yaml': 'lockfileVersion: 9\n',
  'backend/pyproject.toml': '[project]\nrequires-python = ">=3.14"\n',
  'backend/uv.lock': 'version = 1\n',
  '.nvmrc': '24\n',
  'README.md': '',
}

type Call = { cmd: string[]; devcontainer?: string }

function fake(
  files: Record<string, string>,
  opts: { fail?: boolean; images?: string[]; delayMs?: number } = {},
) {
  const calls: Call[] = []
  const images = new Set(opts.images ?? [])
  const run: Run = async (cmd) => {
    const call: Call = { cmd }
    calls.push(call)
    if (cmd[0] === 'tar') {
      for (const [path, content] of Object.entries(files)) {
        const target = join(cmd[4] as string, path)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, content)
      }
    }
    if (cmd[1] === 'build') {
      if (opts.delayMs) await Bun.sleep(opts.delayMs)
      if (opts.fail) return { exitCode: 1, stdout: '', stderr: 'feature install failed' }
      const workspace = cmd[cmd.indexOf('--workspace-folder') + 1] as string
      call.devcontainer = readFileSync(join(workspace, '.devcontainer/devcontainer.json'), 'utf8')
      images.add(cmd[cmd.indexOf('--image-name') + 1] as string)
    }
    if (cmd[0] === 'docker' && cmd[2] === 'inspect') {
      const tag = cmd.at(-1) as string
      return images.has(tag)
        ? { exitCode: 0, stdout: `sha256:${tag.split(':')[1]}\n`, stderr: '' }
        : { exitCode: 1, stdout: '', stderr: 'no such image' }
    }
    if (cmd[0] === 'docker' && cmd[2] === 'ls') {
      const prefix = `${cmd.at(-1)}:`
      return { exitCode: 0, stdout: [...images].filter((i) => i.startsWith(prefix)).join('\n'), stderr: '' }
    }
    if (cmd[0] === 'docker' && cmd[2] === 'rm') images.delete(cmd[3] as string)
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  return { run, calls, images, builds: () => calls.filter((c) => c.cmd[1] === 'build') }
}

let n = 0
function setup(
  files: Record<string, string>,
  opts: Parameters<typeof fake>[1] & { root?: string; repositories?: Record<string, unknown> } = {},
) {
  const tree = { files: { ...files } }
  const f = fake(tree.files, opts)
  const cache = join(tmp, `cache-${n++}`)
  const config = {
    paths: { cache, state: cache, vault: cache },
    repositories: {
      routivo: { path: '/src/routivo', remote: 'origin', base: 'main', stacks: 'auto', checks: [] },
      ...opts.repositories,
    },
  } as unknown as Config
  const builder = new DevcontainerEnvironmentBuilder({
    config: () => config,
    root: opts.root ?? bareRoot,
    run: f.run,
    tree: () => memoryTree(tree.files),
    devcontainer: ['devcontainer'],
    now: () => new Date('2026-10-04T00:00:00Z'),
  })
  return { ...f, builder, tree, cache }
}

describe('DevcontainerEnvironmentBuilder', () => {
  test('builds from git archive with the detected stacks and the agent layer last', async () => {
    const s = setup(routivo)
    const image = await s.builder.build('routivo')
    expect(image.tag).toMatch(/^nightshift\/env-routivo:[0-9a-f]{12}$/)
    expect(image.stacks).toEqual(['node', 'python'])
    expect(s.calls[0]?.cmd.slice(0, 5)).toEqual(['git', '-C', '/src/routivo', 'archive', '--format=tar'])
    expect(s.calls[0]?.cmd.at(-1)).toBe('origin/main')
    const build = s.builds()[0] as Call
    expect(build.cmd.slice(0, 2)).toEqual(['devcontainer', 'build'])
    expect(build.cmd[build.cmd.indexOf('--image-name') + 1]).toBe(image.tag)
    expect(build.cmd[build.cmd.indexOf('--workspace-folder') + 1]).toEndWith('/workspace')
    const features = JSON.parse(build.cmd[build.cmd.indexOf('--additional-features') + 1] as string)
    expect(Object.keys(features)).toEqual([
      './.nightshift/mise',
      './.nightshift/stack-node',
      './.nightshift/stack-python',
      './.nightshift/agent-layer',
    ])
    expect(features['./.nightshift/stack-node']).toEqual({ packageManagers: 'pnpm@11.8.0' })
    expect(features['./.nightshift/stack-python']).toEqual({ pythonVersion: '>=3.14' })
    const devcontainer = JSON.parse(build.devcontainer as string)
    expect(devcontainer.image).toStartWith('debian:trixie@sha256:')
    expect(devcontainer.overrideFeatureInstallOrder).toEqual([
      './.nightshift/mise',
      'ghcr.io/devcontainers/features/common-utils',
      'ghcr.io/devcontainers/features/node',
      './.nightshift/stack-node',
      './.nightshift/stack-python',
    ])
    const meta = JSON.parse(readFileSync(join(s.cache, 'images/routivo.json'), 'utf8'))
    expect(meta).toMatchObject({
      repo: 'routivo',
      tag: image.tag,
      imageId: `sha256:${image.hash.slice(0, 12)}`,
    })
  })

  test('uses the repository .devcontainer from the archive', async () => {
    const own = '{\n  // repository config\n  "image": "mcr.microsoft.com/devcontainers/base:trixie",\n}\n'
    const s = setup({ ...routivo, '.devcontainer/devcontainer.json': own })
    await s.builder.build('routivo')
    const used = JSON.parse(s.builds()[0]?.devcontainer as string)
    expect(used.image).toBe('mcr.microsoft.com/devcontainers/base:trixie')
    expect(used.overrideFeatureInstallOrder).toEqual([
      './.nightshift/mise',
      'ghcr.io/devcontainers/features/node',
      './.nightshift/stack-node',
      './.nightshift/stack-python',
    ])
  })

  test('environments/<repo> with a warm step is used and its declared inputs are hashed', async () => {
    const files = {
      ...routivo,
      'frontend/pnpm-workspace.yaml': 'allowBuilds:\n  esbuild: true\n',
      'frontend/patches/a.patch': 'diff\n',
      'frontend/project.inlang/settings.json': '{"modules":[]}',
      'frontend/src/app.ts': 'export {}\n',
      'backend/app/main.py': 'app = 1\n',
      'backend/tests/test_main.py': 'def test_x():\n    pass\n',
    }
    const s = setup(files, { root: NIGHTSHIFT_ROOT })
    const first = await s.builder.build('routivo')
    const build = s.builds()[0] as Call
    const devcontainer = JSON.parse(build.devcontainer as string)
    expect(devcontainer.build).toEqual({ dockerfile: 'Dockerfile', context: '..' })
    expect(devcontainer.overrideFeatureInstallOrder.at(-1)).toBe('./.nightshift/stack-python')

    s.tree.files['frontend/src/app.ts'] = 'export const x = 1\n'
    s.tree.files['backend/app/main.py'] = 'app = 2\n'
    s.tree.files['backend/tests/test_main.py'] = 'def test_y():\n    pass\n'
    s.tree.files['README.md'] = 'changed'
    expect(await s.builder.current('routivo')).toEqual(first)
    for (const [path, content] of [
      ['backend/uv.lock', 'version = 1\nrevision = 3\n'],
      ['backend/pyproject.toml', '[project]\nrequires-python = ">=3.14"\ndependencies = ["x"]\n'],
      ['frontend/pnpm-lock.yaml', 'lockfileVersion: 9\npackages: {}\n'],
      ['frontend/pnpm-workspace.yaml', 'allowBuilds:\n  esbuild: false\n'],
      ['frontend/patches/a.patch', 'diff2\n'],
      ['frontend/project.inlang/settings.json', '{"modules":["https://example.org/p.js"]}'],
    ] as const) {
      const before = (await s.builder.plan('routivo')).hash
      s.tree.files[path] = content
      expect((await s.builder.plan('routivo')).hash, path).not.toBe(before)
    }
    expect(await s.builder.current('routivo')).toBeUndefined()
  })

  test('environments/nightshift-vault adds bun and obsidian-wiki without detected stacks', async () => {
    const vault = { path: '/src/vault', remote: 'origin', base: 'main', stacks: ['bun'], checks: [] }
    const s = setup(
      { 'AGENTS.md': '', 'scripts/lint.ts': '' },
      { root: NIGHTSHIFT_ROOT, repositories: { 'nightshift-vault': vault } },
    )
    const image = await s.builder.build('nightshift-vault')
    expect(image.tag).toMatch(/^nightshift\/env-nightshift-vault:[0-9a-f]{12}$/)
    expect(image.stacks).toEqual(['bun'])
    const build = s.builds()[0] as Call
    const features = JSON.parse(build.cmd[build.cmd.indexOf('--additional-features') + 1] as string)
    expect(Object.keys(features)).toEqual([
      './.nightshift/mise',
      './.nightshift/stack-bun',
      './.nightshift/agent-layer',
    ])
    const devcontainer = JSON.parse(build.devcontainer as string)
    expect(devcontainer.build).toEqual({ dockerfile: 'Dockerfile' })
    expect(devcontainer.overrideFeatureInstallOrder).toEqual([
      './.nightshift/mise',
      'ghcr.io/devcontainers/features/common-utils',
      'ghcr.io/devcontainers/features/node',
      './.nightshift/stack-bun',
    ])
    const dockerfile = readFileSync(join(NIGHTSHIFT_ROOT, 'environments/nightshift-vault/Dockerfile'), 'utf8')
    expect(dockerfile).toContain('OBSIDIAN_WIKI_VERSION=2026.10.1')
    expect(dockerfile).toContain('uv tool install')
    expect(dockerfile).toContain('ENV PATH=/opt/nightshift/tools/bin:$PATH')

    s.tree.files['scripts/lint.ts'] = 'changed\n'
    s.tree.files['AGENTS.md'] = 'changed\n'
    expect(await s.builder.current('nightshift-vault')).toEqual(image)
  })

  test('the default environment hashes no workspace inputs beyond the stacks', async () => {
    const s = setup({ ...routivo, 'frontend/pnpm-workspace.yaml': 'a: 1\n' })
    const before = (await s.builder.plan('routivo')).hash
    s.tree.files['frontend/pnpm-workspace.yaml'] = 'a: 2\n'
    expect((await s.builder.plan('routivo')).hash).toBe(before)
  })

  test('reuses the image until a version file changes', async () => {
    const s = setup(routivo)
    expect(await s.builder.current('routivo')).toBeUndefined()
    const first = await s.builder.ensure('routivo')
    expect(await s.builder.current('routivo')).toEqual(first)
    await s.builder.ensure('routivo')
    s.tree.files['README.md'] = 'changed'
    await s.builder.ensure('routivo')
    expect(s.builds()).toHaveLength(1)
    s.tree.files['.nvmrc'] = '24.2\n'
    expect(await s.builder.current('routivo')).toBeUndefined()
    const second = await s.builder.ensure('routivo')
    expect(second.tag).not.toBe(first.tag)
    expect(s.builds()).toHaveLength(2)
  })

  test('a missing image is rebuilt even with matching metadata', async () => {
    const s = setup(routivo)
    const image = await s.builder.build('routivo')
    s.images.delete(image.tag)
    expect(await s.builder.current('routivo')).toBeUndefined()
  })

  test('concurrent dispatches wait on one build', async () => {
    const s = setup(routivo, { delayMs: 20 })
    const [a, b] = await Promise.all([s.builder.ensure('routivo'), s.builder.ensure('routivo')])
    expect(a).toEqual(b)
    expect(s.builds()).toHaveLength(1)
  })

  test('keeps the current and previous image', async () => {
    const s = setup(routivo, { images: ['nightshift/env-routivo:old000000001', 'nightshift/other:x'] })
    const first = await s.builder.build('routivo')
    s.tree.files['.nvmrc'] = '25\n'
    const second = await s.builder.build('routivo')
    s.tree.files['.nvmrc'] = '26\n'
    const third = await s.builder.build('routivo')
    expect([...s.images].sort()).toEqual([second.tag, third.tag, 'nightshift/other:x'].sort())
    expect(s.images.has(first.tag)).toBe(false)
  })

  test('unknown repository', async () => {
    const s = setup(routivo)
    await expect(s.builder.build('nope')).rejects.toThrow(new UnknownRepositoryError('nope'))
  })

  test('a failed build names the repository', async () => {
    const s = setup(routivo, { fail: true })
    const err = await s.builder.build('routivo').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ImageBuildError)
    expect((err as Error).message).toStartWith('image build failed for routivo')
    expect(existsSync(join(s.cache, 'images/routivo.json'))).toBe(false)
  })

  test('workerImageFor returns the tag with the merged lsp entries', async () => {
    const s = setup(routivo)
    const worker = await workerImageFor(s.builder, 'routivo')
    expect(worker.image).toMatch(/^nightshift\/env-routivo:/)
    expect(Object.keys(worker.lsp).sort()).toEqual(['eslint', 'python', 'ruff', 'typescript'])
    expect(worker.lsp.python?.command).toEqual(['ty', 'server'])
    expect(worker.egress).toEqual(['files.pythonhosted.org', 'pypi.org', 'registry.npmjs.org'])
  })
})

describe('WoW stack', () => {
  const addon = { 'BattleBuddy.toc': '## Interface: 120100\nCore.lua\n', 'Core.lua': 'return 1\n' }

  test('builds the offline WoW feature and exposes its configured language server', async () => {
    const s = setup(addon)
    const worker = await workerImageFor(s.builder, 'routivo')
    const build = s.builds()[0] as Call
    const features = JSON.parse(build.cmd[build.cmd.indexOf('--additional-features') + 1] as string)
    expect(features).toEqual({
      './.nightshift/mise': {},
      './.nightshift/stack-wow': {},
      './.nightshift/agent-layer': {},
    })
    expect(JSON.parse(build.devcontainer as string).overrideFeatureInstallOrder).toEqual([
      './.nightshift/mise',
      'ghcr.io/devcontainers/features/common-utils',
      './.nightshift/stack-wow',
    ])
    expect(worker.lsp).toEqual({
      lua: {
        command: ['lua-language-server', '--configpath=/var/cache/nightshift/wow/luarc.json'],
        extensions: ['.lua'],
      },
    })
    expect(worker.egress).toEqual([])
  })

  test('reuses the image for Lua edits and invalidates it for Interface changes', async () => {
    const s = setup(addon)
    const image = await s.builder.build('routivo')
    expect(image.stacks).toEqual(['wow'])
    s.tree.files['Core.lua'] = 'return 2\n'
    expect(await s.builder.current('routivo')).toEqual(image)
    s.tree.files['BattleBuddy.toc'] = '## Interface: 120101\nCore.lua\n'
    expect(await s.builder.current('routivo')).toBeUndefined()
    expect((await s.builder.plan('routivo')).tag).not.toBe(image.tag)
  })

  test.each(['stack-wow/install.sh', 'stack-wow/wow-tools.py', 'stack-wow/mise.lock', 'mise/tools.sh'])(
    'invalidates the image when %s changes',
    async (file) => {
      const root = mkdtempSync(join(tmp, 'wow-root-'))
      mkdirSync(join(root, 'features'))
      for (const feature of ['mise', 'stack-wow', 'agent-layer']) {
        cpSync(join(NIGHTSHIFT_ROOT, 'features', feature), join(root, 'features', feature), {
          recursive: true,
        })
      }
      const s = setup(addon, { root })
      const image = await s.builder.build('routivo')
      const path = join(root, 'features', file)
      writeFileSync(path, `${readFileSync(path, 'utf8')}\n# changed cached tooling\n`)
      expect(await s.builder.current('routivo')).toBeUndefined()
      expect((await s.builder.plan('routivo')).tag).not.toBe(image.tag)
    },
  )
})

describe('browser stack', () => {
  const lock = (v: string) =>
    `lockfileVersion: '9.0'\npackages:\n\n  playwright-core@${v}:\n    resolution: {integrity: x}\n\n  playwright@${v}:\n    dependencies:\n      playwright-core: ${v}\n`
  const frontend = (v: string) => ({
    'frontend/package.json': '{"packageManager":"pnpm@11.8.0","devDependencies":{"playwright":"1"}}',
    'frontend/pnpm-lock.yaml': lock(v),
  })

  test('installs the lockfile Playwright version next to node', async () => {
    const s = setup(frontend('1.60.0'))
    const image = await s.builder.build('routivo')
    expect(image.stacks).toEqual(['browser', 'node'])
    const build = s.builds()[0] as Call
    const features = JSON.parse(build.cmd[build.cmd.indexOf('--additional-features') + 1] as string)
    expect(features['./.nightshift/stack-browser']).toEqual({ playwrightVersion: '1.60.0' })
  })

  test('bumping Playwright in the lockfile changes the image tag', async () => {
    const s = setup(frontend('1.60.0'))
    const before = (await s.builder.plan('routivo')).tag
    Object.assign(s.tree.files, frontend('1.61.0'))
    expect((await s.builder.plan('routivo')).tag).not.toBe(before)
  })

  test('framework without Playwright leaves the version to the stack pin', async () => {
    const s = setup({
      'package.json': '{"dependencies":{"vite":"8"}}',
      'package-lock.json': '{"packages":{}}',
    })
    await s.builder.build('routivo')
    const build = s.builds()[0] as Call
    const features = JSON.parse(build.cmd[build.cmd.indexOf('--additional-features') + 1] as string)
    expect(features['./.nightshift/stack-browser']).toEqual({ playwrightVersion: '' })
  })

  test.each<[string, Record<string, string>, string]>([
    ['pnpm', { 'pnpm-lock.yaml': "  '/playwright-core@1.59.1':\n" }, '1.59.1'],
    [
      'npm',
      { 'package-lock.json': '{"packages":{"node_modules/playwright-core":{"version":"1.60.0"}}}' },
      '1.60.0',
    ],
    ['yarn', { 'yarn.lock': '"playwright-core@npm:1.60.0":\n  version: 1.60.0\n' }, '1.60.0'],
    ['bun', { 'bun.lock': '"playwright-core": ["playwright-core@1.62.0-alpha-1", ""]' }, '1.62.0-alpha-1'],
    [
      'highest of several, node_modules ignored',
      {
        'a/pnpm-lock.yaml': '  playwright-core@1.58.0:\n',
        'b/pnpm-lock.yaml': '  playwright-core@1.60.0:\n',
        'node_modules/x/pnpm-lock.yaml': '  playwright-core@9.9.9:\n',
      },
      '1.60.0',
    ],
    ['none', { 'package-lock.json': '{}' }, ''],
  ])('playwrightVersion reads %s lockfiles', async (_name, files, expected) => {
    expect(await playwrightVersion(memoryTree(files))).toBe(expected)
  })
})

describe('python stack', () => {
  const python = loadStacks(join(NIGHTSHIFT_ROOT, 'features')).stacks.get('python') as Stack

  test.each<[string, Record<string, string>, string]>([
    ['requires-python', { 'backend/pyproject.toml': '[project]\nrequires-python = ">=3.14"\n' }, '>=3.14'],
    [
      '.python-version wins over requires-python',
      { 'pyproject.toml': '[project]\nrequires-python = ">=3.12"\n', '.python-version': '# pin\n3.13\n' },
      '3.13',
    ],
    [
      'the shallowest project wins',
      {
        'pyproject.toml': '[project]\nrequires-python = ">=3.13"\n',
        'tools/x/pyproject.toml': '[project]\nrequires-python = ">=3.11"\n',
      },
      '>=3.13',
    ],
    ['none', { 'uv.lock': 'version = 1\n', 'pyproject.toml': '[tool.ruff]\n' }, ''],
  ])('pythonVersion reads %s', async (_name, files, expected) => {
    expect(await pythonVersion(memoryTree(files), python)).toBe(expected)
  })
})

describe('lspConfig', () => {
  test('merges entries of all stacks', () => {
    const { stacks } = loadStacks(join(NIGHTSHIFT_ROOT, 'features'))
    const lsp = lspConfig([stacks.get('node'), stacks.get('bun')] as Stack[])
    expect(Object.keys(lsp).sort()).toEqual(['biome', 'eslint', 'typescript'])
    expect(lsp.typescript?.command).toEqual(['typescript-language-server', '--stdio'])
    const extensions = lsp.typescript?.extensions ?? []
    expect(new Set(extensions).size).toBe(extensions.length)
  })
})
