import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import YAML from 'yaml'
import type { ConfigError } from './errors'
import { applyEnvOverrides, isMap, type Layer, mergeLayers } from './merge'
import type { Config } from './schema'
import { type Catalog, isGitRepo, readCatalog } from './semantic'
import { validateConfig } from './validate'

export type LoadResult =
  | { ok: true; config: Config; sources: string[] }
  | { ok: false; errors: ConfigError[] }

export type LoadConfigOptions = {
  defaults?: string | undefined
  user?: string | undefined
  env?: Record<string, string | undefined> | undefined
  catalog?: Catalog | undefined
  isGitRepo?: ((path: string) => boolean) | undefined
}

export const NIGHTSHIFT_ROOT = join(import.meta.dir, '../../../..')

export const DEFAULTS_PATH = join(NIGHTSHIFT_ROOT, 'config/defaults.yaml')

function homeOf(env: Record<string, string | undefined>): string {
  return env.HOME ?? ''
}

export function userConfigPath(env: Record<string, string | undefined>): string {
  return join(env.XDG_CONFIG_HOME || join(homeOf(env), '.config'), 'nightshift/config.yaml')
}

function tildify(path: string, home: string): string {
  return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

function readLayer(file: string): { layer: Layer } | { error: ConfigError } {
  if (!existsSync(file)) return { error: { path: file, message: 'file not found' } }
  let data: unknown
  try {
    data = YAML.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    return { error: { path: file, message: `invalid YAML: ${(e as Error).message}` } }
  }
  if (data === null || data === undefined) return { layer: {} }
  return isMap(data) ? { layer: data } : { error: { path: file, message: 'must be a YAML mapping' } }
}

function profileFiles(defaultsFile: string): string[] {
  const dir = join(dirname(defaultsFile), 'profiles')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((f) => join(dir, f))
}

export function loadConfig(opts: LoadConfigOptions = {}): LoadResult {
  const env = opts.env ?? process.env
  const home = homeOf(env)
  const defaultsFile = opts.defaults ?? DEFAULTS_PATH
  const userFile = opts.user ?? userConfigPath(env)

  if (!existsSync(userFile)) {
    return {
      ok: false,
      errors: [
        {
          path: 'paths',
          message: `user config not found at ${tildify(userFile, home)}`,
          hint: 'run nightshift init to create it',
        },
      ],
    }
  }

  const errors: ConfigError[] = []
  const sources: string[] = []
  let merged: Layer = {}
  const add = (file: string, wrap: (layer: Layer) => Layer = (l) => l) => {
    const res = readLayer(file)
    if ('error' in res) errors.push(res.error)
    else merged = mergeLayers(merged, wrap(res.layer))
    sources.push(file)
  }

  add(defaultsFile)
  for (const file of profileFiles(defaultsFile)) {
    add(file, (profile) => ({ profiles: { [basename(file, '.yaml')]: profile } }))
  }
  add(userFile)
  if (errors.length) return { ok: false, errors }

  const overridden = applyEnvOverrides(merged, env)
  const res = validateConfig(overridden.config, {
    catalog: opts.catalog ?? readCatalog(NIGHTSHIFT_ROOT),
    isGitRepo: opts.isGitRepo ?? isGitRepo,
    home,
  })
  if (!res.ok) return res
  return { ok: true, config: res.config, sources: [...sources, ...overridden.applied] }
}
