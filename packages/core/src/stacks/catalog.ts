import type { Stack } from './load'

const PROBE = /^\s*lsp_initialize\s+(.+)$/

function unquote(token: string): string {
  const q = token[0]
  return token.length >= 2 && (q === '"' || q === "'") && token.endsWith(q) ? token.slice(1, -1) : token
}

export function probeCommands(testSh: string): string[][] {
  return testSh.split('\n').flatMap((line) => {
    const m = PROBE.exec(line.trimEnd())
    return m?.[1] ? [m[1].trim().split(/\s+/).map(unquote)] : []
  })
}

const VARIABLE = /\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)/g

function argMatches(declared: string, probed: string): boolean {
  if (!probed.includes('$')) return declared === probed
  const literal = probed.replace(/["']/g, '')
  const pattern = literal
    .split(VARIABLE)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${pattern}$`).test(declared)
}

function matches(command: string[], probe: string[]): boolean {
  return (
    command[0] === probe[0] &&
    command.length === probe.length &&
    command.every((arg, i) => argMatches(arg, probe[i] ?? ''))
  )
}

export function lspProbeGaps(
  stack: Pick<Stack, 'id' | 'addon' | 'lsp'>,
  testSh: string | undefined,
): string[] {
  const entries = Object.entries(stack.lsp)
  if (testSh === undefined)
    return stack.addon && entries.length === 0
      ? []
      : [`stack ${stack.id}: features/stack-${stack.id}/test.sh missing`]
  const probes = probeCommands(testSh)
  const gaps: string[] = []
  for (const [name, { command }] of entries) {
    if (!probes.some((p) => matches(command, p)))
      gaps.push(
        `stack ${stack.id}: language server '${name}' (${command.join(' ')}) has no lsp_initialize probe in test.sh`,
      )
  }
  for (const probe of probes) {
    if (!entries.some(([, { command }]) => matches(command, probe)))
      gaps.push(`stack ${stack.id}: test.sh probes '${probe.join(' ')}' which no lsp entry declares`)
  }
  return gaps
}
