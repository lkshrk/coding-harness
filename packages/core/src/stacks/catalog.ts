import type { Stack } from './load'

const PROBE = /^lsp_initialize\s+(.+)$/

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

function matches(command: string[], probe: string[]): boolean {
  return command[0] === probe[0] && command.length === probe.length
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
