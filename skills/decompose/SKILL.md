---
name: decompose
description: "Turn an approved design into child issues of the feature: template-valid descriptions, `blocks` relations, file sets, estimates and a milestone, checked mechanically and written only after the user approves the plan. Use when a feature's design comment is approved and the issue sits in the decomposition stage. Not for designing (`design`), re-planning a failed issue (`replan`) or single small fixes that need no split."
license: MIT
---

# Decompose

Turn the approved design into work the supervisor can dispatch. Each issue is one coherent change for one worker on one branch. The plan is checked by `scripts/plan-check.sh` and shown in full before anything is written.

## Prerequisites

- The feature's parent issue has an approved design comment, and the decision is in the vault. If not, stop and run `design` first.
- Read the design's `Decision` (implementation order, remaining risks) and `Interfaces`; they are the split.

## Split

- Start from the design's implementation order; each step is a candidate issue.
- Split further when a step is more than one worker can finish in one run: separate interfaces, then their callers; one module at a time for mechanical moves.
- Merge steps that only make sense together (a function and its only caller, a test and the change it pins).
- Each issue lists every path it is expected to touch in `## Files`. Two issues without a `blocks` path between them must not touch the same files, or the supervisor runs them one after the other.
- An issue that consumes another's interface is blocked by it (`blocks` edge from provider to consumer).

## Write each issue

- One file per issue under `/tmp/<feature ID>-plan/`, following `issue-template.md` (the eleven sections in order).
- `## Design excerpt` links the approved design comment and copies verbatim the paragraphs and interface rows this issue needs. Workers see only the excerpt.
- `## Acceptance criteria` are observable and come from the requirements and the design's risks; `## Verify` has the exact commands.
- Estimate in points (1, 2, 3, 5, 8). Anything above 5 is a sign to split.

## Check

- Write `/tmp/<feature ID>-plan/plan.json`:
  ```json
  { "issues": [ { "key": "1", "title": "…", "description": "1.md", "estimate": 3, "blocks": ["2"] } ] }
  ```
  Keys are local; Linear identifiers come later.
- Run `<skills>/decompose/scripts/plan-check.sh /tmp/<feature ID>-plan/plan.json`. It runs the issue validator on every description and reports missing estimates, unknown or cyclic `blocks`, and overlapping files without a `blocks` path.
- Fix every error. A warning is acceptable only if the user agrees the two issues may run one after the other.

## Approval and writing

- Show the user the plan: a table of key, title, estimate, blocks, files, then the checker output. Ask: "Create these <n> issues under <feature ID>?" and wait for an explicit yes.
- Create as the user, blockers first, each as a child of the feature (`--parent <feature ID>`), in the feature's project and milestone; `--estimate` from the plan. Never set status or `ai-*` labels.
- After all issues exist, add the relations (`linear issue relation add <A> blocks <B>`), then read them back with `linear issue relation list`.
- Comment on the feature with the created issues and their order.

## Done

- Every child issue passes `ns issue check <ID>`, has an estimate and its relations.
- Tell the user the plan is ready for `ns implement`, which covers the issues and asks for merge mode and profile. Do not run it yourself.
- Until XXX-291 ships, a child left in Backlog starts the parent's pipeline at `intake` and stops in `discovery`; tell the user to move each child to Todo before `ns implement`.
