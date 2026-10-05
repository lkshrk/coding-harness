# nightshift architecture

nightshift turns Linear issues into reviewed code changes. A lead agent plans features with you in the
terminal and writes the plan to Linear; a deterministic supervisor dispatches the resulting issues to
isolated workers, runs gates and review, and opens PRs. This document describes the architecture and the
main concepts. Plans, work packages, spike results, detailed specs and open decisions live in Linear (see
[Development](#development)).

## Summary

No existing project combines what nightshift needs: Linear as the only durable truth, independence from a
single harness and model, a real isolation boundary, deterministic supervision with an LLM only where
judgment is needed, and a terminal operator surface. Candidates either bring their own task database
(Gas City/Beads, AO, Vibe Kanban, Kandev), are tied to one harness (Symphony to Codex), isolate with
worktrees only (dmux, claude-squad, Cyrus), or are GUI products.

nightshift therefore adopts a mature component per layer and builds one small piece: a supervisor that
follows Symphony's `SPEC.md`, plus the agents, skills and prompts. Adopted: Linear for planning truth,
OpenCode v2 for lead and workers (each worker a top-level session, never an in-process subagent with a
model override), Docker and Docker Sandboxes for isolation, Dev Container Features for environments, the
LiteLLM gateway for inference, Phoenix for traces, Harbor and GEPA for evaluation and improvement. Built:
the supervisor (dispatch, event log, gates, merge queue), the CLI, the context builder, the stack Features
and the agent files.

One nightshift instance serves every Linear team and project; teams, projects, repositories and pipelines
are configuration, nothing is hard-coded.

## Target shape

```
          you (terminal, local or over SSH)
             │  `ns` chat: plan / discuss / "implement"      `ns attach | tail | watch`
             ▼                                                        │
   ┌──────── lead agent (OpenCode, on the host) ──────────┐           │
   │ discovery · design options · decomposition            │           │
   │ writes Linear project, design document, issues        │           │
   └───────────────┬──────────────────────────────────────┘           │
                   │ Linear = durable plan and status                  │
                   ▼                                                   │
   supervisor daemon (deterministic, no LLM by default)                │
     poll Linear · ready set from blocking graph · dispatch · watch    │
     events → SQLite · stall/loop heuristics · gates · merge queue     │
     only judgment events → single LLM call                            │
                   │                                                   │
       ┌───────────┼────────────┐                                      │
       ▼           ▼            ▼                                      │
   sandbox      sandbox      sandbox        one per active issue  ◄────┘
   read-only .git mount + shared clone, repo image, egress allowlist, no credentials
   OpenCode v2 worker session → LiteLLM (h-cloud) → models
                   │
                   ▼
   gates in a fresh sandbox: build/types/lint/tests → scanners → cross-family reviewer
                   │
                   ▼
   host: fetch commits → merge queue → push / PR with configured GitHub account → Linear status
```

The CLI is `nightshift` (alias `ns`). Without arguments it opens the chat with the lead; with a command it
does the same things directly (`status`, `tasks`, `workers`, `logs`, `diff`, `tests`, `implement`,
`pause`, `resume`, `retry`, `stop`, `send`). Live worker output:

- `ns attach <issue>`: interactive OpenCode TUI on the worker's session
  (`opencode --server … --session …`); you can read and type into it.
- `ns tail <issue>`: read-only stream of the worker's events.
- `ns watch`: a tmux layout over several workers.

All of them work remotely over SSH, since workers and the supervisor run on the host.

## Work units

| Unit | Meaning |
|---|---|
| Initiative | product or topic area, long-lived |
| Project | one feature: design document, milestones, acceptance criteria |
| Milestone | integration checkpoint inside a feature |
| Issue | one coherent change = one worker = one branch, sized to what the worker model reliably solves |
| Blocking relation | the dependency graph; an issue is ready when all blockers are Done |
| Agent steps | commits and Phoenix spans only, never Linear issues |

Issues follow a machine-parsed template (Goal, Why, Design excerpt, Interfaces in/out, Files, Constraints,
Out of scope, Acceptance criteria, Tests expected, Verify). The `Files` section declares the expected touch
set.

Parallel work is allowed only for issues with no blocking edge and disjoint file sets: parallel agents on
one change make conflicting implicit decisions, and multi-agent variants lose badly on sequential tasks.

Merge mode is chosen per feature when implementation starts and recorded on the project:

- `manual`: one PR per issue, stacked on its blockers' branches; you merge each.
- `auto`: one PR per issue, merged when gates and CI pass.
- `feature-branch`: gated commits land on `feature/<name>` through the local merge queue; one PR to main at
  acceptance.

## Supervisor

A small single-process daemon on the host, TypeScript on Bun (official Linear SDK, OpenCode v2 SDK,
OpenTelemetry to Phoenix). It follows Symphony's loop: poll, claim, dispatch with bounded concurrency,
retry with backoff, stall detection, cleanup on terminal state. A restart recovers from Linear and the
filesystem.

- **Event log:** SQLite holds runtime state only (runs, leases, events) and can be discarded; Linear holds
  durable work state.
- **Deterministic watchers:** the OpenCode event stream, diff growth, repeated or missing tool calls,
  wall-clock and token budgets, CI status.
- **Judgment events only** call an LLM (failure classification, worker question, plan divergence,
  acceptance), always as a single call with constrained JSON output.

Failures are classified before any retry, because the class decides the remedy: environment errors retry
unchanged; implementation defects get a bounded repair with the gate output; insufficient context re-runs
the context builder; a task too large or an architectural conflict goes back to the lead; a missing
dependency creates a blocker issue; a capability limit goes to you. Each classified failure is recorded on
the issue and in Phoenix so issue sizing can be tuned from data.

### Package layout

- `index.ts` — public API.
- `runtime/` — composition, loop, and config watching.
- `supervisor/` — orchestration and lifecycle.
- `policy/` — scheduling and decision rules.
- `state/` — persistence, events, and projections.
- `ports/` — shared contracts by concern.
- `stages/` — gates, context, intake, and integration.
- `adapters/` — external service and worker implementations.
- `control/` — socket API and generated protocol types.
- `testing/` — shared test fixtures.

Dependencies follow the layer matrix enforced by `boundaries.test.ts`: runtime composes all layers, supervisor uses policy/state/ports/stages, policy uses ports, state uses ports, ports is self-contained, stages use ports/state/policy, and adapters/control use ports/state, with explicit file-pair exceptions.

## Hosts

nightshift runs on Linux and macOS. The interim host is `towerr-dev` (Ubuntu under WSL2 on the Windows
desktop, amd64); the Mac Studio becomes the host later.

- Everything is the same on both (Bun, Docker, `sbx`, OpenCode v2, rbw, XDG paths, multi-arch images)
  except the service manager behind `ns up` / `ns down` (systemd user unit or launchd agent).
- `ns doctor` checks the host before start (Docker, `sbx`, rbw unlocked, OpenCode major version, gateway
  CA, disk) and prints the fix for each failure.
- Switching hosts needs no migration: Linear holds durable state, SQLite only runtime state.
- Where models are served is independent of the host: the gateway is a config value.

## Stages

The pipeline covers the whole lifecycle. A stage is configuration, not code: name, entry condition, role
(agent and model), outputs written to Linear, gate, and whether a human checkpoint applies. Default
pipeline:

| Stage | Role | Output | Checkpoint |
|---|---|---|---|
| intake | intake agent | clean issue, type, project | no |
| discovery | lead | requirements, answered questions | when ambiguous |
| design | lead | design document with alternatives | approval |
| decomposition | lead | template issues, blocking relations, file sets | plan review |
| implementation | workers | branch and commits | merge mode chosen at start |
| verification | gates and reviewer | gate results, review | on escalation |
| integration | merge queue | merged change | per merge mode |
| acceptance | lead or acceptor | verdict against acceptance criteria | yes |

Projects can add, drop or reorder stages (a `release` stage, or no design stage for bug fixes). Stage
transitions are deterministic; only the stage's role work calls an LLM.

## Lead agent

The lead is the agent you talk to. It owns discovery, design, decomposition, re-planning and acceptance,
and it is also nightshift's chat: it answers questions about the running system and steers it through
nightshift's own commands (reads freely, control commands after your confirmation).

- Runs in a background OpenCode v2 server kept alive by the supervisor, one session per project; `ns` opens
  a TUI client on it, so closing the terminal ends nothing.
- Runs on the host, not in a sandbox: it needs your checkouts, the code-graph index and Linear, and it
  never changes code. Guardrails are OpenCode permissions: file edits denied, shell limited to read-only
  commands, Linear writes through a guard.
- Planning runs as several bounded calls rather than one long session, which keeps contexts focused.
- Skills are plain `SKILL.md` files that OpenCode, Claude Code and Codex all load; only thin wrappers are
  harness-specific.
- nightshift acts in Linear as its own OAuth application (client-credentials grant), so its writes appear
  as "nightshift", with its own rate limit and no seat. Your own and the lead's interactive writes stay
  yours.

## Linear model

Linear's own objects carry the structure instead of comments or labels: initiatives for areas, projects
for features (with documents, milestones, dependencies and health updates), issues for worker units,
`blocks` relations as the dispatch graph, `related` and `duplicate` for cross-links and dedup, comments for
questions and results, attachments for PRs and traces.

**Opt-in.** nightshift reads every team but acts only on issues selected by `linear.act_on`: issues
delegated to its app (`delegated`) and/or issues carrying one of the configured labels (default label
`autopilot`). With both off it runs in manual mode and acts only on issues you hand it with
`ns implement`. Issues with an exclude label are ignored.

**Statuses are the lifecycle.** One mapping of lifecycle states to status names applies to all teams, with
per-team overrides: Backlog (new work, planning, waiting on blockers), Todo (ready), In Progress, In Review,
Blocked (needs you or the lead), Done, Canceled. There is no triage status; new work lands in Backlog, and
a missing `ai-stage` label shows intake is pending. A status outside the mapping (e.g. Duplicate) makes the
issue unmanaged.

**Label groups:**

- `ai-stage` (issue): the pipeline stage owning the issue; written only by the supervisor.
- `ai-merge` (project label group): `manual`, `auto` or `feature-branch`; none means `ns implement` asks.
- `Repo` (issue): plain metadata for projects with several repositories, read as `repo:<name>`.

There is no agent label group: the agent follows from rules over type, stage and failure class. Runtime
sub-states (running, gates, question, failed) are not labels; they live in the supervisor's state and in
marker comments. Your own label groups (Type, Component, …) are read and left untouched.

Only the supervisor writes status and `ai-stage`; workers have no Linear access. Human checkpoints appear
as Blocked with the question as a comment that mentions you; your reply is routed back.

## Context

One stack, no overlapping tools:

- **Search:** ripgrep and ast-grep, plus a code graph for structure (callers, impact, outlines). The graph
  saves tokens but does not replace grep. Indexes are built per repository on the host from a `git archive`
  export of the base branch, kept under `~/.cache/nightshift/index/`, and mounted read-only into sandboxes.
- **Output compression:** rtk.
- **No embeddings** until traces show localization misses.

The **context builder** assembles a package per dispatch: issue goal and acceptance criteria, the matching
design section, relevant decisions, blocker outputs, outlines plus full source for files to edit and one
hop of neighbours, matching lessons, verify commands; budgeted per section to roughly 16–48k tokens.
Workers get the package rather than free exploration of the repository.

**Knowledge placement:**

- Feature design and decisions: Linear documents. Task spec: the Linear issue.
- Conventions: a short, human-written `AGENTS.md` in the repository (generated ones reduce success).
  Nothing AI-specific is written into application repositories.
- Architecture notes, pitfalls, lessons: a knowledge vault in Karpathy's LLM-wiki pattern (own git
  repository, markdown with `repo`/`paths`/`status` frontmatter, pinned `obsidian-wiki` skills). Ingest at
  feature closeout as staged writes you review; pages selected deterministically by repository and path.

## Tools per role

CLI or MCP is decided per tool. The deciding factor is where the credential and the network egress live:

- **CLI plus `SKILL.md`** for tools on the host where the credential is already present or harmless, and
  where output benefits from piping.
- **MCP through the LiteLLM gateway** for calls from inside a sandbox (egress is gateway-only) or when the
  credential must not enter a VM; each server exposes few tools.

Roles:

- **Lead (host):** Linear, `gh`, code-graph, docs, search and Phoenix CLIs; planning skills.
- **Workers (sandbox):** git on their private clone, code-graph CLI on the read-only index, rtk, stack
  tools; docs and web search only through the gateway. No Linear, no GitHub.
- **Single-call agents:** no tools, structured output; the supervisor writes the results.
- **Supervisor:** Linear SDK, `gh`, OpenTelemetry.

## Verification

Each step runs only if the previous one passed:

1. Repository checks (build, types, lint, tests, including tests the issue demands); authoritative.
2. Deterministic scanners (semgrep, dependency audit, secret scan); an LLM only triages their findings.
3. One reviewer from a different model family than the worker, fresh context, short checklist; findings
   are advisory unless a test or tool reproduces them.
4. Feature acceptance against the project's acceptance criteria on the integrated result, then you.

Gates run in a fresh sandbox from the same image on the fetched commit, so a worker cannot influence its
own results. There are no always-on security or architecture LLM reviewers: nothing shows they improve
outcomes.

## Isolation and workspaces

- **Runtime:** a `SandboxDriver` interface (create, exec, attach, logs, destroy). Plain Docker is the
  driver today and stays as the trusted and evaluation backend; Docker Sandboxes (`sbx`: microVM per
  sandbox, own kernel and Docker engine, deny-by-default egress) is the isolation runtime.
- **Not boundaries:** worktrees and seatbelt-style sandboxes; usable only as a second layer inside the VM.
- **Workspace:** repositories stay in your checkouts; the supervisor only runs `git fetch` there. A sandbox
  mounts only the repository's `.git`, read-only, and makes its working copy inside with
  `git clone --shared` at `origin/<base>`. The working tree (which can hold untracked secrets) is never
  mounted, and nothing writes into your `.git`.
- **Credentials:** none inside sandboxes, except a per-worker LiteLLM virtual key. The host fetches the
  worker's commits, pushes and opens PRs with the GitHub account the config names: `github.default`,
  overridable per repository via `repositories.<name>.github` (e.g. the agent account for own repositories,
  your personal account for upstream contributions). An `octo_sts` account gets short-lived tokens per
  repository owner: nightshift exchanges its Authentik client credentials at octo-sts and passes the token
  to one `git` or `gh` invocation through the environment, never a long-lived PAT or your `gh` login.
- **Never inside:** Linear credentials, the gateway master key, `~/.ssh`, `~/.kube`, `SSH_AUTH_SOCK`, the
  host Docker socket, other repositories, the knowledge vault (only selected pages travel in the context
  package), supervisor state.
- **Egress:** the gateway hostname only; traces go through the gateway host on a path prefix. The plain Docker driver cannot enforce this; until `sbx` runs workers and gates, their egress is open.

## Stacks

Images are layered and multi-arch:

1. **Environment layer:** the repository's own `.devcontainer/` if it has one, otherwise a definition kept
   in this repository; toolchains and project dependencies with warm caches.
2. **Agent layer**, shared by all repositories: pinned OpenCode v2, rtk, git, search tools, code-graph
   binary, scanners, OTel and CA config; no credentials and nothing tied to a person.

A **stack** is a Dev Container Feature in `features/stack-<name>/` that depends on the official toolchain
Feature and adds the agent's extras (language server, formatter, linter, test tools), plus a `stack.yaml`
with marker files, version files, OpenCode `lsp` entries and default check commands. Stacks are detected
from marker files (several per repository), installed at build time because the sandbox egress policy
blocks self-downloading language servers, published to GHCR and pinned by digest. Repositories that need
macOS (Swift, iOS targets) stay outside the automated pipeline for now. The `wow` stack bundles WoW API
annotations and offline checks; its in-game steps run on the host and its acceptance is always manual.

## Inference

- All model calls go through the LiteLLM gateway in h-cloud: one place for model routing, per-worker
  virtual keys, budgets and spend logs. Every run sends its run id as the session id for cost attribution.
- Local models will be served on the Mac Studio (oMLX behind LiteLLM); until then, and as an alternative
  afterwards, profiles point at other models behind the same gateway.
- A gateway outage is an environment failure: the supervisor pauses dispatch instead of failing runs.
- Prefill dominates local latency, so system prompts stay stable for prefix-cache hits and worker contexts
  stay small.
- Concurrency is bounded by memory and throughput (expected 3–4 workers on the Mac Studio, not more).

## Model profiles

Agents reference role aliases only (`ns/lead`, `ns/worker`, `ns/reviewer`, `ns/classifier`). A profile is
a named role-to-model mapping in config, overridable per repository and stage; `ns profile use <name>`
switches it for new dispatches without a restart. At dispatch the alias resolves to a concrete model,
recorded on the issue and in Phoenix, and a running worker keeps its model (`ns retry <issue> --profile
<name>` re-runs on another). Switching checks memory fit and that the reviewer family differs from the
worker family. The profile name is a Phoenix tag, so profiles compare as experiments.

## Agents: authoring and improvement

Every LLM call is a defined agent; the supervisor contains no prompts. Agents are OpenCode-native files in
this repository (`agents/<name>.md`: frontmatter with role alias, permissions, tools, output schema; body
as system prompt) plus skills, rendered into each harness's config. No agent framework.

| Agent | Runs as | Used for |
|---|---|---|
| `lead` | interactive OpenCode on the host | planning, steering, acceptance |
| `intake` | single call | cleaning and routing new issues |
| `explorer` | read-only worker | investigations, context retries |
| `implementer` | worker | features and improvements |
| `fixer` | worker, reproduce first | bugs |
| `refactorer` | worker, behaviour-preserving | refactors |
| `migrator` | worker, reversible | migrations and dependency upgrades |
| `repairer` | worker | repair after failed gates |
| `reviewer`, `classifier`, `context-selector`, `replanner`, `acceptor` | single calls | review, failure class, context, re-plan, acceptance |
| `ingester` | worker on the vault | knowledge ingest |

Selection is a deterministic rule table (issue type, stage, failure class); no LLM routes.

Prompt rules: permissions enforce limits rather than prose; short prompts sized for local models (no
personas, no repository overviews); inputs fenced; a fixed anatomy (function, hard rules, inputs,
procedure, escalation, output contract). Every worker and single-call agent ends with a schema-validated
finish call (`DONE`, `DONE_WITH_CONCERNS`, `BLOCKED`, `NEEDS_CONTEXT` plus evidence); a missing finish is a
failure. Workers never spawn sub-workers.

**Improvement:** optimizers only edit these text files, and every change arrives as a reviewed PR with the
prompt diff, per-task scores and the experiment link; nothing rewrites itself in production. GEPA tunes
worker prompts and skills through the evaluation harness; DSPy optimizes the single-call roles; the lead's
playbook grows by human-curated deltas. Repetitive calls are not distilled into small models until enough
outcome-labelled data exists; every span is tagged now so that remains possible.

## Evaluation harness

Tasks are mined from merged PRs in your repositories (statement from the issue, hidden tests from the PR's
test diff, base at the parent commit), plus synthetic mutations for volume and reviewer bug sets. Harbor
runs them on the worker images with its OpenCode adapter; hidden tests score first, then checks, tokens,
cost and time, all recorded as Phoenix experiments tagged with model, role, prompt hash and task size.
Reviewer, classifier and planner are scored on known-bug diffs, labelled failures and downstream execution
success. Comparisons are paired on the same tasks over several seeds, with a held-out set never used for
optimization; success against task size sets issue sizing.

## Policies

- **Risk paths:** each repository lists high-risk globs (CI, infrastructure, migrations, auth, secrets);
  touching one forces manual merge and your review regardless of merge mode. Destructive commands are
  denied in sandboxes.
- **Cross-repository features:** a project may span repositories; each issue belongs to exactly one
  (`Repo` label); contracts live in the design document; ordering via `blocks`; no shared branch.
- **Notifications:** questions reach you as Linear comments that mention you, plus a desktop
  notification.
- **Limits:** wall-clock and token budgets per run, bounded concurrency, bounded repair rounds; all
  config.
- **Prompt injection:** issue text, search results, PR comments and vault pages are data, never
  instructions; tool allowlists, missing credentials and the egress allowlist bound the damage.
- **Attribution:** no AI attribution in commits, PRs, issues or comments.
- **Out of scope:** non-development work in Linear, debating or peer-to-peer agents, several agents on one
  change, a second task database, a web dashboard, Kubernetes or remote workers.

## Development

Planning lives in Linear: team Forge (`XXX`), project
[Nightshift](https://linear.app/h-cloud/project/nightshift-0ebbeafb3b60). Work packages, spike results,
detailed specs and open decisions are issues there.

Repository layout:

```
packages/core/         config schema, Linear model, stack detection, shared types
packages/supervisor/   dispatcher, Linear sync, event log, gates, merge queue
packages/cli/          `nightshift` / `ns`
agents/                agent files (<name>.md)
features/              Dev Container Features: agent layer, stack-<name>
eval/                  task miner, Harbor glue, optimizer adapters (Python)
config/                default and example configuration, profiles, environments
```
