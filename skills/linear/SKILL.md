---
name: linear
description: Read and write Linear issues, projects, documents, milestones and relations with the `linear` CLI (schpet/linear-cli), in the exact command forms `linear-guard` accepts. Use when looking up issues or design Documents, or when writing approved issues, comments, relations, projects or documents. Not for issue status or `ai-stage:` labels (the supervisor owns them), not for raw GraphQL (`linear api`), and not for deleting anything.
license: MIT
compatibility: "@schpet/linear-cli 2.6.0 (subcommands and flags verified on that version); jq for JSON filtering. Authenticates with the user's own API key from `linear auth`."
---

# Linear

The `linear` CLI acts as the user: every write shows up under their name. Read freely; write only after the user approved the exact content.

## Read

Prefer `--json | jq` where the command supports it; keep `--limit` small (Linear bills complexity by requested page size).

| Question | Command |
| --- | --- |
| One issue with comments | `linear issue view ABC-12 --json \| jq '{identifier, title, state: .state.name, labels: [.labels.nodes[].name], description}'` |
| Search issues | `linear issue query --search "<text>" --limit 20 --json \| jq -r '.[] \| "\(.identifier) \(.title)"'` |
| Issues of a project | `linear issue query --project "<name>" --all-states --limit 50 --json` |
| Issues by label or state | `linear issue query --team ABC --label "<label>" --state started --json` |
| Comments | `linear issue comment list ABC-12 --json` |
| Relations | `linear issue relation list ABC-12` |
| Projects | `linear project list --team ABC --json \| jq -r '.[] \| "\(.slugId) \(.name) \(.status.name)"'` |
| One project | `linear project view <projectId>` |
| Milestones | `linear milestone list --project "<name>"`; `linear milestone view "<name>" --project "<name>"` |
| Documents | `linear document list --project "<name>" --json`; `linear document view <id> --raw` |
| Teams, states, labels | `linear team list`; `linear team states ABC --json`; `linear label list --team ABC --json` |

JSON shapes differ between commands and versions: inspect once with `| jq 'keys'` (or `.[0] | keys`) before writing a filter.

## Write

Only these forms. Markdown always goes through a file, never inline: write it under `/tmp`, show it to the user, then run the command. `linear-guard` rejects any other form and names the cause; fix that cause instead of rephrasing.

```sh
# issue: description from a file, never --description
linear issue create --no-interactive --team ABC --project "<project>" \
  --title "<title>" --description-file /tmp/ABC-new.md \
  [--milestone "<milestone>"] [--estimate 3] [--priority 3] [--label "<own label>"] [--parent ABC-10]
linear issue update ABC-12 --description-file /tmp/ABC-12.md [--title "<title>"] [--estimate 3] [--milestone "<milestone>"]

# comment
linear issue comment add ABC-12 --body-file /tmp/ABC-12-comment.md

# relation: <issue> blocks|blocked-by|related|duplicate <other>
linear issue relation add ABC-12 blocks ABC-13

# project: description is at most 255 characters; the overview goes in --content-file
linear project create --team ABC --name "<name>" --description "<one line>" --content-file /tmp/project.md --json
linear project update <projectId> --description "<one line>" [--target-date YYYY-MM-DD]

# document (the design Document lives on the project)
linear document create --title "<title>" --project "<project>" --content-file /tmp/design.md
linear document update <documentId> --content-file /tmp/design.md
```

Check the result after each write with the matching read command.

## Rules

- Never pass `--state`, `-s`, `--start`, `--assignee`, `--add-label`/`--remove-label`/`--label` with an `ai-*` label, or `ai-merge:` on a project: status, `ai-stage:` and merge mode belong to the supervisor and `ns implement`.
- `issue update --label` replaces the whole label set; do not use it.
- Never run `delete`, `linear api`, `linear auth`, `issue start`, `issue pull-request` or `--interactive`.
- One write per approved change; batch creation runs in dependency order (blockers first), relations after both issues exist.
- Description files follow the issue template in the `decompose` skill.
