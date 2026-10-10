import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NIGHTSHIFT_ROOT } from '../config/loader'
import { memoryTree } from './detect'
import { orderAgentLayerLast, stackFeatures } from './devcontainer'
import { DEFAULT_DEVCONTAINER, type Plan } from './inputs'
import { loadStacks, type Stack } from './load'

const tmp = mkdtempSync(join(tmpdir(), 'ns-devcontainer-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const { stacks } = loadStacks(join(NIGHTSHIFT_ROOT, 'features'))

test('the mise Feature is added and installed before every other nightshift Feature', async () => {
  const devDir = join(tmp, '.devcontainer')
  mkdirSync(devDir)
  writeFileSync(join(devDir, 'devcontainer.json'), JSON.stringify(DEFAULT_DEVCONTAINER))
  const plan = {
    tree: memoryTree({ 'package.json': '{}', 'bun.lock': '' }),
    stacks: [stacks.get('bun') as Stack],
  } as unknown as Plan
  const features = await stackFeatures(NIGHTSHIFT_ROOT, plan, devDir)
  expect(Object.keys(features)).toEqual([
    './.nightshift/mise',
    './.nightshift/stack-bun',
    './.nightshift/agent-layer',
  ])
  expect(existsSync(join(devDir, '.nightshift/mise/nightshift-mise-install'))).toBe(true)
  orderAgentLayerLast(devDir, features, plan)
  const config = JSON.parse(readFileSync(join(devDir, 'devcontainer.json'), 'utf8'))
  expect(config.overrideFeatureInstallOrder).toEqual([
    './.nightshift/mise',
    'ghcr.io/devcontainers/features/common-utils',
    'ghcr.io/devcontainers/features/node',
    './.nightshift/stack-bun',
  ])
})
