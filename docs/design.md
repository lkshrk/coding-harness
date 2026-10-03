# nightshift: research and proposed design

Status: proposal, 2026-10-03.

Decided: build the supervisor (TypeScript on Bun); OpenCode v2 for lead and workers; Docker Sandboxes
(Docker login/telemetry accepted); terminal-first lead; LiteLLM stays in h-cloud; no cloud-model
escalation for now; merge mode asked per implementation session; lead runs locally on the host; Linear's
own objects (initiatives, projects, milestones, relations, Triage) carry the plan; CLI or MCP chosen per
tool (§6); code graph indexed on the host and mounted read-only into sandboxes; knowledge vault in the
Karpathy LLM-wiki pattern via `obsidian-wiki`; repo-writing AI tools off; Phoenix in h-cloud; agents as
plain files improved by GEPA through reviewed PRs (§10); hardware M5 Ultra 256 GB / 4 TB; the whole
lifecycle runs as configurable stages (§5); teams, projects and pipelines are config, Forge is only the
default target. Not executed yet: the Forge migration (§5).

Replaces the earlier approach on `main` (benchmark harness, Coder workspaces, Kubernetes control plane),
which is outdated; nothing is ported from it. Every component here is designed from current research.

## 1. Summary

No existing project covers the required combination: Linear as durable truth, harness/model independence,
a real isolation boundary, deterministic supervision with LLM judgment only where needed, and a CLI/TUI
operator surface. Every candidate either brings its own task database (Gas City/Beads, AO, Vibe Kanban),
is tied to one harness (Symphony → Codex), isolates with worktrees only (dmux, claude-squad, AO), or is a
GUI product (Conductor, Sculptor).

A second sweep (GitHub search, awesome-agent-orchestrators, Linear integrations) found two near misses:
**Kandev** (polls Linear, ACP incl. OpenCode, Docker executor, but its own SQLite task model, web/desktop
UI, AGPL) and **Cyrus** (Linear Agent Sessions, OpenCode runner, but assignment-driven, worktree-only,
public webhook). Ideas to borrow: acpx as ACP transport, Scion's runtime interface (Apple Container),
Cyrus's Agent Session UX, Bernstein/Archon's deterministic pipeline nodes, agent-deck's TUI. Desktop ADEs
(Superset, Orca, emdash, …) and agent-company boards (Multica, Paperclip) replace Linear or need a GUI.

DeepSeek Harness (`deepseek-ai/deepseek-harness`) was re-checked: a strong plugin design (Cordis seams,
subagent providers incl. `acp`/`codex`/`claude-code`, Workflow, Agent Teams), but prerelease only
(0.2.0-rc.2, breaking changes announced), GitHub is a mirror with issues disabled, and its orchestration
is LLM-in-the-loop inside one session. Community orchestrators on it are toys, none Linear-integrated.
It stays a challenger in the eval matrix; re-check at a stable release.

The recommendation is therefore: **adopt mature components per layer and build one small piece — a
supervisor that follows Symphony's spec — plus the lead agent's prompts/skills.**

| Layer | Adopt | Build |
|---|---|---|
| Work/planning truth | Linear (projects, documents, issues, sub-issues, blocking relations) | issue template, Linear sync in supervisor |
| Lead / SDLC agent | OpenCode (interactive, terminal) with planning skills | prompts, skills, plan → Linear writer |
| Supervisor | design from Symphony `SPEC.md` + Gas City patrol ideas | small daemon: SQLite event log + reconcile loop |
| Worker harness | OpenCode v2 `serve`; each worker a top-level session, never an in-process subagent with a model override (#51268); ACP as the seam for others | driver per harness |
| Isolation | Docker Sandboxes (`sbx`) behind a driver interface; plain Docker kept for trusted runs | `SandboxDriver` |
| Environments | Dev Container / Dockerfile → OCI image per repo | none |
| Inference | oMLX (vllm-mlx fallback) on the Mac, behind the existing LiteLLM in the h-cloud cluster | none (gateway config) |
| Context | ripgrep, ast-grep, code graph (CodeGraphContext or codebase-memory), rtk; CLI or MCP per tool | context builder (deterministic + one LLM selection call) |
| Knowledge | vault in the Karpathy LLM-wiki pattern, own git repo, `obsidian-wiki` skills | schema extension, ingest/lint triggers |
| Verification | repo's own checks, semgrep/secret scan, one cross-family LLM reviewer | gate runner: per-repository check commands from config, run in a fresh sandbox, exit codes decide |
| Integration | merge mode per implementation session: manual PR, auto-merge, or feature branch (§3) | merge queue step in supervisor |
| Observability/eval | Phoenix (existing) | trace tags for future distillation |

## 2. Target shape

```
             you (terminal)
                 │  plan / discuss / "implement"
                 ▼
   ┌──────── lead agent (OpenCode, strong model) ─────────┐
   │ discovery · repo analysis · design options · ADRs     │
   │ decomposition → Linear project + design doc + issues  │
   └───────────────┬───────────────────────────────────────┘
                   │ Linear = durable plan & status
                   ▼
   supervisor daemon (deterministic, no LLM by default)
     poll/webhook Linear · ready-set from blocking graph · dispatch · watch
     events → SQLite log · stall/loop heuristics · gates · merge queue
     only "judgment events" → LLM call (classify failure, re-plan, ask user)
                   │
       ┌───────────┼────────────┐
       ▼           ▼            ▼
   sbx microVM  sbx microVM  sbx microVM     one per active issue
   shared clone of read-only .git, image from devcontainer, egress allowlist, no credentials
   worker harness (opencode serve / ACP agent) → LiteLLM (h-cloud) → oMLX (Mac)
                   │
                   ▼
   gates: build/lint/types/tests → scanners → fresh-context reviewer
                   │
                   ▼
   local merge queue → PR or feature branch (merge mode per session) → Linear status
```

CLI (`nightshift …`, alias `ns`): `status`, `tasks`, `workers`, `attach <issue>` (tmux into the sandbox / harness
TUI against the worker's `opencode serve`), `logs`, `send <issue> "<msg>"` (`prompt_async`), `pause`,
`resume`, `retry`, `stop`, `diff`, `tests`. The UX reference is dmux/claude-squad (tmux attach); the state
model reference is Symphony.

## 3. Work units

| Unit | Visible to | Rule |
|---|---|---|
| Initiative | human | product or topic area, long-lived (§5 Linear model) |
| Project | human | one feature: design Document, milestones, updates, project dependencies |
| Milestone | human | integration checkpoint inside a feature; acceptance per milestone |
| Linear issue | human | one coherent change = one worker = one branch; sized to the measured success horizon of the worker model |
| Blocking relation | human + supervisor | the dependency graph; ready = all blockers Done (merged) |
| Agent steps (localize, edit, test-fix) | traces only | commits / Phoenix spans, never Linear issues |
| Commit | git | worker's own granularity; squash on merge optional |
| PR | human | depends on the merge mode below |

Merge mode, asked when an implementation session starts and recorded on the feature:

| Mode | Issue result | Dependents | Human gate |
|---|---|---|---|
| `manual` | PR per issue, stacked on blockers' branches | rebased by supervisor when a parent merges | you merge each PR |
| `auto` | PR per issue | same | none; merges when gates and CI pass |
| `feature-branch` | gated commits land directly on `feature/<name>` via the local merge queue | branch from the updated feature branch | one PR feature → main at acceptance |

Parallelism only for issues with no blocking edge **and** disjoint expected file sets (declared in the
issue). Evidence: parallel agents writing one change make conflicting implicit decisions (Cognition);
multi-agent variants lost 39–70% on sequential tasks (Google/MIT 2512.08296); ~28% of simulated agent PRs
had textual conflicts (AgenticFlict 2604.03551).

Issue body template (machine-parsed sections, human-readable):

```
## Goal            ## Why             ## Design excerpt (link + section)
## Interfaces in   ## Interfaces out  ## Files (expected touch set)
## Constraints     ## Out of scope    ## Acceptance criteria
## Tests expected  ## Verify (exact commands)
```

## 4. Supervisor

Built, small, single process on the Mac, **TypeScript on Bun** (official `@linear/sdk`, OpenCode v2 SDK,
ACP SDK, code shared with OpenCode plugins, OpenTelemetry JS → Phoenix). Follows Symphony `SPEC.md` (poll → claim → dispatch with bounded
concurrency → retry queue with backoff → stall detection → cleanup on terminal state; restart recovers
from Linear + filesystem). Adds:

- **Event log** (SQLite): `WORKER_STARTED/PROGRESS/WAITING/QUESTION/FAILED/FINISHED`, `GATE_FAILED`,
  `PR_CREATED`, `CI_FAILED/PASSED`, `REVIEW_RECEIVED`, `DEPENDENCY_UNBLOCKED`. Linear holds durable work
  state; SQLite holds runtime state only and can be discarded.
- **Deterministic watchers:** harness event stream (OpenCode SSE / ACP), diff growth, repeated tool
  calls, zero tool calls (guard for OpenCode #51268), wall-clock and token budgets, CI via `gh`.
- **Judgment events only** invoke an LLM: failure classification, worker question, plan divergence,
  acceptance decision. Output is constrained JSON.

Failure handling (classification decides remediation, retries are never blind):

| Class | Signal | Action |
|---|---|---|
| environment/tooling | non-zero infra exit, 5xx/429, sandbox error | retry same model, counted separately; never advances escalation |
| implementation defect | gate fails, diff on-target | targeted repair with gate output, ≤2–3 rounds; then best-of-2–4 if tests can select |
| insufficient context | worker searched widely, asked, or touched unexpected files | context builder re-run with worker's findings; never best-of-n |
| task too large | budget exhausted with partial progress | back to lead: split issue in Linear |
| missing dependency | worker reports missing interface | create/link blocker issue, park task |
| architectural conflict | diff violates design / worker proposes design change | escalate to lead; lead asks user if design changes |
| capability limit | repeated defect after repair + best-of-n | user (cloud escalation off for now; optional later via LiteLLM) |

Each classified failure is recorded on the Linear issue (one comment) and in Phoenix, so issue sizing and
context rules are tuned from data.

## 5. Stages, lead agent and Linear workflow

### Stages

The system covers the whole lifecycle, not only implementation. A **stage** is configuration, not code:
name, entry condition, role (agent + model), inputs, outputs written to Linear, gate, and whether a human
checkpoint is required. Default pipeline:

| Stage | Role | Output | Human checkpoint |
|---|---|---|---|
| intake | intake agent (from `linear-create-issue` / `nontech-intake`) | clean issue, type, project | no |
| discovery | lead (`discover`) | requirements, open questions answered one at a time | yes, when ambiguous |
| design | lead (`design`: investigate → ≥2 alternatives → critique → synthesis) | Linear Document | yes, approval |
| decomposition | lead (`decompose`) | issues from the template, blocking relations, file sets | yes, plan review |
| implementation | workers (supervisor-dispatched) | branch / commits | merge mode asked when the session starts |
| verification | gates + cross-family reviewer | gate results, review | only on escalation |
| integration | supervisor merge queue | merged change | per merge mode |
| acceptance | lead against project acceptance criteria | verdict | yes |

Stages are added, removed or reordered per project in config (e.g. a `release` stage, or no design stage
for bug fixes). Every stage transition is deterministic; only the stage's role work calls an LLM.

### Lead agent

The lead is the agent you talk to ("add feature X to project Y, let's plan it"); it owns discovery,
design, decomposition, re-planning and acceptance. It runs **on the host**, not in a sandbox: it needs your
`~/Dev` checkouts, the code-graph index, the Linear CLI and an interactive TUI, and it does not change
code. Guardrails are OpenCode permissions: file edits denied, shell limited to a read-only allowlist
(`git log/show/diff`, `rg`, code-graph and `linear`/`gh` read commands), Linear writes through
`linear-guard`.

Harness: **OpenCode v2**, the better tool when not using Claude models (per-agent models, any
OpenAI-compatible endpoint, `serve` + SDK, TS plugins). Strongest local model (GLM-5.3-Flash when it fits,
see §9). Skills are written once as `SKILL.md`, which OpenCode, Claude Code and Codex all load; only thin
command/agent wrappers are harness-specific, so Claude Code stays usable without double maintenance.
Planning runs as several bounded calls, not one long session; local inference makes extra calls cheap and
focused contexts reduce context rot.

Linear Agents API (delegate an issue to the agent, `AgentSessionEvent` webhooks) is a later addition: it is
still Developer Preview and needs a public HTTPS endpoint (tunnel) or a polling fallback.

### Configuration, not constants

Nothing about teams, projects, repositories, statuses, labels, stages, models or merge modes is hard-coded.
One config (in this repository, next to the agents and skills) declares the targets: Linear workspace(s), teams
(Forge default, others such as Civora added by config), project → repository mapping, stage pipeline per
project, role → model mapping. Linear metadata (team keys, status IDs, label IDs) is discovered via API at
start; `nightshift doctor` creates missing statuses and label groups per configured team.
Non-development work (HR, legal, company tasks, e.g. the workspace label `business`) is out of scope:
the supervisor only reads managed projects and skips issues carrying a configured exclude label.

### Linear workflow (successor to `linear-ai` v1.6.3)

The current workflow (13 `linear-*` skills, 6 agents) gets the lifecycle right but makes an LLM do the
deterministic work (transitions, claims, rollups, queue order), keeps plans in marked comments without a
dependency graph, runs parallel lanes inside one issue, isolates with in-repo worktrees, and hard-codes
teams and keys (`HCL-`, Civora). Disposition:

| Keep | Improve | Replace | Drop |
|---|---|---|---|
| `linear-review` (ledger moved out of repos), `/iterate`, `linear-guard.ts`, ticket/blocking rules, magic words, `repo-reconcile` for migration | intake skills → intake stage, refine/questioner → `discover`/`design` (one question at a time, grill pass), status comments → supervisor events, doctor → `nightshift doctor`, reviewer agent → short cross-family checklist | claim lock → supervisor lease, plan comments → issue template, split/rollup → `decompose` + blocking relations, orchestrator/batch skills → supervisor, implementer → worker prompt + context package, 5-lens loop → one reviewer after gates, closer → supervisor on merge | dashboard block, `sp-*` labels (→ Phoenix tags), `llm-split`, `llm-pilot`, `in-use` |

### Linear model

Use Linear's own objects instead of encoding structure in comments or labels. Today Forge uses projects
as long-lived repository buckets with no initiatives, milestones or project labels; that is the main
thing to change.

| Linear object | Used for | Written by |
|---|---|---|
| Initiative | product/topic area (today's repo-bucket projects: Omni, h-cloud, Cluster, …); owner = you; initiative update summarises its projects | lead (create), supervisor (weekly update) |
| Project | one feature; status follows the stages (Backlog → Planned → In Progress → Completed); lead = you; target date optional | lead |
| Project Documents | design (approved option, alternatives, decisions), acceptance criteria; linked from issues | lead |
| Project milestones | integration checkpoints from `decompose` (e.g. "API ready", "UI wired"); milestone acceptance runs when its issues are Done | lead, supervisor |
| Project dependencies | cross-feature ordering (feature B blocked by feature A) | lead |
| Project updates (health) | on track / at risk / off track, posted by the supervisor at milestones and on failures that change the plan | supervisor |
| Project / issue templates | `Feature` project template (Documents, milestone skeleton); `Task`, `Bug`, `Finding` issue templates carrying the §3 sections | `nightshift doctor` |
| Issue | one worker unit, §3 template | lead |
| Sub-issues | a task split after `task too large` (children of the original), or grouped findings under one parent; not for agent-internal steps | lead |
| Relations | `blocks` = dispatch graph; `related` = cross-links (finding ↔ code area, issue ↔ prior incident); `duplicate` = intake dedup (merges attachments) | lead, intake |
| Triage | intake stage: everything from outside the pipeline (findings, Slack, your quick captures) lands in Triage; intake agent accepts, declines, marks duplicate, or routes | intake agent |
| Statuses | lifecycle you see (below); git automations move them on PR events | supervisor, GitHub integration |
| Labels | label groups `stage:`, `agent:`, `merge:`, `repo:`, plus Type and Component | supervisor, lead |
| Estimate | issue size set by `decompose`; compared with outcomes to calibrate issue sizing | lead |
| Priority | dispatch order within the ready set | lead, you |
| Assignee / delegate | you stay assignee; the agent app becomes delegate once the Linear Agents API is wired | supervisor |
| Comments | worker questions as threads mentioning you (your reply is routed back to the worker); one comment per classified failure, gate result, review verdict | supervisor |
| Attachments / links | PRs (auto-linked via branch name and magic words), Phoenix trace, `nightshift attach` command, knowledge-vault pages used | supervisor |
| Custom views | "Needs me" (Blocked + `agent:human`), "Running", "Ready", "Failed", per initiative | `nightshift doctor` |
| Recurring issues | repository audits (`linear-review`), vault lint, dependency upgrades enter the pipeline on a schedule | config |
| Releases | not on Basic; release stage records GitHub releases/tags as an issue link and comment instead | CI, supervisor |
| Reviews (Linear Diffs) | review agent PRs inside Linear; reviewer can post a risk score via a `linear:extension` PR comment | you, reviewer |

Not used: "on behalf of" agent attribution on PRs (conflicts with the no-AI-attribution rule); cycles
(single developer, the ready set already orders work).

Plan: the workspace is on **Basic** (5 teams). Available: projects, milestones, documents, updates,
project dependencies, initiatives, templates, triage (manual), label groups, custom views, recurring
issues, Diffs, API/webhooks, agent platform. Missing and replaced: triage rules and responsibility (the
intake agent routes), releases (GitHub releases linked from issues), sub-initiatives (flat initiatives),
team project labels (workspace project labels), Insights (Phoenix + `nightshift status`). `nightshift doctor` checks
the plan's features and the 5-team limit when targets are added.

State on issues:

- **Statuses** (mapped per team in config): Triage (intake), Backlog (discovery/design), Todo (ready),
  In Progress, In Review, **Blocked** (new; needs you or the lead), Done, Canceled, Duplicate.
- **`stage:`** (single-select) names the owning stage; **`agent:`** (single-select) the runtime sub-state:
  `running`, `gates`, `question`, `replan`, `failed`, `human` (agents keep out).
- **Merge mode** is asked when an implementation session starts and recorded as a `merge:` label on the
  project.

The supervisor picks up every issue in a managed project whose stage has an automatic role and whose entry
condition holds (for implementation: `blocks` relations all Done, `## Files` disjoint from running work).
Only the supervisor writes status, `stage:` and `agent:`; workers have no Linear write access; human
checkpoints appear as Blocked + `agent:human` with the question as a comment thread that mentions you.

Review findings (`linear-review`, scanners, recurring audits) enter **Triage**. The intake agent marks
duplicates, links `related` issues, and groups findings for the same area under one parent issue or into a
project when they amount to a feature. Fast path: a finding with a deterministic reproduction (failing
test, scanner hit) and single-file scope is accepted straight to Todo with `stage:implementation`.

### Forge migration

Status: planned and agreed, not executed. Nothing is changed in Linear until the supervisor and
`nightshift doctor --migrate` exist.

Today (2026-10-03): 10 Forge projects used as permanent repo/topic buckets, all in status Backlog; features
modelled as `EPIC`-labelled parent issues with two-level sub-issue trees (BattleBuddy `XXX-66`, ~25
children; Signal CLI `XXX-42`, ~23 children with mixed `llm-refine`/`llm-ready`/`llm-review`); a `Page`
label group used as a feature marker; no initiatives, milestones, Triage or Blocked status.

1. **Settings (UI, once):** enable Initiatives, enable Triage on Forge, add status Blocked (started),
   configure git automations (draft PR → In Progress, PR open → In Review, merged → Done).
2. **Initiatives:** one per bucket project (BattleBuddy, h-cloud, Omni, Signal CLI, Linear-AI, CMS,
   Decide It!, D-Streamy, Better Audio Mixer, Cluster); config maps each to its repositories.
3. **Features:** each `EPIC` parent becomes a project under its initiative; the epic's description goes to
   the project description or a Document; second-level parents become milestones when they are delivery
   checkpoints, otherwise stay parent issues; leaves stay issues; the epic issue is closed as replaced.
4. **Loose and finished issues:** the old bucket project stays as "<name> · maintenance" (no target date)
   under the initiative, so history and small fixes keep a home.
5. **Labels:** create groups `stage`, `agent`, `merge`, `repo` (only where an initiative has several
   repositories); retire (not delete) `EPIC`, `Page`/`route-planner`, `sp-*`, `in-use`, `llm-pilot`, and
   the `LLM` group after draining; `Component` (Pipeline, Integration) is Linear-AI-specific and moves to
   that initiative's issues or retires.
6. **In-flight work:** `llm-review` issues finish with the old closer; `llm-ready` and `llm-refine` issues
   re-enter as `stage:decomposition` / `stage:discovery` and are rewritten into the issue template.
7. **Execution:** `nightshift doctor --migrate` prints the planned Linear operations per step, you approve, then
   it applies them; steps 3 and 6 run as a lead session with you because they need judgment.

Migration of the workflow itself: freeze `linear-ai` v1.6.3, drain in-flight `llm-*` issues with the old skills, port plan-schema
fields into the issue-template validator and `verify_handoff`/`verify_closeout` into the gate runner,
then retire the old labels.

## 6. Context

One stack, no overlaps:

- Search: ripgrep + ast-grep, plus a code graph for structure (callers, impact, outlines):
  CodeGraphContext or codebase-memory, chosen by measurement (placement under "Tools per role").
  codebase-memory's own paper: 83% vs 92% answer quality against grep exploration at 10× fewer tokens —
  a token saver, not a replacement. Indexes live in `~/.cache/nightshift/index/<repo>`, never in a repo.
- Output: rtk (context-mode only in interactive Claude Code).
- No embeddings/semantic search until traces show localization misses (then jina-code-embeddings or
  Qwen3-Embedding locally).
- Drop: LeanKG and GitNexus as local tools (overlap; both write into repos), Serena (LSP costs
  more tokens than grep in 2608.13568), mem0/Letta/Zep/Cognee (second memory store), Spec Kit/OpenSpec/
  BMAD/Kiro (write into repo; borrow their templates).

**Context builder** (per dispatch): issue goal + acceptance criteria, matching design section, decisions
tagged to touched modules, blocker outputs (final interfaces, PR links), file outlines plus full source
for files to edit and one hop of callers/callees, matching lessons, verify commands. Token budget per
section; target 16–48k total. Workers get the package, not free exploration of the whole repo.

Knowledge placement:

| Knowledge | Lives in |
|---|---|
| feature design, alternatives, decisions | Linear Document |
| task spec, acceptance, interfaces | Linear issue |
| ADRs for a team-shared repo | `docs/adr/` in the app repo (ordinary engineering docs) |
| conventions | short, human-written `AGENTS.md` in the repo (LLM-generated ones reduce success, 2602.11988) |
| architecture overviews, decisions, conventions detail, pitfalls, lessons, failure learnings | knowledge vault `wiki/` |
| closed designs, PR summaries, failure reports, external articles | knowledge vault `raw/` |
| code index | `~/.cache/nightshift/index/<repo>` |
| runs, transcripts | Phoenix / `~/.cache` |

OpenWolf (`.wolf/`) and the `ai-context` skill (`.ai-context`) are switched off for application repos;
the vault replaces them.

**Knowledge vault** (Karpathy's "LLM wiki" idea file, gist 2026-04-04): a markdown vault in its own git
repository (`~/knowledge`), read by humans in Obsidian (optional viewer: graph, Dataview/Bases over
frontmatter) and by agents as plain files. The pipeline never depends on Obsidian (its CLI drives the
running app and is not headless). Index-first, no vector DB; Karpathy reports it holds at "~100 sources,
~hundreds of pages". Pages follow the OKF v0.2 format (markdown + YAML frontmatter; `index.md`, `log.md`
reserved).

```
AGENTS.md                      schema: page types, frontmatter, surgical-edit and citation rules (CLAUDE.md symlink)
index.md                       one line per page, grouped by category
log.md                         append-only, "## [YYYY-MM-DD] ingest | <title>"
raw/{linear,prs,reviews,failures}/<date>-<id>.md   immutable sources
wiki/{repos,components,decisions,patterns,pitfalls,runbooks}/
.manifest.json                 obsidian-wiki's ingest ledger (source → pages, last synced commit)
```

The `obsidian-wiki` skills are installed from this repository's pinned skill list into every harness.

Frontmatter: `type`, `title`, `summary`, `repo: [..]`, `paths: [repo-relative globs]`, `tags`,
`sources: [raw/...]`, `status: active|superseded|draft`, `created`, `updated`; optional `superseded_by`,
`verified`. Claims cite their `raw/` source; uncertain ones are marked `^[inferred]`.

- **Ingest:** at feature closeout, two-step (analyse, then write with the strongest local model), one
  source at a time, as staged writes (`wiki-stage-commit`); you review the staged pages, promoted pages
  are committed to the vault repository. Old decisions are superseded with links, never deleted.
- **Query:** any harness reads `index.md`, then pages. The context builder selects pages
  deterministically: `repo` match + `paths` glob intersection with the task's touch set, ranked by tags.
- **Lint:** deterministic on every vault PR (schema, broken links, orphans, globs matching nothing, stale
  `paths` against repo HEAD); LLM lint weekly as a PR (contradictions, supersession candidates).
- **Search:** add `qmd` (local BM25/vector/rerank CLI, MIT) only when the vault passes ~300 pages or
  discovery misses are measured.
- **Tooling: adopt `Ar9av/obsidian-wiki`** (MIT, Karpathy-pattern implementation, skills for OpenCode,
  Codex and Claude Code), pinned to a release and limited to the skills this design uses: `wiki-setup`,
  `wiki-ingest`, `wiki-update` (sync a project's knowledge), `wiki-query`, `wiki-lint`, `cross-linker`,
  `wiki-context-pack` (token-bounded, cited context slice for a downstream agent) and `wiki-stage-commit`
  (staged writes reviewed before promotion, `WIKI_STAGED_WRITES=true`). The rest (history ingest of
  chat tools, dashboards, narration, …) stays disabled. Its schema is extended with `repo`, `paths`
  and `status`. Worker context still uses the deterministic `paths` selection; `wiki-context-pack` serves
  the lead and direct use. Fallback if it does not hold up: a thin own `kb` skill, or
  `atomicstrata/llm-wiki-compiler` (MIT CLI).
- **Risks:** written errors persist (diff review, citations, surgical edits); `paths` rot after refactors
  (lint); local-model synthesis quality; review fatigue when one source touches 10–15 pages.

### Tools per role (skills, CLIs, MCP, plugins)

CLI vs MCP is decided per tool, not as a rule. Evidence (§15): with a few well-designed tools the protocol
is a wash (Zechner 2025); large MCP servers cost 10–30× more tokens (Scalekit, GitHub MCP with 43 schemas);
tool-selection accuracy drops beyond ~10–30 visible tools even for frontier models, and local models
reach that limit sooner; OpenCode v2 runs MCP servers in Code Mode by default (tools called from code,
schemas not in the prompt; open stdio bug #51849). The deciding factor here is **where the credential and
the network egress live**:

- **CLI + `SKILL.md`** when the tool is local or on the host, the credential is already there or harmless,
  and output benefits from `jq` / rtk piping.
- **MCP through the LiteLLM gateway** when the call runs inside a sandbox (egress is gateway-only), the
  credential is a SaaS key that must not enter a VM, or per-key allowlists and audit matter. Keep each
  server's visible tools at ≤10 via LiteLLM toolsets. A shell wrapper `gw` over LiteLLM's
  `/mcp-rest/tools/call` gives gateway credentials with CLI-style use and no schemas in the prompt.

Workers need neither Linear nor GitHub: the supervisor fetches a worker's commits from the sandbox remote
and pushes branches and opens PRs on the host with `gh`. That removes the only reason to put a GitHub
token in a sandbox.

| Tool | Lead / direct use (host) | Worker (sandbox) | Supervisor |
|---|---|---|---|
| Linear | `linear` CLI (schpet/linear-cli) + skill | none | `@linear/sdk` |
| GitHub | `gh` | none (git only, against its private clone) | `gh` |
| code graph | `cgc` or codebase-memory CLI on the host index | same CLI on the read-only mounted index; re-index of its clone only on an `insufficient context` retry | rebuilds indexes after fetch |
| library docs | `ctx7` CLI | context7 MCP via gateway (2 tools) or `gw` | — |
| web search | `search` skill: curl searxng JSON API | searxng MCP via gateway (4 tools) or `gw`; off by default | — |
| Phoenix | `px` CLI (`@arizeai/phoenix-cli`) | none (OTel export only) | OTel + `px` |
| browser tests | `playwright-cli` + skill | same CLI inside the VM for UI projects; Playwright MCP only for long exploratory sessions | — |
| output compression | rtk; context-mode optional in interactive Claude Code | rtk | — |

| Role | Skills | Plugins / hooks |
|---|---|---|
| lead (interactive) | `discover`, `design`, `decompose`, `status`, `replan`, `intake` (new); `brainstorming` folded into `design`; vault skills; one skill per CLI | rtk, `linear-guard`, OTel → Phoenix |
| worker (sandbox) | none loaded; TDD, systematic debugging and verification-before-completion rules condensed into the worker prompt | rtk, OTel → Phoenix |
| reviewer | short checklist prompt (written new); no tools | OTel → Phoenix |
| intake / classifier | — (structured JSON output; the supervisor writes Linear) | — |
| direct use (oc / cc / cx) | same skills repo, vault skills, `upgrade-deps`, `iterate` | rtk, `linear-guard` |

Claude Code through LiteLLM: tool search (deferred MCP tools) is off for non-first-party base URLs unless
`ENABLE_TOOL_SEARCH` is set.

Code graph placement: **one index per repository on the host**, built from an export of `origin/<base>`
(`git archive` into `~/.cache/nightshift/index/<repo>`, so neither your working tree nor your `.git` changes)
and rebuilt by the supervisor after every fetch that moves the base. Sandboxes get the index
**read-only** next to the `.git` mount (file-based backends: CodeGraphContext with FalkorDB Lite/Kuzu, or
codebase-memory's SQLite); no network path and no credential needed. A worker's own edits are small and
visible through `git diff`; a re-index inside the sandbox happens only on an `insufficient context` retry. Tool choice is measured,
not assumed: CodeGraphContext (worked well in prior use) vs codebase-memory vs none, in spike 2. A
**central server in h-cloud** is only needed for cross-repo questions or clients without a checkout.
Candidates, if it becomes needed:

| Option | Layer | Notes |
|---|---|---|
| CodeGraphContext + Neo4j (or FalkorDB) in the cluster | structural graph | same `cgc` CLI pointed at the shared DB (Neo4j's own auth); a CI job or CronJob indexes default branches on push; MIT |
| Infigraph (intuit, Apache-2.0, 2026) remote mode | structural graph, 62 languages, no LLM | Neo4j + pgvector; HTTP MCP with one bearer key; no image or Helm chart yet; young (91★) but a real corporate team |
| Sourcebot (FSL → Apache) | text/regex/symbol search across all repos and branches | official Helm chart, GitHub sync; MCP, code navigation and OIDC need Pro ($20/user/month); REST API free |
| code-graph-rag (MIT) | structural graph + semantic search | Memgraph + Qdrant; token-auth HTTP MCP; effectively one maintainer |

Not suitable: GitNexus (PolyForm Noncommercial), Tabby (dormant), Bloop/Refact/graph-sitter (archived),
Potpie v2 (local-only now), claude-context (client-side indexing), deepwiki-open (no API for agents),
OpenGrok/Hound/Livegrep (text only, no structure), Onyx/Cognee (general RAG/memory).

Graphify (Graphify-Labs, Apache-2.0, created 2026-04) was checked and not chosen as the code graph:
code extraction is LLM-free, but storage is an in-memory `graph.json` (512 MiB cap), ~40 languages,
text-only MCP output, a single shared API key, no per-branch graphs, and an unstable v0.9.x API; its
123k stars look inflated. Its distinctive feature — docs, ADRs and schemas in the same graph as code —
overlaps with the knowledge vault; revisit only if the vault proves insufficient for architecture questions.

Disposition of what is installed today:

| Item | Decision |
|---|---|
| superpowers: TDD, systematic-debugging, verification-before-completion, receiving-code-review | keep (condensed for workers, full for direct use) |
| superpowers: brainstorming, writing-plans | folded into `design` / `decompose` |
| superpowers: executing-plans, subagent-driven-development, dispatching-parallel-agents, using-git-worktrees, finishing-a-development-branch | replaced by the supervisor |
| `linear-ai` skills (v1.6.3) | replaced (§5) |
| OpenHands extensions: `iterate`, `github-actions` | keep |
| OpenHands extensions: `code-review`, `learn-from-code-review`, `agent-memory`, `qa-changes`, `release-notes` | replaced by reviewer, vault ingest and query, acceptance stage, release stage |
| `upgrade-deps`, `wow-addon` | keep (recurring issue; project-scoped) |
| Linear, context7, searxng via the LiteLLM MCP gateway | host: `linear`, `ctx7`, `search` CLIs; sandboxes: context7 and searxng stay on the gateway |
| codebase-memory-mcp as MCP | used as CLI |
| context-mode | not in the pipeline (rtk + `--json \| jq`); optional in interactive Claude Code |
| CodeGraphContext (`codegraph` in `AGENTS.md`) | keep as candidate (worked well in prior use); compared with codebase-memory in spike 2; `cgc` CLI |
| OpenWolf, `ai-context` | drop |
| z.ai MCPs (`web-search-prime`, `web-reader`, `zread`) | drop: overlap with searxng and send queries to a cloud vendor |
| `openaiDeveloperDocs` MCP | direct use only, when working on OpenAI integrations |
| `@devtheops/opencode-plugin-otel` | keep; becomes the Phoenix trace source for OpenCode sessions |
| `oh-my-openagent` | removed from the default OpenCode config: its own agent roster and orchestration overlap with the lead skills and the supervisor, and its large prompts hurt local models; can live in a separate opt-in profile (`OPENCODE_CONFIG`) |
| browser testing (shiplight, Playwright/Chrome) | optional acceptance-stage tool for UI projects |

The tool-set effect is measured, not assumed: spike 2 runs workers with and without the code graph.

## 7. Verification

Order, each step only if the previous passed:

1. Repository checks: build, types, lint, tests, including tests the issue demands (authoritative).
2. Deterministic scanners: semgrep, dependency audit, secret scan; an LLM triages their findings only.
3. One reviewer, **different model family** than the worker, fresh context: issue spec, design excerpt,
   diff, gate results; short checklist prompt (long "explain and fix" prompts raise false findings,
   2603.00539). Findings are advisory unless a test or tool reproduces them.
4. Feature acceptance after the last issue merges: lead agent checks project acceptance criteria against
   the integrated branch; then user.

No always-on security/architecture LLM reviewers: no ablation shows they improve outcomes. Add a lens per
path only when its precision is tracked. Reviewer agreement with real outcomes is measured by the
evaluation harness (§10).

## 8. Isolation and workspaces

- **Runtime:** Docker Sandboxes (`sbx`, Mar 2026): microVM per sandbox, own kernel, private Docker engine
  (testcontainers/kind possible), deny-by-default egress with domain/method rules, host-side credential
  injection, CPU/RAM limits. Behind a `SandboxDriver` (`create/exec/attach/logs/destroy`) so Apple
  `container` (1.5, API still changing) or Microsandbox (libkrun, pre-1.0) can replace it. Plain Docker
  stays as the trusted driver and the evaluation backend until Harbor's sbx backend lands.
- **Not boundaries:** worktrees; seatbelt sandboxes (srt, Codex, Claude Code) — use those as a second
  layer inside the VM only (no nested Docker, shared kernel).
- **Rejected:** container-use (no release in over a year), Arrakis (dead), Firecracker/E2B (need Linux
  KVM), Tart (too heavy), OrbStack/Colima (shared VM).
- **Workspace:** repositories stay where they are, in your checkouts under `~/Dev/<repo>`. The supervisor
  only ever runs `git fetch` there; it never checks out, resets or touches your working tree, branch or
  uncommitted work. A sandbox mounts **only that repository's `.git` directory, read-only** — not the
  working tree, which can hold untracked secrets such as `.env` or `*.pem` — and creates its working copy
  inside the VM with `git clone --shared` from it, at `origin/<base>` (objects borrowed from the mount,
  nothing copied; the task branch and all writes stay inside the sandbox). This is the worktree idea
  without a host `git worktree`, which would write into your `.git` (`worktrees/`, refs, objects) and let
  agents touch shared hooks/config. `sbx --clone` implements the same pattern and exposes results as a
  `sandbox-<name>` remote the supervisor fetches from.
- **Credentials:** no GitHub or Linear credential inside sandboxes. The supervisor pulls commits from the
  sandbox remote and pushes/opens PRs on the host with `gh`, authenticated with a fine-grained PAT limited
  to managed repositories (contents, pull requests) — not your personal `gh` login. The account is chosen
  by repository owner (as in auto-code-env's `github-identity.sh`: `lkshrk`, `loc-news`, `routivo`,
  `webdev-harke` → agent account; other owners → personal account, forks judged by `upstream`). A GitHub App only if
  per-run tokens become necessary. Per-worker LiteLLM virtual key. No host
  `~/.ssh`, `~/.kube`; unset `SSH_AUTH_SOCK`.
- **Environment:** one devcontainer/Dockerfile per repo built into a tagged image with warm caches;
  harness versions pinned.

### Inside and outside the sandbox

Image layers (built on the Mac, cached, digest-pinned per repository):

1. **Environment layer:** the repository's own `.devcontainer/` if it has one (ordinary dev tooling, not
   an AI artifact); otherwise a definition kept in this repository under `environments/<repo>/`. Contains
   OS base, language toolchains, package managers, project build/test dependencies with warm caches.
2. **Agent layer** (`FROM` the environment image, defined here once for all repos): pinned OpenCode v2,
   rtk, git, `gh`, `ctx7`, `search`, ripgrep, ast-grep, codebase-memory binary (no `linear`: workers
   have no Linear access), scanners (semgrep, gitleaks, dependency
   audit), OTel exporter config. No credentials, no config tied to a person.

| Inside a worker sandbox | Injected per run | Never inside |
|---|---|---|
| image layers above; private Docker engine (from `sbx`) for repos that test with containers | read-only mounts of the repository's `.git` and its code-graph index; shared clone at `origin/<base>` with the task branch; context package (prompt file); rendered harness config for the role and model; gateway URL + per-worker LiteLLM virtual key; OTel endpoint; private CA bundle for the gateway (read-only) | Linear credentials; LiteLLM master key; your `gh` login, `~/.ssh`, `~/.kube`, `SSH_AUTH_SOCK`; the knowledge vault (only selected pages travel inside the context package); other repositories; host Docker socket; supervisor state; model weights |

Outside, on the Mac: supervisor + `nightshift` CLI and its SQLite log; your `~/Dev` checkouts (fetch only);
code-graph indexes; image builds and caches; the `sbx` daemon; oMLX and model files; the knowledge vault;
the lead's OpenCode session (repository edits denied by permissions, Linear via the `linear` CLI).

In h-cloud: LiteLLM (models, MCP gateway), searxng, Phoenix, optionally a central code graph. Sandboxes
export traces through the gateway host on a path prefix (e.g. `/otel/`), so no second egress host is
needed.

### Stacks (language templates)

Some OpenCode built-in language servers download themselves on first use, which the sandbox egress
policy blocks, so every stack installs its servers and tools at image build time.

- **A stack is a Dev Container Feature** in this repository (`features/stack-<name>/`:
  `devcontainer-feature.json` + `install.sh`) that `dependsOn` the official toolchain Feature and adds
  the agent's extras (language server, formatter, linter, test tools, semgrep rules), plus a
  `stack.yaml` nightshift reads: marker files, version files (`go.mod`, `.nvmrc`, `.python-version`,
  `.tool-versions`, `packageManager` in `package.json`), the OpenCode `lsp` entries (explicit commands, no
  auto-download), default check commands.
- **Composition:** stacks are detected from marker files (several per repository); built with
  `devcontainer build --additional-features` on top of the repository's own `.devcontainer/` when it has
  one (`easy-web-gpg`, `tuppr`) or a generated one in `environments/<repo>/`; the shared agent layer is a
  Feature too. Rebuilt when version files change (hash of marker files). Features are published to GHCR
  from this repository's CI, pinned by digest, bumped by Renovate. RepoLaunch output (repo-specific
  dependencies, services, test commands) is stored as an overlay in `environments/<repo>/`.

| Stack | Markers | Repositories (examples) | Language server and tools |
|---|---|---|---|
| `go` | `go.mod` | omni, pilot, ops-pilot, gatus-sidecar, tuppr | gopls, golangci-lint, gofumpt |
| `node` | `package.json` + npm/pnpm lock | civora, routivo, pfalz-herz, quintessenz | typescript-language-server, eslint/oxlint, prettier |
| `bun` | `bun.lock` | dstreamy, cms-sidecar, portfolio, linear-ai, useful-skills | bun, typescript-language-server, biome/oxlint |
| `python` | `pyproject.toml` | civora, routivo, llm-as-a-judge, ing | basedpyright, ruff, pytest, uv |
| `kotlin` | `build.gradle.kts` | decide_it_kmp | kotlin-lsp, JDK, Gradle; Android SDK optional |
| `lua` | `*.lua` without WoW markers | — | lua-language-server, luacheck, stylua |
| `wow` | `*.toc` with `## Interface` | EllesmereUI and other addons | `lua` + WoW extras (below) |
| `k8s` | `kustomization.yaml`, `Chart.yaml`, Talos/Argo files | h-cloud | yaml-language-server, kustomize, helm, kubeconform; no cluster credentials |

Further stacks from auto-code-env's `catalog.json` are added when a repository needs them: `rust`,
`gitops` (flux, helmfile, sops), `argo`, `talos`, `cilium`, `cnpg` (kubectl-cnpg), `iac` (opentofu,
terraform-ls); its `infra` alias expands to the k8s-family set. Its `quality` set (actionlint, gitleaks,
bats, shellcheck, bash-language-server) goes into the shared agent layer. Swift/Xcode apps (better-audio-mixer, dstreamy's Apple targets) and KMP iOS targets need macOS and
stay out of the automated pipeline for now (later: Tart macOS VMs, or a host profile with manual merge).

**`wow` stack** (ported from auto-code-env's `wow_dev` preset, the one place where earlier work is reused
because it encodes game knowledge, not architecture):

- Image: `lua` stack + the WoW API annotations (`Ketho/vscode-wow-api`) and Blizzard's FrameXML
  (`Gethe/wow-ui-source`, branch `live`) and generated global lists (`Ketho/BlizzardInterfaceResources`),
  fetched at **build** time (no network in the sandbox); a generated `.luacheckrc` with every WoW global as
  read-only; lua-language-server configured for Lua 5.1 with the annotations as workspace library
  (the `wow-luarc` settings, injected through OpenCode's `lsp.initialization` rather than a file in the
  repository).
- Worker tools (offline): `wow-check` (`.toc`/XML lint, luacheck, lua-language-server), `wow-api`
  (function/event lookup incl. secret-value notes), grep over `wow-ui-source`.
- Host-only tools (need the game desktop through rclone, so never inside a sandbox): `wow-sync` (push to
  the game's AddOns folder, release-copy protection), `wow-errors` (BugGrabber errors), `wow-sv`
  (SavedVariables). The supervisor runs them; `wow-errors` output after your `/reload` is fed back to
  the worker as gate output.
- Stage pipeline for addons: implementation → `wow-check` gate → `wow-sync` at the acceptance stage →
  you test in game → `wow-errors` / `wow-sv` → done or repair. Acceptance is always manual.
- The `wow-addon` skill (12.x/Midnight API rules: removed combat log, secret values, namespaced APIs,
  debugging checklist) becomes the stack's worker skill, with the Coder-specific instructions removed.

### Carried over from auto-code-env

auto-code-env's architecture (Coder, OpenHands, dotfiles composition) is not reused; these pieces are:

| Source | Becomes |
|---|---|
| `coder/templates/shared/catalog.json` | tool lists per stack (`stack.yaml`) |
| `shared/claude-lsp.sh` (server commands, args, extensions) | `lsp` section of `stack.yaml`; CI check that every stack declares an installed language server (from `test_catalog.py`) |
| `shared/linux-tools.json` (release assets with per-project arch names) | agent-layer `install.sh` recipes |
| `modules/opencode/install.py` (npm integrity check, rtk digest check; worker wrapper with isolated XDG dirs, `OPENCODE_DISABLE_AUTOUPDATE`, empty `models.json` + `OPENCODE_DISABLE_MODELS_FETCH` against anomalyco/opencode#50236) | agent layer |
| `modules/opencode/main.tf` permission rules (ask on push / PR create / kubectl and flux mutations; deny merge, force-push, repo delete, destructive Linear verbs; only the gateway as provider) | lead and direct-use permissions; sandbox deny list (§11) |
| `shared/github-identity.sh` | supervisor's owner → account routing |
| `shared/workspace-ca.sh` (one CA bundle exported as `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`) | agent-layer entrypoint for the gateway CA |
| cache env pinning in `common.tf` (TMPDIR on the cache volume, `UV_CACHE_DIR`, pnpm store under both config names, `GOCACHE`, `GOLANGCI_LINT_CACHE`) | environment layer |
| `shared/dind-cleanup.sh` (tiered Docker prune) | supervisor hygiene for sandbox Docker engines |
| `h-cloud-upgrader/prompt.md` (48 h embargo, Renovate decision comments, health gate) + `tools.lock.json` (digest-pinned tools, `follow` of `.mise.toml`) | `k8s` stack skill and `upgrade-deps`; pinning pattern for agent-layer binaries |
| `linear-triage/prompt.md`, `pr-review/prompt.md` rules | input for the intake and reviewer prompts (AI-disclosure lines removed) |
| `renovate.json5` (regex manager for `# renovate:` comments, no automerge for behaviour-changing tools) | this repository's Renovate config |

Quirks to respect: several old assets are x86_64-only (`@opencode/cli-linux-x64`, `tools.lock.json`,
amd64 kubectl; rtk is musl on x86_64 but gnu on aarch64) — every recipe needs its arm64 variant.
CodeGraphContext writes `.cgcignore` into the directory it indexes (harmless here: it indexes the
`git archive` export, never a repository). Bun's global bin follows `XDG_CACHE_HOME` (`bun pm bin -g`).
LiteLLM: models served as `openai/` lose vision unless `supports_vision` is set; a caller's
`reasoning_effort` overrides the router tier.

Gates and review do not trust the worker's environment: after the worker finishes, the supervisor
fetches the commit and runs the gate commands in a **fresh sandbox from the same image**, so a worker
cannot alter test results. The reviewer is a plain model call with spec, diff and gate output; it needs
no sandbox and no tools.

## 9. Inference

- **Hardware (ordered):** M5 Ultra, 256 GB, 4 TB. 1.2 TB/s, ~3–4× prefill over M3 Ultra. GPU-usable memory
  is below 256 GB by default (raise with `sysctl iogpu.wired_limit_mb`); plan for ~220 GB. The 4 TB SSD
  holds model files and oMLX's SSD KV-cache tier.
- **Serving:** oMLX 0.7 (continuous batching, RAM+SSD KV cache, per-family tool parsers, grammars, MTP)
  behind LiteLLM; vllm-mlx as fallback; llama.cpp for GGUF-only quants. Not Ollama.
- **Gateway stays in the h-cloud cluster.** Local-model calls go Mac → cluster → Mac. Consequences: the
  cluster must reach oMLX on the Mac (LAN/VPN route, auth in front of oMLX); a cluster or link outage
  stops all workers, so the supervisor treats gateway errors as environment failures and pauses dispatch;
  per-worker virtual keys and budgets stay central; sandbox egress allowlists one
  gateway hostname (no access to Mac loopback needed). Measure the added round-trip latency per call.
- **Prefill is the bottleneck:** a cold 128k prompt on Qwen3.8-27B took 117 s on M5 Ultra. Keep system
  prompts stable for prefix-cache hits, keep worker contexts small, check that LiteLLM and the harness do
  not break caching (Claude Code reportedly sends ~45–50k first turns and a per-request hash).
- **Cost attribution:** every worker run sends `x-litellm-session-id` (the run id) next to its virtual
  key, so LiteLLM's spend logs attribute cost per run.
- **Concurrency:** aggregate throughput roughly doubles at 4× batch, per-request speed falls beyond 4–8;
  with 256 GB, 3–4 concurrent workers (below).

Starting roles (all need confirmation on your own tasks; no independent scores exist yet for this
generation, and prior-generation ≤35B local models solved ~40–50% as many fresh SWE-rebench tasks as
frontier):

256 GB cannot hold GLM-5.3-Flash (~178 GB) next to the worker model, so models are loaded per phase.
Planning and implementation of one feature are sequential; oMLX loads and evicts models on demand
(verify its eviction behaviour in spike 3).

| Phase | Resident models | ~4-bit size |
|---|---|---|
| implementation | workers: Qwen3.8-Flash-Next (6B active) ~100 GB; reviewer from another family in the 40–70 GB class (candidate chosen in spike 2); classification: Qwen3.8-27B with JSON grammar ~16 GB | ~160–190 GB |
| planning | lead: GLM-5.3-Flash ~178 GB alone, or Qwen3.8-Flash-Next when implementation runs at the same time | ~100–178 GB |

Expect ~3–4 concurrent workers, not 6. Cloud escalation is off; capability-limit failures go to you.

### Model profiles (swappable at runtime)

- **Logical names only:** agents and harness configs reference role aliases served by LiteLLM
  (`ns/lead`, `ns/worker`, `ns/reviewer`, `ns/classifier`), never concrete models.
- **Profiles:** a named role → model mapping (`default`, `fast`, `quality`, …) in nightshift's config,
  overridable per repository and per stage.
- **Live switch:** `nightshift profile use <name>` (or an edit of the watched config file) applies to new
  dispatches without a restart. LiteLLM aliases are updated through its admin API, or stay fixed with
  nightshift resolving concrete names itself.
- **Pinned per run:** at dispatch the alias is resolved to a concrete model and recorded on the issue
  and in Phoenix; a running worker keeps its model (no mixed-model changes, no prefix-cache loss, the
  cross-family reviewer rule holds). `nightshift retry <issue> --profile <name>` re-runs on another one.
- **Checks before switching:** the profile's resident models fit the ~220 GB budget (sizes from oMLX);
  reviewer family ≠ worker family; models not yet loaded are preloaded or flagged with their load time.
- **Evaluation:** a profile name is a Phoenix tag, so profiles are compared as experiments in the
  evaluation harness.

Effort: ~1–2 days on top of the supervisor (profile schema and dispatch-time pinning ~1 day, CLI and
config watching ~0.5 day, checks ~0.5 day); LiteLLM aliases are configuration.

## 10. Agents: authoring and improvement

**Authoring:** the role agents (lead, worker, reviewer, intake/classifier) are OpenCode-native files in this
repository, the single source of truth: `agents/<role>.md` (frontmatter: model, permissions, tools; body:
system prompt) and `skills/<name>/SKILL.md`, rendered into each harness's config. No agent framework
(OpenAI Agents SDK, Mastra, VoltAgent have scorers but no optimizer).

**Improvement:** optimizers only ever edit these text files, and every change arrives as a PR with the
prompt diff, per-task scores and the Phoenix experiment link. Nothing rewrites itself in production.

- **Optimizer: standalone GEPA** (`gepa`, MIT, ICLR 2026): reflective prompt evolution over any text,
  including SKILL.md files; a custom `GEPAAdapter` runs candidates through the evaluation harness (Harbor) as a black box and
  returns score + feedback text (failing tests, gate logs, reviewer disagreement). Runs as a Python sidecar.
  Its `gskill` variant learns repo-specific skills for coding agents (claim: Mini-SWE-Agent 55→82%).
- **DSPy + GEPA/MIPROv2** for the two single-call roles (reviewer, classifier); the optimized instruction
  is exported into the prompt file.
- **ACE-style playbook** for the lead: reflection proposes small delta bullets to a playbook skill; human
  curated.
- **Evaluation:** the evaluation harness below + Phoenix experiments on frozen dataset versions;
  Promptfoo's OpenCode provider as an optional smoke gate for single-call roles. Reviewer and classifier prompts are mirrored
  into Phoenix's prompt registry (`candidate` / `production` tags) so traces link to prompt versions.

| Role | Metric | Data | Cadence | Gate |
|---|---|---|---|---|
| intake / classifier | macro-F1 on failure class, JSON validity | Phoenix spans labelled by outcome or human override (≥200) | weekly or after 50 new overrides | holdout ≥ production + 2 pp, no class −5 pp |
| reviewer | precision/recall vs findings confirmed by tests, reverts or you | historical spec/diff/gate triples + diffs with known bugs (reverted fixes, SWE-smith mutations) mixed with clean diffs | every two weeks | recall holds, precision improves, ~20 spot checks |
| worker | hidden-test pass rate; gates, tokens, time as tie-breakers | minibatches of 5–10 tasks, 30–60 validation tasks, a held-out test set never seen during optimization | monthly and on every model swap | paired holdout gain beyond seed noise |
| lead | worker success on its plans, replan count, your edits to plans | replayed discover/decompose runs | quarterly | always manual |

### Evaluation harness

Designed from current practice, not from earlier in-house code:

1. **Task mining** (own code, SWE-rebench / SWE-bench Verified method): merged PRs that touch source and
   tests → statement from the linked issue/PR, rewritten by an LLM to remove the solution; base = parent
   commit; hidden tests = the PR's test diff; gold patch = the source diff; FAIL_TO_PASS / PASS_TO_PASS
   computed by running both; emitted as Harbor task directories.
2. **Synthetic tasks:** SWE-smith-style mutations and PR reverts on the same images, for volume,
   controlled difficulty and reviewer bug sets (small repo histories will not yield 150 real tasks).
3. **Environments:** RepoLaunch (Microsoft, MIT) builds a repository's test environment once and reuses
   it across commits; arm64-native images built on the Mac; one image per repository plus a per-commit
   layer.
4. **Runner: Harbor** (Apache-2.0, Terminal-Bench's framework): ships an OpenCode agent adapter (plus
   Claude Code, Codex, mini-swe-agent for reference runs), parallel trials, docker / apple-container
   backends; Docker Sandboxes backend is an open PR (#3366). Models via LiteLLM.
5. **Scoring:** hidden tests (resolved + fraction passing), repository checks, tokens, cost and time from
   the trajectory; `harbor-atif2otel` sends traces to Phoenix; results load into Phoenix
   datasets/experiments tagged with model, role, prompt hash and task-size bucket.
6. **Non-coding roles:** reviewer on known-bug and clean diffs (precision, recall, false positives per clean
   diff); classifier on the harness's own objectively labelled failures (confusion matrix, macro-F1);
   planner judged by execution — plan → fixed executor → downstream success and cost vs a no-plan
   baseline, plus file recall against the real PR.

Statistics: paired comparisons on the same tasks, standard errors clustered by repository, 3–5 seeds;
50 tasks ≈ ±14 pp, 200 ≈ ±7 pp. Task size from LLM-estimated human time (spot-checked) and gold-patch
size; a METR-style logistic fit of success vs log(size) gives each model's 50% horizon.

Avoid: future-history leakage (strip refs past the base commit, block the git remote), flaky tests (run
gold and base 3×, drop nondeterministic ones), underspecified tasks (LLM check of statement vs tests,
then your review), x86-only images under emulation, LLM-judge-only scores where tests exist, reporting on
optimization tasks, comparing models at unrecorded context or quantization settings. Inspect AI is the
fallback runner if stronger statistics tooling is needed (no native Phoenix export).

Avoid for agent improvement: Agent Lightning RL (needs CUDA/verl), self-modifying scaffolds (DGM, SICA), online self-editing
skills without a gate (Hermes, Letta), stale TextGrad/Trace, Opik (second observability backend), tuning
several roles at once, optimizing on evaluation tasks, unbounded skill growth (token budget per skill).
Risk: published gains used strong cloud models as the reflector; with cloud models off, the reflector is
local (GLM-5.3-Flash) — measure whether its proposals are good enough before relying on the loop.

## 11. Policies

- **Risk paths:** each repository's config lists high-risk globs (CI workflows, infrastructure/GitOps,
  database migrations, auth, secret handling). A change touching one always gets manual merge and your
  review, whatever merge mode the session chose. Destructive commands (force-push, history rewrite,
  `rm -rf` outside the workspace, cluster-mutating CLIs) are denied in sandboxes.
- **Cross-repo features:** one project may span several repositories; each issue belongs to exactly one.
  Contracts between repositories are interfaces in the design Document; ordering is enforced with
  `blocks` relations; no shared branch across repositories.
- **Notifications:** questions and decisions reach you as Linear comments that mention you (Linear
  inbox) plus a macOS notification from the supervisor. A Signal channel (via the Signal CLI project) is
  planned for later; ntfy in the cluster is the interim option for phone push.
- **Limits** (config, per role and repository): wall-clock and token budget per worker run, 3–4 concurrent
  workers, at most 2–3 repair rounds before failure classification.
- **Prompt injection:** issue text, search results, PR comments and vault pages are data, never
  instructions; the per-role tool allowlists, no credentials in sandboxes and the egress allowlist bound
  what an injected instruction could do.
- **Naming:** the project and CLI are **`nightshift`** (short alias `ns`).

## 12. Distillation

Not now. Repetitive calls in this design are low volume (failure classification: tens per day) or solved
by rules (routing) and constrained decoding (schema extraction). Order of levers: deterministic rules →
grammar-constrained output → DSPy prompt optimization → small trained model. Start collecting now: tag
every LLM span in Phoenix with `task_type`, prompt version, model, structured output, and attach outcome
labels (fix succeeded, tests passed, PR merged, human override). Revisit a task at ≥1K outcome-labelled
examples with a 200-example gold set and a TF-IDF baseline. First candidate: worker-state classification
(stuck/looping/progressing) — heuristics first, then SetFit/ModernBERT. Escalation thresholds must use
logprobs, not verbalized confidence. taskdistill (6 days old, one author): borrow its evaluation method,
do not depend on it.

## 13. Not building

Peer-to-peer or debating agents; several agents on one change; reflection without test/tool signal;
stacked always-on LLM reviewers; unbounded best-of-n; learned routers; a second task DB (Beads etc.);
Kubernetes, Coder, remote workers; a web dashboard; a memory platform.

## 14. Plan

Spikes first, each answers one question with a measurement:

1. **sbx spike:** 5–20 sandboxes on the Mac; create time, `npm ci`/`uv sync` time, nested `docker run`,
   RSS per worker, reaching the h-cloud LiteLLM (and the `/otel/` path) through the egress policy,
   read-only `.git` + index mounts with `git clone --shared` inside the VM.
2. **Local model eval:** build the evaluation harness (§10) on 2–3 of your repositories, then run
   Qwen3.8-Flash-Next, GLM-5.3-Flash, Qwen3.8-27B and a 40–70 GB cross-family reviewer per role, with
   and without the code graph; fit success vs task size to set issue sizing. 30 tasks give direction
   only; decisions need ~100–150 paired tasks × 3 seeds.
3. **Gateway path check:** OpenCode `serve` → LiteLLM (h-cloud) → oMLX: prefix-cache hit rate over a
   worker run (LiteLLM must pass requests through unchanged), added latency, streaming and tool-call parsing,
   model load/evict times when switching between planning and implementation.
4. **Kandev spike (1 h), optional:** does it read Linear blocking relations, bind repos, run OpenCode in Docker on
   macOS? If yes, it can be the dispatcher with its DB as a disposable cache and the build shrinks.

First milestone (after the spikes): one repository and one Linear project; the `decompose` skill
writes issues from the template; the supervisor dispatches them to the plain Docker driver, runs the
gates and opens a PR. No Docker Sandboxes, learning loop or vault yet.

Then build in this order: issue template + `decompose` skill → supervisor (dispatch, watch, gates, Linear
sync, CLI) on the Docker driver → sbx driver → failure classification + replan → merge queue + stacked PRs
→ Linear Agents API front door.

## 15. Sources

Orchestration: [Symphony SPEC](https://github.com/openai/symphony/blob/main/SPEC.md),
[Gas City](https://github.com/gastownhall/gascity), [AO](https://github.com/Untrivial-ai/agent-orchestrator),
[OpenHands CLI](https://github.com/OpenHands/OpenHands-CLI), [Vibe Kanban shutdown](https://www.vibekanban.com/blog/shutdown),
[Linear agents](https://linear.app/developers/agents), [ACP](https://github.com/agentclientprotocol/agent-client-protocol),
[OpenCode server](https://opencode.ai/docs/server/), [OpenCode #51268](https://github.com/anomalyco/opencode/issues/51268).
Isolation: [Docker Sandboxes architecture](https://docs.docker.com/ai/sandboxes/architecture/),
[security](https://docs.docker.com/ai/sandboxes/security/), [git workflows](https://docs.docker.com/ai/sandboxes/workflows/git/),
[Apple container](https://github.com/apple/container/releases), [Microsandbox](https://github.com/superradcompany/microsandbox),
[srt](https://github.com/anthropics/sandbox-runtime).
Inference/models: [oMLX 0.7](https://github.com/jundot/omlx/releases/tag/v0.7.0), [oMLX benchmarks](https://omlx.ai/benchmarks),
[SWE-rebench](https://swe-rebench.com/), [Apple M5 Ultra](https://www.apple.com/newsroom/2026/08/apple-introduces-new-mac-studio-with-m5-max-and-m5-ultra/).
Context: [codebase-memory paper](https://arxiv.org/abs/2603.27277), [LSP tokens](https://arxiv.org/abs/2608.13568),
[AGENTS.md eval](https://arxiv.org/abs/2602.11988v1), [ACE](https://huggingface.co/papers/2510.04618),
[DreamBench-SWE](https://arxiv.org/abs/2608.20664), [Cursor semsearch](https://cursor.com/blog/semsearch).
Process: [Cognition](https://cognition.ai/blog/dont-build-multi-agents), [Anthropic multi-agent](https://www.anthropic.com/engineering/multi-agent-research-system),
[Scaling agent systems](https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/),
[MAST](https://arxiv.org/abs/2503.13657), [METR horizons](https://metr.org/time-horizons/),
[LLM judge over-correction](https://arxiv.org/abs/2603.00539), [Self-correction](https://arxiv.org/abs/2310.01798),
[Large Language Monkeys](https://arxiv.org/abs/2407.21787), [AgenticFlict](https://arxiv.org/abs/2604.03551),
[taskdistill](https://github.com/B0yko/taskdistill), [DSPy](https://github.com/stanfordnlp/dspy).
Tools: [MCP vs CLI, Zechner](https://mariozechner.at/posts/2025-08-15-mcp-vs-cli/), [Scalekit benchmark](https://scalekit.com/blog/mcp-vs-cli-use),
[Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp), [OpenCode v2 MCP](https://opencode.ai/v2/docs/mcp-servers/),
[LiteLLM MCP REST](https://docs.litellm.ai/docs/mcp_rest_api), [linear-cli](https://github.com/schpet/linear-cli),
[context7 CLI](https://context7.com/docs/clients/cli), [CodeGraphContext](https://github.com/CodeGraphContext/CodeGraphContext),
[codebase-memory](https://github.com/DeusData/codebase-memory-mcp), [Infigraph](https://github.com/intuit/infigraph),
[Sourcebot](https://github.com/sourcebot-dev/sourcebot), [Graphify](https://github.com/Graphify-Labs/graphify).
Knowledge: [Karpathy llm-wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f),
[obsidian-wiki](https://github.com/Ar9av/obsidian-wiki), [llm-wiki-compiler](https://github.com/atomicstrata/llm-wiki-compiler),
[qmd](https://github.com/tobi/qmd), [OKF](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md).
Agents: [GEPA](https://github.com/gepa-ai/gepa) ([paper](https://arxiv.org/abs/2507.19457), [gskill](https://gepa-ai.github.io/gepa/blog/2026/02/18/automatically-learning-skills-for-coding-agents/)),
[Arize prompt learning](https://arize.com/blog/claude-md-best-practices-learned-from-optimizing-claude-code-with-prompt-learning/),
[Promptfoo](https://github.com/promptfoo/promptfoo).
Evaluation: [Harbor](https://github.com/harbor-framework/harbor), [RepoLaunch](https://github.com/microsoft/RepoLaunch),
[SWE-smith](https://github.com/SWE-bench/SWE-smith), [SWE-rebench](https://arxiv.org/abs/2505.20411),
[Error bars for evals](https://arxiv.org/abs/2411.00640), [METR time horizons](https://arxiv.org/abs/2503.14499).
Linear: [pricing](https://linear.app/pricing), [releases](https://linear.app/docs/releases), [initiatives](https://linear.app/docs/initiatives),
[triage](https://linear.app/docs/triage), [reviews/diffs](https://linear.app/docs/diffs).

Most 2026 model and tool figures are vendor-reported or single-source; the spikes in §14 exist to replace
them with local measurements.
