import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { matchesFile, type RepoTree } from './detect'
import {
  DEFAULT_DEVCONTAINER,
  FEATURES_DIR,
  PACKAGE_MANAGERS_OPTION,
  PLAYWRIGHT_VERSION_OPTION,
  type Plan,
  PYTHON_VERSION_OPTION,
  playwrightVersion,
  pythonVersion,
} from './inputs'

async function packageManagers(tree: RepoTree): Promise<string> {
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

export async function stackFeatures(
  root: string,
  plan: Plan,
  devDir: string,
): Promise<Record<string, Record<string, unknown>>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const stack of plan.stacks) {
    const name = `stack-${stack.id}`
    cpSync(stack.featureDir, join(devDir, FEATURES_DIR, name), { recursive: true })
    const feature = JSON.parse(readFileSync(join(stack.featureDir, 'devcontainer-feature.json'), 'utf8'))
    const options: Record<string, unknown> = {}
    if (feature.options?.[PACKAGE_MANAGERS_OPTION])
      options[PACKAGE_MANAGERS_OPTION] = await packageManagers(plan.tree)
    if (feature.options?.[PLAYWRIGHT_VERSION_OPTION])
      options[PLAYWRIGHT_VERSION_OPTION] = await playwrightVersion(plan.tree)
    if (feature.options?.[PYTHON_VERSION_OPTION])
      options[PYTHON_VERSION_OPTION] = await pythonVersion(plan.tree, stack)
    out[`./${FEATURES_DIR}/${name}`] = options
  }
  cpSync(join(root, 'features', 'agent-layer'), join(devDir, FEATURES_DIR, 'agent-layer'), {
    recursive: true,
  })
  out[`./${FEATURES_DIR}/agent-layer`] = {}
  return out
}

// overrideFeatureInstallOrder installs listed Features first, so listing every other Feature puts the agent layer last.
export function orderAgentLayerLast(
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

export function prepareEnvironment(root: string, plan: Plan, workspace: string): string {
  const devDir = join(workspace, '.devcontainer')
  if (plan.environment.kind === 'repository') return devDir
  mkdirSync(devDir, { recursive: true })
  if (plan.environment.kind === 'environments')
    cpSync(join(root, 'environments', plan.repo), devDir, { recursive: true })
  if (!existsSync(join(devDir, 'devcontainer.json')))
    writeFileSync(join(devDir, 'devcontainer.json'), `${JSON.stringify(DEFAULT_DEVCONTAINER, null, 2)}\n`)
  return devDir
}
