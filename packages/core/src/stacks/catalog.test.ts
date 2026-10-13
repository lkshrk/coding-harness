import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NIGHTSHIFT_ROOT } from '../config/loader'
import { lspProbeGaps, probeCommands } from './catalog'
import { loadStacks } from './load'

describe('probeCommands', () => {
  test('parses plain and multi-argument probes', () => {
    expect(probeCommands('lsp_initialize gopls\nlsp_initialize tsc --lsp --stdio\n')).toEqual([
      ['gopls'],
      ['tsc', '--lsp', '--stdio'],
    ])
  })

  test('strips surrounding quotes per token', () => {
    expect(probeCommands(`lsp_initialize "ty" 'server'`)).toEqual([['ty', 'server']])
    expect(probeCommands(`lsp_initialize lua-language-server --configpath="$WOW_HOME/luarc.json"`)).toEqual([
      ['lua-language-server', '--configpath="$WOW_HOME/luarc.json"'],
    ])
  })

  test('ignores other lines and the function definition', () => {
    const sh = [
      '#!/usr/bin/env bash',
      'lsp_initialize() {',
      '  local cmd=("$@")',
      '}',
      '  lsp_initialize indented',
      'echo lsp_initialize gopls',
      'lsp_initialize ruff server',
    ].join('\n')
    expect(probeCommands(sh)).toEqual([['ruff', 'server']])
  })
})

describe('lspProbeGaps', () => {
  const go = { id: 'go', addon: false, lsp: { go: { command: ['gopls'], extensions: ['.go'] } } }

  test('reports a declared server without a probe', () => {
    expect(lspProbeGaps(go, 'echo ok\n')).toEqual([
      "stack go: language server 'go' (gopls) has no lsp_initialize probe in test.sh",
    ])
  })

  test('reports a probe no lsp entry declares', () => {
    expect(lspProbeGaps(go, 'lsp_initialize gopls\nlsp_initialize biome lsp-proxy\n')).toEqual([
      "stack go: test.sh probes 'biome lsp-proxy' which no lsp entry declares",
    ])
  })

  test('requires the same argument count', () => {
    const ts = {
      id: 'bun',
      addon: false,
      lsp: { ts: { command: ['tsc', '--lsp', '--stdio'], extensions: [] } },
    }
    expect(lspProbeGaps(ts, 'lsp_initialize tsc --lsp\n')).toEqual([
      "stack bun: language server 'ts' (tsc --lsp --stdio) has no lsp_initialize probe in test.sh",
      "stack bun: test.sh probes 'tsc --lsp' which no lsp entry declares",
    ])
  })

  test('matches a variable-expanding quoted argument', () => {
    const wow = {
      id: 'wow',
      addon: false,
      lsp: { lua: { command: ['lua-language-server', '--configpath=/x/luarc.json'], extensions: ['.lua'] } },
    }
    expect(
      lspProbeGaps(wow, 'lsp_initialize lua-language-server --configpath="$WOW_HOME/luarc.json"\n'),
    ).toEqual([])
  })

  test('reports a missing test.sh for a primary stack', () => {
    expect(lspProbeGaps(go, undefined)).toEqual(['stack go: features/stack-go/test.sh missing'])
  })

  test('an add-on stack without lsp needs nothing', () => {
    expect(lspProbeGaps({ id: 'browser', addon: true, lsp: {} }, undefined)).toEqual([])
    expect(lspProbeGaps({ id: 'browser', addon: true, lsp: {} }, 'echo ok\n')).toEqual([])
  })

  test('every stack in features/ probes exactly its declared servers', () => {
    const { stacks, errors } = loadStacks(join(NIGHTSHIFT_ROOT, 'features'))
    expect(errors).toEqual([])
    expect(stacks.size).toBeGreaterThan(0)
    const gaps = [...stacks.values()].flatMap((stack) => {
      const path = join(stack.featureDir, 'test.sh')
      return lspProbeGaps(stack, existsSync(path) ? readFileSync(path, 'utf8') : undefined)
    })
    expect(gaps).toEqual([])
  })
})
