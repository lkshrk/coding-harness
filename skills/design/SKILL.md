---
name: design
description: "Design how to build an approved feature: investigate the code, write at least two alternatives, critique them and synthesise a decision into the feature's parent issue, then stop for the user's approval. Use when a feature issue has approved requirements and sits in the design stage. Not for gathering requirements (`discover`), creating issues (`decompose`) or small changes that need no alternatives."
license: MIT
---

# Design

Decide how to build the feature, with the reasoning visible. The output extends the parent issue's description below `## Requirements`, using the headings in `design-template.md`. Only the user approves a design.

## Prerequisites

- The parent issue has an approved `## Requirements` section. If not, stop and run `discover` first.
- Read the requirements, the issue comments and the vault pages for this repository before investigating.

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

## Writing and approval

- Draft the full design (template headings) in `/tmp/<ID>-design.md` and show it to the user.
- Ask: "Write this design into <ID>?" and wait for an explicit yes.
- Write with `linear issue update <ID> --description-file …`, keeping `## Requirements` above it unchanged.
- The supervisor holds the issue for the user at the design checkpoint; do not move its status.
- Changes after approval: show the changed lines, get approval, and add a comment naming what changed and why. A decision change also goes to the vault as a decision page.

## Done

- The parent issue holds requirements and an approved design under the template headings.
- Tell the user the next step is `decompose`, and stop.
