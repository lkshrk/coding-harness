---
name: replan
description: "Handle an issue the supervisor escalated with class `task_too_large`, `missing_dependency` or `architectural_conflict`: split it into child issues, add the missing blocker, or take a design change to the user. Plans are checked mechanically and written only after the user approves. Use when `status` or a notification shows such an escalation. Not for retrying an implementation defect (`ns retry`), first-time decomposition (`decompose`) or new feature design (`design`)."
license: MIT
---

# Replan

An escalated issue failed for a reason another attempt will not fix: the work is too big, something it needs does not exist yet, or the design does not fit the code. Change the plan, not the code.

## Read the escalation

- `ns logs <issue>` and `linear issue comment list <ID>`: the failure comment names the class (`Attempt <n> (<agent>) failed: <reason>. Class \`<class>\`, action \`<action>\`.`) and the evidence.
- `linear issue view <ID>`: the description, especially `## Files`, `## Design excerpt` and `## Acceptance criteria`.
- `ns diff <issue> --stat` and `ns tests <issue>`: what the worker got done and where it stopped.
- The parent issue's approved design comment (the newest one), when the issue has a parent.
- If the comments do not support the class, say so and stop: a misclassified failure goes back to `status`, not through a replan.

## task_too_large

- Split into child issues of the escalated issue, using the `decompose` skill's template and check: one file per issue under `/tmp/<ID>-replan/`, `plan.json`, then `<skills>/decompose/scripts/plan-check.sh /tmp/<ID>-replan/plan.json`.
- Keep what the worker finished: when its branch holds usable work, the first child continues from it and says so in `## Context`.
- Each child gets its share of the original `## Files` and acceptance criteria; together they cover all of them. Nothing new joins the scope.
- Every child `blocks` the original, so the original waits until its children are done and then only checks the whole.

## missing_dependency

- Name the dependency precisely: the interface, module, migration or upstream change the worker lacked, with the evidence line.
- Search for an existing issue first (`linear issue query --search "<text>"`); if one covers it, propose only the relation.
- Otherwise draft one blocker issue in the template (same project and milestone, `--parent` of the original's parent if it has one) and check it with `ns issue check /tmp/<ID>-blocker.md`.
- Relation: `<blocker> blocks <ID>`.

## architectural_conflict

- Show the user the conflict in a few lines: what the design says, what the code does, the evidence.
- Offer two or three ways out (change the design, change the issue's scope, drop the issue), recommended first, with the trade-off of each.
- After the user chooses a design change: draft a new design comment for the parent issue saying what changed and why, show it, and post it only after an explicit yes. Update the vault decision page in the same step.
- Then adjust the affected issues' descriptions (`## Design excerpt`, `## Files`, acceptance criteria) and check each with `ns issue check`.

## Approval and writing

- Show the whole change before writing: new issues as a table (key, title, estimate, blocks, files), relations, changed descriptions as diffs, and the checker output.
- Ask: "Apply this replan to <ID>?" and wait for an explicit yes.
- Write as the user with the `linear` skill's command forms: issues blockers first, then relations, then read them back with `linear issue relation list`.
- Post a comment on the escalated issue: the class, what changed, and the new issues in order.
- Never change status or `ai-*` labels, and never run `ns retry` or `ns implement` yourself. Tell the user which command continues the work: `ns implement <child>` for new issues, `ns retry <ID>` after a scope change.

## Done

- The escalated issue can no longer fail for the same reason: it is split, blocked by the missing work, or its design and scope match the code.
- Every new or changed issue passes `ns issue check <ID>`; relations read back as planned.
