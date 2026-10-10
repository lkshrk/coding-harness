---
name: design
description: "Design how to build an approved feature: investigate the code, write at least two alternatives, critique them and record a decision as a design comment on the feature's parent issue, then stop for the user's approval and save the decision to the vault. Use when a feature issue has approved requirements and sits in the design stage. Not for gathering requirements (`discover`), creating issues (`decompose`) or small changes that need no alternatives."
license: MIT
---

# Design

Decide how to build the feature, with the reasoning visible. The working design is a comment on the feature's parent issue, using the headings in `design-template.md`; it lives and closes with the ticket. Only the decision outlives it, as a vault page. Only the user approves a design.

## Prerequisites

- The feature's parent issue has an approved requirements comment (the newest one counts). If not, stop and run `discover` first.
- Read the requirements comment, the other issue comments and the vault pages for this repository before investigating.

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
- List the risks that remain and how a worker or a check will catch them, and the implementation order `decompose` should follow.

## Posting and approval

- Draft the full design in `/tmp/<ID>-design.md` and show it to the user.
- After an explicit yes, post it as the user: `linear issue comment add <ID> --body-file /tmp/<ID>-design.md`. Never with a Nightshift app login.
- The supervisor holds the issue at the design checkpoint; do not move its status.
- Review feedback: revise and post the full design again as a new comment that starts with what changed. The newest design comment is the current one.
- The design is approved when the user says so in a comment or in the session. Then write the decision (chosen, rejected and why, remaining risks) to the vault as a decision page for the repository and link it in a comment.

## Done

- The parent issue has an approved design comment, and the vault has the decision page.
- Tell the user the next step is `decompose`, and stop.
