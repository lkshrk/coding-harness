import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  detectStacks,
  type EnvironmentExtra,
  environmentHash,
  gitTree,
  memoryTree,
  selectStacks,
} from './detect'
import { loadStacks, type Stack } from './load'

function fixture(name: string): Map<string, Stack> {
  const { stacks, errors } = loadStacks(join(import.meta.dir, 'fixtures', name))
  if (errors.length > 0) throw new Error(errors.join('\n'))
  return stacks
}

const all = fixture('all')
const real = loadStacks(join(import.meta.dir, '..', '..', '..', '..', 'features')).stacks
const noWow = fixture('no-wow')
const of = (...ids: string[]) => ids.map((id) => all.get(id) as Stack)
const extra = { agentLayerVersion: '0.1.0' }

describe('detectStacks', () => {
  test.each<[string, Record<string, string>, Map<string, Stack>, string[]]>([
    ['go.mod', { 'go.mod': 'module x\n' }, all, ['go']],
    [
      'pnpm frontend with a python backend',
      { 'package.json': '{}', 'pnpm-lock.yaml': '', 'api/pyproject.toml': '' },
      all,
      ['node', 'python'],
    ],
    ['bun.lock without an npm lock', { 'package.json': '{}', 'bun.lock': '' }, all, ['bun']],
    [
      'bun.lock with an npm lock',
      { 'package.json': '{}', 'bun.lock': '', 'package-lock.json': '' },
      all,
      ['bun', 'node'],
    ],
    ['WoW addon', { 'Addon.toc': '## Interface: 120000\n', 'core.lua': '' }, all, ['wow']],
    [
      'WoW markers exclude lua without the wow stack',
      { 'Addon.toc': '## Interface: 120000\n', 'core.lua': '' },
      noWow,
      [],
    ],
    ['lua without WoW markers', { 'Addon.toc': '## Title: x\n', 'init.lua': '' }, all, ['lua']],
    ['ignored directories', { 'node_modules/x/go.mod': '', 'vendor/y/pnpm-lock.yaml': '' }, all, []],
    ['nested marker', { 'services/api/go.mod': '' }, all, ['go']],
    ['no marker', { 'README.md': '' }, all, []],
  ])('%s', async (_name, files, stacks, expected) => {
    expect(await detectStacks(memoryTree(files), stacks)).toEqual(expected)
  })
})

describe('real WoW stack', () => {
  test.each<[string, Record<string, string>, string[]]>([
    ['12.1 addon', { 'BattleBuddy.toc': '## Interface: 120100\nCore.lua\n' }, ['wow']],
    [
      'nested addon with metadata before Interface',
      { 'addons/Buddy/Buddy.toc': '## Title: Buddy\r\n## Interface: 120100\r\n' },
      ['wow'],
    ],
    ['plain Lua', { 'Core.lua': 'return 1\n' }, []],
    ['TOC without Interface', { 'Buddy.toc': '## Title: Buddy\nCore.lua\n' }, []],
    ['Interface in a Lua comment', { 'Core.lua': '-- ## Interface: 120100\n' }, []],
    ['vendored addon', { 'vendor/Buddy/Buddy.toc': '## Interface: 120100\n' }, []],
    [
      'multiple addon TOCs select WoW once',
      {
        'Buddy/Buddy.toc': '## Interface: 120100\n',
        'Buddy_Options/Buddy_Options.toc': '## Interface: 120100\n',
      },
      ['wow'],
    ],
    ['addon with Bun tooling', { 'Buddy.toc': '## Interface: 120100\n', 'bun.lock': '' }, ['bun', 'wow']],
  ])('%s', async (_name, files, expected) => {
    expect(await detectStacks(memoryTree(files), real)).toEqual(expected)
  })
})

describe('browser add-on', () => {
  test.each<[string, Record<string, string>, string[]]>([
    [
      'playwright dependency',
      { 'package.json': '{"devDependencies":{"@playwright/test":"1.60.0"}}', 'package-lock.json': '{}' },
      ['browser', 'node'],
    ],
    [
      'framework only',
      { 'web/package.json': '{"dependencies":{"@sveltejs/kit":"^2"}}', 'web/pnpm-lock.yaml': '' },
      ['browser', 'node'],
    ],
    [
      'playwright only in the lockfile',
      { 'package.json': '{}', 'bun.lock': '"playwright-core@1.60.0": []' },
      ['browser', 'bun'],
    ],
    [
      'backend only',
      { 'package.json': '{"dependencies":{"express":"5"}}', 'package-lock.json': '{}' },
      ['node'],
    ],
    ['never alone', { 'package.json': '{"dependencies":{"vue":"3"}}' }, []],
  ])('%s', async (_name, files, expected) => {
    expect(await detectStacks(memoryTree(files), real)).toEqual(expected)
  })
})

describe('real python stack', () => {
  test.each<[string, Record<string, string>, string[]]>([
    ['uv.lock', { 'uv.lock': 'version = 1\n' }, ['python']],
    ['pyproject.toml', { 'pyproject.toml': '[project]\nname = "x"\n' }, ['python']],
    [
      'uv backend next to a pnpm frontend',
      {
        'frontend/package.json': '{}',
        'frontend/pnpm-lock.yaml': '',
        'backend/pyproject.toml': '[project]\n',
        'backend/uv.lock': 'version = 1\n',
      },
      ['node', 'python'],
    ],
    ['vendored pyproject', { 'vendor/x/pyproject.toml': '' }, []],
    ['plain Python sources', { 'main.py': 'print(1)\n', 'requirements.txt': 'x\n' }, []],
  ])('%s', async (_name, files, expected) => {
    expect(await detectStacks(memoryTree(files), real)).toEqual(expected)
  })

  const backend = {
    'backend/pyproject.toml': '[project]\nname = "routivo"\nrequires-python = ">=3.14"\n',
    'backend/uv.lock': 'version = 1\nrevision = 3\n',
    'backend/app/main.py': 'app = 1\n',
  }
  const python = [real.get('python') as Stack]
  const hashOf = (files: Record<string, string>) => environmentHash(memoryTree(files), python, extra)

  test('backend/uv.lock changes the environment hash', async () => {
    expect(await hashOf({ ...backend, 'backend/uv.lock': 'version = 1\nrevision = 4\n' })).not.toBe(
      await hashOf(backend),
    )
  })

  test.each<[string, Record<string, string>]>([
    ['requires-python', { 'backend/pyproject.toml': '[project]\nrequires-python = ">=3.15"\n' }],
    ['a new .python-version', { 'backend/.python-version': '3.14\n' }],
  ])('%s changes the environment hash', async (_name, change) => {
    expect(await hashOf({ ...backend, ...change })).not.toBe(await hashOf(backend))
  })

  test('backend source changes keep the environment hash', async () => {
    expect(
      await hashOf({ ...backend, 'backend/app/main.py': 'app = 2\n', 'backend/tests/test_x.py': '' }),
    ).toBe(await hashOf(backend))
  })
})

describe('selectStacks', () => {
  test('no marker names the repository setting', async () => {
    await expect(
      selectStacks('docs', { stacks: 'auto' }, memoryTree({ 'README.md': '' }), all),
    ).rejects.toThrow('no stack detected for docs; set repositories.docs.stacks')
  })

  test('explicit stacks skip detection', async () => {
    const tree = memoryTree({ 'go.mod': '' })
    expect(await selectStacks('x', { stacks: ['python'] }, tree, all)).toEqual(['python'])
  })

  test('macos_only repositories are never detected', async () => {
    await expect(
      selectStacks('app', { stacks: 'auto', macos_only: true }, memoryTree({}), all),
    ).rejects.toThrow('macos_only')
  })
})

describe('environmentHash', () => {
  const base = {
    'package.json': '{"packageManager":"pnpm@10.0.0","engines":{"node":">=24"},"scripts":{}}',
    'pnpm-lock.yaml': 'lockfileVersion: 9\n',
    '.nvmrc': '24\n',
    'src/index.ts': 'export {}\n',
  }
  const hashOf = (files: Record<string, string>, stacks = of('node'), x: EnvironmentExtra = extra) =>
    environmentHash(memoryTree(files), stacks, x)

  test('is stable and hex', async () => {
    expect(await hashOf(base)).toMatch(/^[0-9a-f]{64}$/)
    expect(await hashOf(base)).toBe(await hashOf({ ...base }))
  })

  test.each<[string, Record<string, string>]>([
    ['a source file', { 'src/index.ts': 'export const x = 1\n' }],
    [
      'a package.json field outside the version keys',
      { 'package.json': base['package.json'].replace('{}', '{"a":"b"}') },
    ],
  ])('ignores %s', async (_name, change) => {
    expect(await hashOf({ ...base, ...change })).toBe(await hashOf(base))
  })

  test.each<[string, Record<string, string>]>([
    ['.nvmrc', { '.nvmrc': '24.1\n' }],
    ['packageManager', { 'package.json': base['package.json'].replace('pnpm@10.0.0', 'pnpm@10.1.0') }],
    ['engines.node', { 'package.json': base['package.json'].replace('>=24', '>=24.2') }],
    ['the lockfile marker', { 'pnpm-lock.yaml': 'lockfileVersion: 9\nx: 1\n' }],
    ['a new .node-version', { '.node-version': '24\n' }],
    ['.devcontainer', { '.devcontainer/devcontainer.json': '{}' }],
  ])('changes with %s', async (_name, change) => {
    expect(await hashOf({ ...base, ...change })).not.toBe(await hashOf(base))
  })

  test('changes with the stack, agent layer and environment definition', async () => {
    const h = await hashOf(base)
    expect(await hashOf(base, of('node', 'python'))).not.toBe(h)
    expect(await hashOf(base, of('node'), { agentLayerVersion: '0.2.0' })).not.toBe(h)
    expect(
      await hashOf(base, of('node'), { ...extra, environmentFiles: { 'devcontainer.json': '{}' } }),
    ).not.toBe(h)
    const bumped = { ...(all.get('node') as Stack), version: '1.0.1' }
    expect(await hashOf(base, [bumped])).not.toBe(h)
  })

  test('content-free globs do not hash source files', async () => {
    const lua = { 'Addon.toc': '## Title: x\n', 'init.lua': 'return 1\n' }
    const h = await hashOf(lua, of('lua'))
    expect(await hashOf({ ...lua, 'init.lua': 'return 2\n' }, of('lua'))).toBe(h)
  })
})

describe('gitTree', () => {
  const repo = mkdtempSync(join(tmpdir(), 'ns-detect-'))
  afterAll(() => rmSync(repo, { recursive: true, force: true }))
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(['git', '-C', repo, ...args], { stderr: 'pipe' })
    if (r.exitCode !== 0) throw new Error(r.stderr.toString())
    return r.stdout.toString().trim()
  }

  test('reads <remote>/<base> and never the working tree', async () => {
    git('init', '--quiet', '--initial-branch=main')
    git('config', 'user.email', 't@example.com')
    git('config', 'user.name', 't')
    git('config', 'core.hooksPath', '/dev/null')
    git('config', 'commit.gpgsign', 'false')
    writeFileSync(join(repo, 'package.json'), '{"packageManager":"pnpm@10.0.0"}')
    writeFileSync(join(repo, 'pnpm-lock.yaml'), '')
    writeFileSync(join(repo, '.nvmrc'), '24\n')
    git('add', '.')
    git('commit', '--quiet', '-m', 'init')
    git('update-ref', 'refs/remotes/origin/main', 'HEAD')

    const tree = () => gitTree(repo, 'origin/main')
    expect(await detectStacks(tree(), all)).toEqual(['node'])
    const before = await environmentHash(tree(), of('node'), extra)

    writeFileSync(join(repo, '.nvmrc'), '25\n')
    writeFileSync(join(repo, 'go.mod'), 'module x\n')
    expect(await environmentHash(tree(), of('node'), extra)).toBe(before)
    expect(await detectStacks(tree(), all)).toEqual(['node'])

    git('commit', '--quiet', '-am', 'bump node')
    expect(await environmentHash(tree(), of('node'), extra)).toBe(before)

    git('update-ref', 'refs/remotes/origin/main', 'HEAD')
    expect(await environmentHash(tree(), of('node'), extra)).not.toBe(before)
    expect(await tree().read('missing')).toBeUndefined()
  })

  test('an unknown ref fails with the ref named', async () => {
    await expect(gitTree(repo, 'origin/nope').list()).rejects.toThrow('origin/nope')
  })
})
