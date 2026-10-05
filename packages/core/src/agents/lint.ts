import type { AgentDef, AgentError, AgentKind } from './types'

const SECTIONS: Record<AgentKind, string[]> = {
  interactive: ['Rules'],
  worker: ['Rules', 'Inputs', 'Procedure', 'Escalate', 'Output'],
  single_call: ['Rules', 'Inputs', 'Procedure', 'Output'],
}

const EMPHASIS = new Set([
  'MUST',
  'NEVER',
  'ALWAYS',
  'CRITICAL',
  'IMPORTANT',
  'NOT',
  'ONLY',
  'DO',
  "DON'T",
  'SHOULD',
  'REQUIRED',
  'WARNING',
])

type Section = { title: string; lines: string[] }

function stripCode(body: string): string {
  return body.replace(/^```[\s\S]*?^```[^\n]*$/gm, '').replace(/`[^`\n]*`/g, '')
}

function sections(prose: string): Section[] {
  const out: Section[] = []
  for (const line of prose.split(/\r?\n/)) {
    const heading = /^## +(.+?)\s*$/.exec(line)
    if (heading?.[1]) out.push({ title: heading[1], lines: [] })
    else out.at(-1)?.lines.push(line)
  }
  return out
}

export function lintAgent(def: AgentDef): AgentError[] {
  const messages: string[] = []
  const prose = stripCode(def.body)

  const first =
    def.body
      .split(/\r?\n/)
      .find((l) => l.trim() !== '')
      ?.trim() ?? ''
  if (first === '' || first.startsWith('#')) messages.push("first line must state the agent's function")
  else if (/^you are\b/i.test(first)) messages.push("first line starts with 'You are'")

  const found = sections(prose)
  const titles = found.map((s) => s.title)
  const required = SECTIONS[def.kind]
  let previous: string | undefined
  for (const title of required) {
    const at = titles.indexOf(title)
    if (at === -1) {
      messages.push(`missing section '## ${title}'`)
      continue
    }
    if (previous !== undefined && at < titles.indexOf(previous)) {
      messages.push(`'## ${previous}' must come before '## ${title}'`)
    }
    previous = title
  }
  if (required.includes('Output') && titles.includes('Output') && titles.at(-1) !== 'Output') {
    messages.push("'## Output' must be the last section")
  }

  const rules = found.find((s) => s.title === 'Rules')
  if (rules) {
    const count = rules.lines.filter((l) => /^ ?(?:[-*]|\d+\.) /.test(l)).length
    if (count < 3 || count > 7) messages.push(`'## Rules' has ${count} rules, expected 3–7`)
  }
  const procedure = found.find((s) => s.title === 'Procedure')
  if (procedure) {
    const count = procedure.lines.filter((l) => /^ ?\d+\. /.test(l)).length
    if (count > 6) messages.push(`'## Procedure' has ${count} steps, max 6`)
  }

  const words = def.body.split(/\s+/).filter(Boolean).length
  if (words > def.budget.promptWords)
    messages.push(`body has ${words} words, budget ${def.budget.promptWords}`)

  const emphasis = (prose.match(/\b[A-Z][A-Z']*[A-Z]\b/g) ?? []).filter((w) => EMPHASIS.has(w))
  if (emphasis.length > 2) messages.push(`${emphasis.length} all-caps emphasis words, max 2`)

  return messages.map((message) => ({ file: def.file, path: 'body', message }))
}
