# Agent config

The agent behaviour every Coder workspace runs: global rules, agents, commands,
plugins and skills. Infrastructure (installing OpenCode, tools, keys, MCP
servers) lives in [auto-code-env](https://github.com/lkshrk/auto-code-env)'s
`coder/modules/opencode`, which syncs this folder on every workspace start.

- `AGENTS.md`: global instructions for every session.
- `skills.json`: external skills, each pinned to a repository ref. Workspaces
  fetch them on start and cache them per ref; bump a ref to update a skill.
- `skills/`: skills maintained here.
- `opencode/agents/*.md`: agents (`model`, `permissions`, `mode` in front
  matter). Models are the LiteLLM aliases `gw/fast`, `gw/coding` and `gw/deep`,
  which the workspace template maps per owner.
- `opencode/commands/*.md`: slash commands.
- `opencode/plugins/*.ts`: OpenCode v2 plugins (default export `{ id, setup }`).

Edit here, not in a workspace: the checkout there is reset on every sync, and
changes reach a workspace on its next start.

## What is in it

Agents (besides OpenCode's `build`, `plan`, `general`, `explore`):
- `reviewer`: read-only review on `gw/deep`.
- `oracle`: read-only consultant for architecture, plan review and stuck bugs,
  on `gw/deep`.
- `scout`: read-only external research on `gw/fast`.

Read-only is enforced by permissions: edits are denied, shell is limited to an
allowlist, and redirects are denied. An agent's model applies when it runs as a
subagent; as a primary agent the session model wins.

Commands: `/intake`, `/refine`, `/ticket`, `/review-pr`, `/iterate`, `/close`
and `/status`. They are thin entry points into the linear-ai skills and the
reviewer.

Plugins:
- `rtk` rewrites shell commands through `rtk rewrite`.
- `linear-guard` lets Linear writes to team Forge (issue key `XXX`) through;
  writes to any other team ask for confirmation.

## Evaluation

The benchmark in this repository measures agent setups. Its experiment prompts
still live in `harnesses/opencode`. Changes to this folder should come with a
benchmark run once the benchmark can run the deployed config.
