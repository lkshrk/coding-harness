export const WORKER_BLOCKS = [
  'ISSUE',
  'VERIFY',
  'DESIGN',
  'INTERFACES',
  'FILES',
  'KNOWLEDGE',
  'HISTORY',
] as const

export const SINGLE_CALL_BLOCKS = [
  'LENS',
  'DIFF',
  'TESTS',
  'GATES',
  'EVENT',
  'FINISH',
  'OUTLINES',
  'PAGES',
  'SIMILAR',
  'CANDIDATE',
  'CRITERIA',
  'ISSUES',
  'PROJECTS',
  'FAILURE',
] as const

export type WorkerBlock = (typeof WORKER_BLOCKS)[number]
export type BlockName = WorkerBlock | (typeof SINGLE_CALL_BLOCKS)[number]

export const BLOCK_NAMES: readonly BlockName[] = [...WORKER_BLOCKS, ...SINGLE_CALL_BLOCKS]

const FENCE_LINE = /^(\s*)(--- (?:BEGIN|END) [A-Z_]+ ---\s*)$/gm

export function fence(name: BlockName, body: string): string {
  const text = body.replace(/\s+$/, '').replace(FENCE_LINE, '$1 $2')
  return [`--- BEGIN ${name} ---`, ...(text === '' ? [] : [text]), `--- END ${name} ---`].join('\n')
}

export function inputBlocks(agentBody: string): string[] {
  const inputs = /^## Inputs\s*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(agentBody)?.[1] ?? ''
  return [...inputs.matchAll(/^- `([A-Z_]+)`:/gm)].map((m) => m[1] as string)
}
