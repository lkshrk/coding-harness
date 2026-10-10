---
name: intake
description: "Triage new captures and findings with the user in a session: accept, mark as duplicate, ask for missing information, or propose declining, and group related findings. Issues leave intake template-ready or with a precise question. Use when new issues sit in Backlog without an `ai-stage:` label or the user asks to go through captures. Not for designing (`design`) or splitting approved work (`decompose`); the supervisor's automatic intake runs the single-call `intake` agent instead."
license: MIT
---

# Intake

Go through new issues one at a time, decide what each needs, and write only what the user approves. Withhold "ready" when unsure: an issue a worker cannot start without asking is not ready.

## Find

- New issues: `linear issue query --team <TEAM> --state backlog --limit 50 --json`, keeping those without an `ai-stage:` label (`jq` on `.labels.nodes[].name`).
- Oldest first, unless the user names an area or issue.
- For each: `linear issue view <ID>` and `linear issue comment list <ID>`.

## Decide

For each issue pick one, with a single line of reasons:

| Decision | When | Write |
|---|---|---|
| accept | a worker could start: expected behaviour, a way to see the problem or the goal, and a scope | rewrite the description in the template (`decompose` skill) when it is not already, then `ns issue check` |
| duplicate | an open or recently closed issue asks for the same outcome | `linear issue relation add <ID> duplicate <original>` and a comment naming the original |
| needs info | a person would have to ask before starting | a comment with one numbered question per missing fact |
| propose decline | outside every project's purpose, or already answered by the code | a comment with the reason; the user decides, nothing is cancelled |

- Duplicates: search before deciding (`linear issue query --search "<key words>" --all-states --limit 20`). Related but different work is not a duplicate; note it for grouping.
- Check the code before accepting a bug: `rg`, `git log`, the `code-graph` skill. A bug already fixed on `main` is a decline proposal with the commit.
- Acceptance criteria must be observable by someone who did not write them. If you cannot write them from the report, the decision is needs info.
- Type and project come from the report and the code. When the project is unclear, ask the user rather than guess.

## Fast path

A bug with a deterministic reproduction and a single-file scope needs no design: write the template description with the reproduction in `## Context`, the file in `## Files`, the failing case in `## Tests expected`, and propose it for `ns implement` after approval.

## Group

- Findings about the same area go under one parent issue: propose the parent (existing or new) and the `--parent` moves.
- Three or more findings that together form a feature are a project proposal: name, one-line purpose, the issues it would hold. The user decides; the feature then starts in `discover`.

## Approval and writing

- Show the user the batch: per issue the decision, the reason and the exact text or relation to write. Ask: "Apply these intake decisions?" and wait for an explicit yes; the user may approve a subset.
- Write as the user with the `linear` skill's command forms, one write per approved change; description and comment text through files under `/tmp`.
- Read each write back (`linear issue view`, `linear issue relation list`).
- Never set status, `ai-*` labels or priority beyond what the user approved, and never cancel or delete an issue.

## Done

- Every reviewed issue has an approved decision written, or the user deferred it.
- Accepted issues pass `ns issue check <ID>`; needs-info issues carry the questions; duplicates carry the relation.
- Tell the user which accepted issues are ready for `ns implement` and which wait for `discover` or `design`.
