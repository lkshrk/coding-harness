// Generated from packages/core/schema/stack.schema.json by `bun run gen`; do not edit.
/**
 * features/stack-<id>/stack.yaml: how nightshift detects a stack and what the worker image gets from its Feature.
 */
export interface StackFile {
  /**
   * equals the directory suffix of features/stack-<id>
   */
  id: string
  /**
   * any matching marker selects the stack; matched at any depth outside node_modules, vendor, .git and third_party
   *
   * @minItems 1
   */
  markers: Marker[]
  /**
   * an add-on stack is selected only next to a detected primary stack and may omit lsp
   */
  addon: boolean
  /**
   * hashed for rebuilds, matched like file markers; file#key reads one JSON or TOML key (dotted path)
   */
  version_files: string[]
  /**
   * rendered into the worker's OpenCode config lsp section
   */
  lsp?: {
    [k: string]: Lsp
  }
  /**
   * defaults suggested for repositories; repositories.<name>.checks wins
   */
  checks: Check[]
  /**
   * hosts the stack needs for dependency install
   */
  egress: string[]
  /**
   * cache pinning baked into the image; must equal the Feature's containerEnv entries
   */
  env: {
    [k: string]: string
  }
  /**
   * true when the stack needs a sandbox driver with nested Docker
   */
  nested_docker: boolean
}
export interface Marker {
  /**
   * path suffix matched at a path-segment boundary
   */
  file?: string
  /**
   * glob over repository paths, e.g. ** /*.toc
   */
  glob?: string
  /**
   * regex (multiline) the content of a matched file must match; such files are hashed
   */
  contains?: string
  /**
   * markers that exclude the stack when any of them matches
   *
   * @minItems 1
   */
  not?: Marker[]
}
export interface Lsp {
  /**
   * explicit command installed by the Feature; no auto-download
   *
   * @minItems 1
   */
  command: string[]
  /**
   * @minItems 1
   */
  extensions: string[]
  initialization?: {
    [k: string]: unknown
  }
}
export interface Check {
  name: string
  run: string
}
