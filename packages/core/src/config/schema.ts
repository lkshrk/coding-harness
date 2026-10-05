import { join } from 'node:path'
import { type JsonSchema, readSchema, SCHEMA_DIR } from '../json-schema'
import type { Config, OctoSts, Profile, Statuses } from './generated/config'

export type {
  Config,
  OctoSts as OctoStsConfig,
  Policy,
  Profile,
  Repository,
  SelectionRule,
} from './generated/config'

export type ConfigSection = keyof Config
export type LifecycleState = keyof Statuses
export type GitHubAccount = { token: string } | { octo_sts: OctoSts }

export const CONFIG_SCHEMA_PATH = join(SCHEMA_DIR, 'config.schema.json')
export const LAYER_SCHEMA_PATH = join(SCHEMA_DIR, 'config.layer.schema.json')

type Spec = {
  $id: string
  $defs: { statuses: { properties: Record<LifecycleState, unknown> } }
  properties: {
    profiles: { properties: Record<string, unknown> }
    sandbox: { properties: { image: { default: string } } }
  }
}

const config = readSchema(CONFIG_SCHEMA_PATH)
let layer: JsonSchema | undefined

export function configJsonSchema(): JsonSchema {
  return config
}

export function layerJsonSchema(): JsonSchema {
  layer ??= readSchema(LAYER_SCHEMA_PATH)
  return layer
}

const spec = config as unknown as Spec

export const SCHEMA_ID = spec.$id

export const LIFECYCLE_STATES = Object.keys(spec.$defs.statuses.properties) as readonly LifecycleState[]

export const PROFILE_SETTINGS: readonly string[] = Object.keys(spec.properties.profiles.properties)

export const DEFAULT_STATUSES: Readonly<Record<LifecycleState, string>> = {
  triage: 'Backlog',
  backlog: 'Backlog',
  ready: 'Todo',
  running: 'In Progress',
  review: 'In Review',
  blocked: 'Blocked',
  done: 'Done',
  canceled: 'Canceled',
}

export function profileEntries(profiles: Config['profiles']): [string, Profile][] {
  return Object.entries(profiles).filter(
    (entry): entry is [string, Profile] => !PROFILE_SETTINGS.includes(entry[0]),
  )
}

export function teamStatuses(config: Config, key: string): Record<LifecycleState, string> {
  const override = config.linear.teams.find((t) => t.key === key)?.statuses ?? {}
  return { ...DEFAULT_STATUSES, ...config.linear.statuses, ...override }
}

export function githubAccount(config: Config, repository: string): { name: string } & GitHubAccount {
  const accounts = config.github.accounts
  const name = config.repositories[repository]?.github ?? config.github.default ?? Object.keys(accounts)[0]
  const account = name === undefined ? undefined : accounts[name]
  if (name === undefined || !account) throw new Error(`no GitHub account for repository '${repository}'`)
  if (account.octo_sts) return { name, octo_sts: account.octo_sts }
  if (account.token === undefined) throw new Error(`github.accounts.${name}: no token or octo_sts`)
  return { name, token: account.token }
}
