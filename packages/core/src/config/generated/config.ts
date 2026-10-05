// Generated from packages/core/schema/config.schema.json by `bun run gen`; do not edit.
export type Url = string
/**
 * env:NAME, or rbw:[folder/]item[#field] read with secrets.rbw_profile
 */
export type SecretRef = string
export type Name = string
export type Id = string
/**
 * @minItems 1
 */
export type Ids = Id[]
export type Duration = string
export type Glob = string
export type TeamKey = string
export type OneOrManyIds = Id | Ids
export type FailureClass =
  | 'environment'
  | 'implementation_defect'
  | 'insufficient_context'
  | 'task_too_large'
  | 'missing_dependency'
  | 'architectural_conflict'
  | 'capability_limit'
  | 'unknown'
export type ModelAlias = string
export type TokenCount = string

/**
 * Validates the merged configuration (defaults < user < overrides).
 */
export interface Config {
  version: 1
  paths: {
    /**
     * SQLite event log and leases
     */
    state: string
    /**
     * code-graph indexes, image metadata
     */
    cache: string
    /**
     * knowledge vault checkout
     */
    vault: string
  }
  gateway: {
    /**
     * OpenAI-compatible LiteLLM endpoint
     */
    base_url: string
    /**
     * the supervisor's own key (reviewer, classifier, token counting); never given to workers
     */
    api_key: string
    /**
     * dedicated key handed to workers, restricted in LiteLLM to the worker models
     */
    worker_key: string
    /**
     * PEM bundle for a private CA in front of the gateway
     */
    ca_bundle?: string
    /**
     * OTLP traces endpoint reachable from sandboxes
     */
    otel_endpoint?: string
    phoenix_url?: Url
  }
  linear: {
    /**
     * 'app': nightshift's own OAuth application, client-credentials grant; 'api_key': tests and fallback
     */
    auth:
      | {
          mode: 'app'
          client_id: SecretRef
          client_secret: SecretRef
          /**
           * fixed set; requesting different scopes revokes all existing app tokens
           */
          scopes: string[]
        }
      | {
          mode: 'api_key'
          api_key: SecretRef
        }
    /**
     * which issues nightshift acts on; all teams are read
     */
    act_on: {
      /**
       * act on issues delegated or assigned to the nightshift app
       */
      delegated: boolean
      /**
       * act on issues carrying any of these labels
       */
      labels: Name[]
    }
    exclude_labels: Name[]
    statuses: Statuses
    /**
     * per-team status overrides
     */
    teams: {
      /**
       * team key as in issue identifiers
       */
      key: string
      statuses: Statuses
    }[]
  }
  github: {
    /**
     * account for every repository without its own `github`; required with several accounts
     */
    default?: string
    accounts: {
      [k: string]: GithubAccount
    }
  }
  repositories: {
    [k: string]: Repository
  }
  /**
   * @minItems 1
   */
  projects: Project[]
  pipelines: {
    [k: string]: Ids
  }
  stages: {
    intake?: {
      /**
       * false: the stage runs as a lead session with you
       */
      automatic: boolean
      human_checkpoint: 'none' | 'before' | 'after'
      duplicate: {
        judge: 'typed' | 'llm'
        threshold: number
        max_candidates: number
        closed_within_days: number
      }
    }
    closeout?: {
      /**
       * false: the stage runs as a lead session with you
       */
      automatic: boolean
      human_checkpoint: 'none' | 'before' | 'after'
      ingest: boolean
    }
    [k: string]:
      | Stage
      | {
          /**
           * false: the stage runs as a lead session with you
           */
          automatic: boolean
          human_checkpoint: 'none' | 'before' | 'after'
          duplicate: {
            judge: 'typed' | 'llm'
            threshold: number
            max_candidates: number
            closed_within_days: number
          }
        }
      | {
          /**
           * false: the stage runs as a lead session with you
           */
          automatic: boolean
          human_checkpoint: 'none' | 'before' | 'after'
          ingest: boolean
        }
      | undefined
  }
  /**
   * first rule whose 'when' matches wins
   *
   * @minItems 1
   */
  selection: SelectionRule[]
  profiles: {
    active: Id
    memory_budget_gb: number
    [k: string]: Profile | Id | number
  }
  limits: {
    concurrency: number
    worker: {
      wall_clock: Duration
      tokens: TokenCount
      steps: number
    }
    repair_rounds: number
    best_of: number
  }
  policies: Policy
  sandbox: {
    driver: 'docker' | 'sbx'
    resources: {
      cpus?: number
      memory?: string
    }
  }
  notifications: {
    macos: boolean
    ntfy: null | Url
    /**
     * Signal group for notifications and replies, via signal-cli-rest-api in json-rpc mode
     */
    signal?: {
      /**
       * signal-cli-rest-api base URL
       */
      url: string
      /**
       * env:NAME, or rbw:[folder/]item[#field] read with secrets.rbw_profile
       */
      api_key: string
      /**
       * group name, raw group id or group.<base64> id
       */
      group: string
      /**
       * Signal account uuid allowed to reply; unset uses the one paired with ns signal pair
       */
      user?: string
      /**
       * PEM bundle for a private CA in front of signal-cli-rest-api
       */
      ca_bundle?: string
    }
  }
  secrets: {
    /**
     * RBW_PROFILE for every rbw: reference; nightshift's own Vaultwarden account
     */
    rbw_profile: string
  }
  cli?: {
    /**
     * ssh host that read, watch and control commands run on (ssh -t <host> -- ns …); 'local' runs them here
     */
    host?: string
  }
}
/**
 * lifecycle state → status name; in linear.statuses for every team, in a team overriding linear.statuses
 */
export interface Statuses {
  triage?: Name
  backlog?: Name
  ready?: Name
  running?: Name
  review?: Name
  blocked?: Name
  done?: Name
  canceled?: Name
}
/**
 * exactly one of token, octo_sts
 */
export interface GithubAccount {
  /**
   * env:NAME, or rbw:[folder/]item[#field] read with secrets.rbw_profile
   */
  token?: string
  octo_sts?: OctoSts
}
/**
 * short-lived installation tokens from octo-sts
 */
export interface OctoSts {
  /**
   * octo-sts base URL; tokens come from <url>/sts/exchange per repository owner
   */
  url: string
  /**
   * Authentik token endpoint for the client-credentials grant
   */
  token_url: string
  /**
   * Authentik OAuth client whose tokens octo-sts accepts
   */
  client_id: string
  /**
   * Authentik machine identity; names <owner>/.github/.github/chainguard/<identity>.sts.yaml
   */
  identity: string
  /**
   * env:NAME, or rbw:[folder/]item[#field] read with secrets.rbw_profile
   */
  password: string
}
export interface Repository {
  /**
   * your checkout; nightshift only fetches here
   */
  path: string
  remote: string
  base: string
  stacks: 'auto' | Ids
  /**
   * run in a fresh sandbox, in order, stop at the first failure
   *
   * @minItems 1
   */
  checks: Check[]
  risk_paths: Glob[]
  macos_only: boolean
  /**
   * GitHub account for this repository instead of github.default
   */
  github?: string
}
export interface Check {
  name: Id
  run: string
  timeout: Duration
}
export interface Project {
  match:
    | {
        team: TeamKey
        initiative: Name
      }
    | {
        team: TeamKey
        project: Name
      }
    | {
        team: TeamKey
        label: Name
      }
  repositories: Ids
  pipeline: Id
  profile?: Id
}
export interface Stage {
  /**
   * false: the stage runs as a lead session with you
   */
  automatic: boolean
  human_checkpoint: 'none' | 'before' | 'after'
}
export interface SelectionRule {
  when: {
    stage?: OneOrManyIds
    issue_type?: OneOrManyIds
    failure_class?: FailureClass | FailureClass[]
    attempt?: string
  }
  agent: Id
}
export interface Profile {
  /**
   * role → gateway alias
   */
  roles: {
    [k: string]: ModelAlias
  }
  models: {
    [k: string]: Model
  }
}
export interface Model {
  /**
   * concrete model behind the alias
   */
  model: string
  family: Id
  size_gb: number
  /**
   * @minItems 1
   */
  phases: ('planning' | 'implementation')[]
}
export interface Policy {
  /**
   * OpenCode permission key → patterns denied in every agent; an agent allow never overrides them
   */
  deny: {
    /**
     * @minItems 1
     */
    [k: string]: Glob[]
  }
}
