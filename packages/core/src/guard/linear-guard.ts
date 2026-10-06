import { validateIssue } from '../issues'

import { ParseError, tokenize, Unresolved, type Word } from './shell-tokens'

export type GuardDecision = { allow: true } | { allow: false; message: string }

export type GuardContext = { readFile(path: string): string; allowNoDesign?: boolean }

const ALLOW: GuardDecision = { allow: true }
const deny = (message: string): GuardDecision => ({ allow: false, message: `linear-guard: ${message}` })

const STATUS = 'status is set by the supervisor'
const STAGE = 'ai-stage labels are set by the supervisor'
const MERGE = 'merge mode is set by ns implement'
const DELETE = 'deleting is not allowed'
const INLINE = 'pass the description as a file'
const UNKNOWN = 'unknown write command'
const UNPARSEABLE = 'cannot parse the command; run the linear write on its own'
const CHDIR = 'use an absolute description file path after changing directory'

const WRITE_VERB =
  /\b(create|update|add|delete|remove|archive|unarchive|start|api|auth|edit|set|move|import|pull-request)\b/
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}', 'fi', 'done'])
const CHDIRS = new Set(['cd', 'pushd', 'popd'])
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])
const WRAPPERS = new Set([
  'rtk',
  'env',
  'sudo',
  'doas',
  'command',
  'exec',
  'time',
  'nohup',
  'nice',
  'timeout',
  'stdbuf',
  'xargs',
  'parallel',
  'watch',
])

const READS = new Set([
  'issue view',
  'issue list',
  'issue query',
  'issue url',
  'issue id',
  'issue title',
  'issue describe',
  'issue comment list',
  'issue relation list',
  'project list',
  'project view',
  'document list',
  'document view',
  'team list',
  'team states',
  'team members',
  'team id',
  'milestone list',
  'milestone view',
  'label list',
  'cycle list',
  'cycle view',
])
const WRITES = new Set([
  'issue create',
  'issue update',
  'issue comment add',
  'issue relation add',
  'project create',
  'project update',
  'document create',
  'document update',
])
const DELETE_VERBS = new Set(['delete', 'archive', 'unarchive', 'trash'])
const STATUS_FLAGS = ['--state', '-s', '--start', '--status']
const LABEL_FLAGS = ['--label', '-l', '--labels', '--add-label', '--remove-label']

type State = { ctx: GuardContext; moved: boolean }

const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1)

function hasFlag(args: readonly string[], names: readonly string[]): boolean {
  return args.some((a) => names.some((n) => a === n || a.startsWith(`${n}=`)))
}

function flagValues(args: readonly string[], names: readonly string[]): string[] {
  const out: string[] = []
  args.forEach((a, k) => {
    for (const n of names) {
      if (a === n && args[k + 1] !== undefined) out.push(args[k + 1] as string)
      else if (a.startsWith(`${n}=`)) out.push(a.slice(n.length + 1))
    }
  })
  return out
}

function checkDescription(file: string, issue: string, state: State): GuardDecision {
  const { ctx } = state
  if (state.moved && !file.startsWith('/') && !file.startsWith('~')) return deny(CHDIR)
  let text: string
  try {
    text = ctx.readFile(file)
  } catch {
    return deny(`cannot read ${file}`)
  }
  const result = validateIssue(text, ctx.allowNoDesign ? { allowNoDesign: true } : {})
  if (result.ok) return ALLOW
  return deny(`${issue}: ${result.errors.map((e) => e.message).join('; ')}`)
}

function isRead(args: readonly string[]): boolean {
  const pathEnd = args.findIndex((a) => a.startsWith('-'))
  const path = pathEnd < 0 ? args : args.slice(0, pathEnd)
  return READS.has(path.slice(0, 3).join(' ')) || READS.has(path.slice(0, 2).join(' '))
}

const WRAPPER_ARG_OPTIONS = new Set([
  '-u',
  '-g',
  '-C',
  '-S',
  '-p',
  '-U',
  '-n',
  '-o',
  '-I',
  '-L',
  '-P',
  '-d',
  '-E',
  '-j',
])

const unresolved = (w: Word | undefined) =>
  w !== undefined && (w.dynamic || (w.glob && !/^\[\[?$/.test(w.value)))

function executableIndex(words: readonly Word[], start: number): number {
  let k = start
  for (;;) {
    const w = words[k]
    if (!w || unresolved(w) || !WRAPPERS.has(basename(w.value))) return k
    k++
    for (;;) {
      const v = words[k]?.value ?? ''
      if (v === '--') {
        k++
        break
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(v) || /^\d+(\.\d+)?[smhd]?$/.test(v)) k++
      else if (v.length > 1 && v.startsWith('-')) {
        if (WRAPPER_ARG_OPTIONS.has(v)) {
          if (unresolved(words[k + 1])) return k + 1
          k += 2
        } else k++
      } else break
    }
  }
}

function checkLinear(args: readonly string[], state: State): GuardDecision {
  const pathEnd = args.findIndex((a) => a.startsWith('-'))
  const path = pathEnd < 0 ? [...args] : args.slice(0, pathEnd)
  if (path.length === 0) {
    return args.some((a) => WRITE_VERB.test(a)) ? deny(UNKNOWN) : ALLOW
  }
  if (path.slice(0, 3).some((p) => DELETE_VERBS.has(p))) return deny(DELETE)
  if (path[0] === 'issue' && path[1] === 'start') return deny(STATUS)
  const key3 = path.slice(0, 3).join(' ')
  const key2 = path.slice(0, 2).join(' ')
  const key = WRITES.has(key3) || READS.has(key3) ? key3 : key2
  if (READS.has(key)) return ALLOW
  if (!WRITES.has(key)) return deny(UNKNOWN)

  const rest = args.slice(key.split(' ').length)
  if (hasFlag(rest, STATUS_FLAGS)) return deny(STATUS)
  const labels = flagValues(rest, LABEL_FLAGS).flatMap((v) => v.split(','))
  if (labels.some((l) => /^\s*ai-stage/i.test(l))) return deny(STAGE)
  if (labels.some((l) => /^\s*ai-merge/i.test(l))) return deny(MERGE)

  if (key === 'issue create' || key === 'issue update') {
    if (hasFlag(rest, ['--description', '-d'])) return deny(INLINE)
    const [file] = flagValues(rest, ['--description-file'])
    if (file === undefined) return key === 'issue create' ? deny(INLINE) : ALLOW
    const issue = key === 'issue update' && rest[0] && !rest[0].startsWith('-') ? rest[0] : 'new issue'
    return checkDescription(file, issue, state)
  }
  if (key === 'issue relation add') {
    const [from, type, to] = rest
    if (from && to && /^blocks$|^blocked-by$/.test(type ?? '') && from.toUpperCase() === to.toUpperCase()) {
      return deny(`${from} cannot block itself`)
    }
  }
  return ALLOW
}

function checkSegment(words: readonly Word[], state: State): GuardDecision {
  const values = words.map((w) => w.value)
  let start = 0
  for (;;) {
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(values[start] ?? '')) start++
    if (!KEYWORDS.has(values[start] ?? '')) break
    start++
  }
  if (unresolved(words[executableIndex(words, start)])) throw new Unresolved('unresolved executable')
  const head = basename(values[start] ?? '')
  if (CHDIRS.has(head)) {
    state.moved = true
    return ALLOW
  }
  const wrapped = WRAPPERS.has(head)
  if (wrapped && values.slice(start + 1).some((v) => /^(-C|--chdir)/.test(v))) state.moved = true
  const candidates = wrapped
    ? values.flatMap((v, k) => (k > start && basename(v) === 'linear' ? [k] : []))
    : head === 'linear'
      ? [start]
      : []
  for (const k of candidates) {
    if (words.some((w) => w.dynamic)) throw new ParseError('dynamic arguments')
    const decision = checkLinear(values.slice(k + 1), state)
    if (!decision.allow) return decision
    const appended = values.slice(start, k).some((v) => v === 'xargs' || v === 'parallel')
    if (appended && !isRead(values.slice(k + 1))) throw new Unresolved('arguments from stdin')
  }
  if (head === 'eval') return guardSegments(values.slice(start + 1).join(' '), state)
  const shell = values.findIndex((v, k) => k >= start && SHELLS.has(basename(v)))
  if (shell >= 0) {
    const script = shellScript(values.slice(shell + 1))
    if (script !== undefined) return guardSegments(script, state)
    if (values.slice(shell + 1).some((v) => /\blinear\b/.test(v) && WRITE_VERB.test(v))) {
      throw new ParseError('shell script not inspectable')
    }
  }
  if (candidates.length === 0) {
    const hidden = values.findIndex((v, k) => k > start && basename(v) === 'linear')
    if (hidden >= 0 && values.slice(hidden + 1).some((v) => WRITE_VERB.test(v))) {
      throw new ParseError('linear in an unknown position')
    }
  }
  return ALLOW
}

const SHELL_ARG_OPTIONS = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file'])

function shellScript(args: readonly string[]): string | undefined {
  let command = false
  for (let k = 0; k < args.length; k++) {
    const a = args[k] as string
    if (a === '--' || a === '-') {
      return command ? args[k + 1] : undefined
    }
    if (SHELL_ARG_OPTIONS.has(a)) k++
    else if (a.startsWith('--')) continue
    else if (/^[-+][A-Za-z]+$/.test(a)) {
      if (a.startsWith('-') && a.includes('c')) command = true
      if (/[oO]$/.test(a)) k++
    } else return command ? a : undefined
  }
  return undefined
}

function guardSegments(command: string, state: State): GuardDecision {
  for (const segment of tokenize(command)) {
    const decision = checkSegment(segment, state)
    if (!decision.allow) return decision
  }
  return ALLOW
}

export function guardLinearCommand(command: string, ctx: GuardContext): GuardDecision {
  try {
    return guardSegments(command, { ctx, moved: false })
  } catch (e) {
    if (!(e instanceof ParseError)) throw e
    if (e instanceof Unresolved) return deny(UNPARSEABLE)
    const bare = command.replace(/\\(.)/g, '$1').replace(/["']/g, '')
    return /\blinear\b/.test(bare) && WRITE_VERB.test(bare) ? deny(UNPARSEABLE) : ALLOW
  }
}
