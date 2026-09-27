// Linear writes are "ask" in the config; this plugin lets writes to team Forge (key XXX) through without asking.
const FORGE_KEY = "XXX"
const FORGE_TEAM = new Set(["forge", "5e9aa168-5cfc-4d8e-a331-d291c979844a"])
const WRITES = ["linear-save_issue", "linear-save_comment"]

type Input = Record<string, unknown>

const isWrite = (name: string) => WRITES.some((tool) => name.endsWith(tool))

const forgeIdentifier = (value: unknown) =>
  typeof value === "string" && value.toUpperCase().startsWith(`${FORGE_KEY}-`)

const targetsForge = (name: string, input: Input) => {
  if (name.endsWith("linear-save_comment")) return !input.id && forgeIdentifier(input.issueId)
  if (input.id) return forgeIdentifier(input.id)
  return typeof input.team === "string" && FORGE_TEAM.has(input.team.toLowerCase())
}

export default {
  id: "linear-guard",
  setup(ctx: {
    tool: { hook: (name: "execute.before", callback: (event: { tool: string; id: string; input: unknown }) => void) => unknown }
    permission: {
      hook: (
        name: "evaluate",
        callback: (event: { action: string; effect: string; source?: { id: string } }) => void,
      ) => unknown
    }
  }) {
    // Code mode runs several MCP calls under one tool call id, so a single non-Forge write turns auto-allow off for that id.
    const calls = new Map<string, { forge: number; other: boolean }>()
    ctx.tool.hook("execute.before", (event) => {
      if (!isWrite(event.tool)) return
      const entry = calls.get(event.id) ?? { forge: 0, other: false }
      if (targetsForge(event.tool, (event.input ?? {}) as Input)) entry.forge += 1
      else entry.other = true
      calls.set(event.id, entry)
    })
    ctx.permission.hook("evaluate", (event) => {
      if (!isWrite(event.action) || event.effect !== "ask" || !event.source) return
      const entry = calls.get(event.source.id)
      if (!entry || entry.other || entry.forge === 0) return
      entry.forge -= 1
      event.effect = "allow"
    })
  },
}
