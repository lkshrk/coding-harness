---
name: design
description: "Design how to build an approved feature: investigate the code, write at least two alternatives, critique them and record a decision as docs/designs/<ID>.md in the repository, opened as a pull request the user approves by merging. Use when a feature issue has approved requirements and sits in the design stage. Not for gathering requirements (`discover`), creating issues (`decompose`) or small changes that need no alternatives."
license: MIT
---

# Design

Decide how to build the feature, with the reasoning visible. The design is a file in the feature's repository, `docs/designs/<ID>.md`, using the headings in `design-template.md`. It reaches the repository only as a pull request, and merging that pull request is the user's approval.

## Prerequisites

- The feature's parent issue has an approved `## Requirements` section. If not, stop and run `discover` first.
- Read the requirements, the issue comments and the vault pages for this repository before investigating.
- One repository owns the design. For a feature spanning several, ask the user which one.

## Investigate

- Map what exists: the modules, data and interfaces the feature touches. Use the `code-graph` skill for outlines and callers before reading whole files; `rg` for strings and config.
- Note constraints the code imposes: existing patterns to follow, boundaries (for coding-harness: `boundaries.test.ts`), tests that pin behaviour.
- Record each finding with a file path, so `decompose` and workers can follow it.
- Check the vault's `pitfalls/` and `decisions/` for this area; a recorded decision is a constraint unless the user reopens it.
- A question only the user can answer: ask it, one at a time, before writing alternatives.

## Alternatives

- Write at least two genuinely different approaches, not one approach and a straw man.
- For each: how it works, what it changes (files and interfaces), cost (size, risk, migration), and what it makes easier or harder later.
- If only one approach is reasonable, say why the obvious other one fails, in its own entry.

## Critique

- Attack each alternative against the requirements and constraints: which acceptance criterion it struggles with, what breaks under failure, what a reviewer would reject.
- Be as hard on the alternative you prefer as on the others.

## Decision

- Pick one, or a synthesis of several, and say why in terms of the critique.
- Name what was rejected and why, so it is not re-proposed.
- List the interfaces between the parts: names, shapes and owners. `decompose` splits along them.
- List the risks that remain and how a worker or a check will catch them.

## Publishing and approval

- Draft the full design in `/tmp/<ID>-design.md` and show it to the user.
- After an explicit yes, publish it; never edit the repository any other way:
  `<skills>/design/scripts/publish.sh ~/Dev/<repo> <ID> /tmp/<ID>-design.md`
  It commits only `docs/designs/<ID>.md` on branch `design/<ID>` from a private worktree (the user's checkout is not touched) and prints the pull request URL.
- Comment on the parent issue with the pull request link (`linear issue comment add <ID> --body-file …`). The supervisor holds the issue at the design checkpoint; do not move its status.
- Review feedback: revise the draft and run `publish.sh` again; it adds a commit to the same pull request.
- The design is approved when the pull request is merged. A decision that should outlive the feature also goes to the vault as a decision page.

## Done

- `docs/designs/<ID>.md` is merged, and the parent issue links to it.
- Tell the user the next step is `decompose`, and stop.
