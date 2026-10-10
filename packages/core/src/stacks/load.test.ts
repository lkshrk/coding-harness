import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import YAML from 'yaml'
import { NIGHTSHIFT_ROOT } from '../config/loader'
import { loadStacks } from './load'

const tmp = mkdtempSync(join(tmpdir(), 'ns-stacks-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const valid = {
  id: 'demo',
  markers: [{ file: 'demo.lock' }, { glob: '**/*.toc', contains: '^## Interface', not: [{ file: 'x' }] }],
  version_files: ['package.json#packageManager'],
  lsp: { demo: { command: ['demo-ls', '--stdio'], extensions: ['.demo'] } },
  env: { DEMO_CACHE: '/var/cache/nightshift/demo' },
}

let n = 0
function load(stack: unknown, opts: { dir?: string; feature?: Record<string, unknown> } = {}) {
  const features = join(tmp, `case-${n++}`, 'features')
  const dir = join(features, opts.dir ?? 'stack-demo')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'stack.yaml'), typeof stack === 'string' ? stack : YAML.stringify(stack))
  const feature = opts.feature ?? {
    id: opts.dir ?? 'stack-demo',
    version: '0.1.0',
    containerEnv: { DEMO_CACHE: '/var/cache/nightshift/demo' },
  }
  writeFileSync(join(dir, 'devcontainer-feature.json'), JSON.stringify(feature))
  return loadStacks(features)
}

const without = (key: string) => Object.fromEntries(Object.entries(valid).filter(([k]) => k !== key))

describe('loadStacks', () => {
  test('a valid stack loads with defaults', () => {
    const { stacks, errors } = load(valid)
    expect(errors).toEqual([])
    const demo = stacks.get('demo')
    expect(demo?.checks).toEqual([])
    expect(demo?.egress).toEqual([])
    expect(demo?.nestedDocker).toBe(false)
    expect(demo?.versionFiles).toEqual(['package.json#packageManager'])
    expect(demo?.version).toBe('0.1.0')
    expect(demo?.digest).toMatch(/^[0-9a-f]{64}$/)
  })

  test.each([
    [
      'missing lsp',
      without('lsp'),
      {},
      'features/stack-demo/stack.yaml: lsp: at least one language server required',
    ],
    [
      'empty lsp',
      { ...valid, lsp: {} },
      {},
      'features/stack-demo/stack.yaml: lsp: at least one language server required',
    ],
    [
      'lsp entry without command',
      { ...valid, lsp: { demo: { extensions: ['.demo'] } } },
      {},
      'features/stack-demo/stack.yaml: lsp.demo.command: required',
    ],
    [
      'id differs from the directory',
      { ...valid, id: 'other' },
      {},
      "features/stack-demo/stack.yaml: id: must equal the directory suffix 'demo'",
    ],
    ['unknown key', { ...valid, extra: 1 }, {}, 'features/stack-demo/stack.yaml: extra: unknown key'],
    [
      'bad contains regex',
      { ...valid, markers: [{ glob: '*.x', contains: '([' }] },
      {},
      'features/stack-demo/stack.yaml: markers[0].contains: must match format "regex"',
    ],
    [
      'marker with file and glob',
      { ...valid, markers: [{ file: 'a', glob: 'b' }] },
      {},
      'features/stack-demo/stack.yaml: markers[0]: file and glob are exclusive',
    ],
    [
      'env not in containerEnv',
      valid,
      { feature: { id: 'stack-demo', version: '0.1.0' } },
      'features/stack-demo/stack.yaml: env.DEMO_CACHE: must equal containerEnv in devcontainer-feature.json',
    ],
    [
      'feature id mismatch',
      valid,
      { feature: { id: 'demo', version: '0.1.0', containerEnv: valid.env } },
      'features/stack-demo/devcontainer-feature.json: id: must be stack-demo',
    ],
  ])('%s', (_name, stack, opts, error) => {
    const { stacks, errors } = load(stack, opts)
    expect(errors).toContain(error)
    expect(stacks.size).toBe(0)
  })

  test('an add-on stack may omit lsp; a primary stack may not', () => {
    const addon = load({ ...without('lsp'), addon: true })
    expect(addon.errors).toEqual([])
    expect(addon.stacks.get('demo')).toMatchObject({ addon: true, lsp: {} })
    expect(load(valid).stacks.get('demo')?.addon).toBe(false)
  })

  test('invalid YAML names the file', () => {
    expect(load('id: [').errors[0]).toStartWith('features/stack-demo/stack.yaml: invalid YAML')
  })

  test('the stacks in features/ load clean', () => {
    const { stacks, errors } = loadStacks(join(NIGHTSHIFT_ROOT, 'features'))
    expect(errors).toEqual([])
    const bun = stacks.get('bun')
    expect(bun?.markers).toEqual([{ file: 'bun.lock' }, { file: 'bun.lockb' }])
    expect(bun?.lsp.typescript?.command).toEqual(['tsc', '--lsp', '--stdio'])
    expect(bun?.lsp.biome?.command).toEqual(['biome', 'lsp-proxy'])
    expect(bun?.checks.map((c) => c.run)).toEqual(['bun run lint', 'bun test'])
    expect(bun?.egress).toEqual(['registry.npmjs.org'])
    expect(bun?.featureDir).toBe(join(NIGHTSHIFT_ROOT, 'features/stack-bun'))
    const node = stacks.get('node')
    expect(node?.markers.map((m) => m.file)).toEqual(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'])
    expect(node?.lsp.eslint?.command).toEqual(['vscode-eslint-language-server', '--stdio'])
    expect(node?.versionFiles).toContain('package.json#engines.node')
    expect(node?.env.COREPACK_HOME).toBe('/var/cache/nightshift/corepack')
    expect(stacks.get('browser')).toMatchObject({ addon: true, lsp: {}, egress: [] })
    expect(stacks.get('browser')?.env.PLAYWRIGHT_BROWSERS_PATH).toBe('/var/cache/nightshift/ms-playwright')
    const wow = stacks.get('wow')
    expect(wow).toMatchObject({ addon: false, nestedDocker: false, egress: [] })
    expect(wow?.markers).toEqual([{ glob: '**/*.toc', contains: '^## Interface' }])
    expect(wow?.lsp.lua).toEqual({
      command: ['lua-language-server', '--configpath=/var/cache/nightshift/wow/luarc.json'],
      extensions: ['.lua'],
    })
    expect(wow?.checks).toEqual([{ name: 'lint', run: 'wow-check .' }])
    expect(wow?.versionFiles).toEqual([])
    expect(wow?.featureDir).toBe(join(NIGHTSHIFT_ROOT, 'features/stack-wow'))
    expect(wow?.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(wow?.env).toEqual({
      WOW_HOME: '/var/cache/nightshift/wow',
      WOW_CACHE: '/var/cache/nightshift/wow/cache',
      WOW_LUACHECKRC: '/var/cache/nightshift/wow/luacheckrc',
      WOW_INTERFACE: '120100',
    })
    const python = stacks.get('python')
    expect(python?.markers).toEqual([{ file: 'uv.lock' }, { file: 'pyproject.toml' }])
    expect(python?.versionFiles).toEqual(['.python-version', 'pyproject.toml#project.requires-python'])
    expect(python?.env.UV_CACHE_DIR).toBe('/var/cache/nightshift/uv')
    expect(python?.env.UV_PYTHON_INSTALL_DIR).toStartWith('/opt/nightshift/')
    expect(python?.checks.map((c) => c.name)).toEqual(['sync', 'lint', 'test'])
    expect([...stacks.keys()].sort()).toEqual(['browser', 'bun', 'node', 'python', 'wow'])
  })
})
